// Unit tests for MCP middleware functionality
// Tests idempotency, audit logging, and error handling

import { describe, it, expect, beforeEach, vi } from "vitest";
import { 
  idempotencyMiddleware, 
  auditLogMiddleware, 
  errorHandlerMiddleware 
} from "../middleware/index.js";
import { ToolDefinition, ToolContext, ToolResult } from "../schema/tool-definition.js";
import { DomainError } from "@besterp/shared";

// Mock Prisma client for testing
const mockPrisma = {
  idempotencyRecord: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  aiActionLog: {
    create: vi.fn(),
  },
};

const mockDefinition: ToolDefinition = {
  name: "test_tool",
  description: "A test tool",
  inputSchema: {
    type: "object",
    properties: {
      test: { type: "string" },
    },
    required: ["test"],
  },
  riskLevel: "low",
  entity: "test",
  tags: ["test"],
  handler: async (input: any) => ({ success: true, data: input }),
};

const mockContext: ToolContext = {
  tenantId: "test-tenant",
  userId: "test-user",
  agentId: "test-agent",
  conversationId: "test-conversation",
  services: {
    prisma: mockPrisma,
  },
};

describe("Idempotency Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create idempotency record on first execution", async () => {
    const input = { test: "value" };
    const inputHash = "sha256:abc123";
    const idempotencyKey = "test-key";
    
    const contextWithKey = { ...mockContext, idempotencyKey };
    
    mockPrisma.idempotencyRecord.upsert.mockResolvedValue({
      idempotencyKey,
      toolName: "test_tool",
      tenantId: "test-tenant",
      userId: "test-user",
      agentId: "test-agent",
      conversationId: "test-conversation",
      status: "completed",
      inputHash,
      result: { success: true, data: "stored result" },
    });

    const wrappedHandler = idempotencyMiddleware(mockPrisma);
    const result = await wrappedHandler(input, contextWithKey, mockDefinition, mockDefinition.handler);

    expect(mockPrisma.idempotencyRecord.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey },
      create: expect.objectContaining({
        idempotencyKey,
        toolName: "test_tool",
        tenantId: "test-tenant",
        status: "pending",
        inputHash,
      }),
      update: {},
    });
    expect(result.success).toBe(true);
  });

  it("should return existing result for duplicate input", async () => {
    const input = { test: "value" };
    const inputHash = "sha256:abc123";
    const idempotencyKey = "test-key";
    
    const contextWithKey = { ...mockContext, idempotencyKey };
    
    mockPrisma.idempotencyRecord.upsert.mockResolvedValue({
      idempotencyKey,
      toolName: "test_tool",
      tenantId: "test-tenant",
      status: "completed",
      inputHash,
      result: { success: true, data: "existing result" },
    });

    const wrappedHandler = idempotencyMiddleware(mockPrisma);
    const result = await wrappedHandler(input, contextWithKey, mockDefinition, mockDefinition.handler);

    expect(result.success).toBe(true);
    expect(result.data).toBe("existing result");
  });

  it("should reject input hash mismatch", async () => {
    const input = { test: "different value" };
    const inputHash = "sha256:different";
    const idempotencyKey = "test-key";
    
    const contextWithKey = { ...mockContext, idempotencyKey };
    
    mockPrisma.idempotencyRecord.upsert.mockResolvedValue({
      idempotencyKey,
      toolName: "test_tool",
      tenantId: "test-tenant",
      status: "completed",
      inputHash: "sha256:original",
      result: { success: true },
    });

    const wrappedHandler = idempotencyMiddleware(mockPrisma);
    const result = await wrappedHandler(input, contextWithKey, mockDefinition, mockDefinition.handler);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("should pass through when no idempotency key", async () => {
    const input = { test: "value" };
    
    const wrappedHandler = idempotencyMiddleware(mockPrisma);
    const result = await wrappedHandler(input, mockContext, mockDefinition, mockDefinition.handler);

    expect(mockPrisma.idempotencyRecord.upsert).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

describe("Audit Log Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should log tool execution", async () => {
    const input = { test: "value" };
    const result = { success: true, data: "test result" };
    
    mockPrisma.aiActionLog.create.mockResolvedValue({
      id: "log-id",
      agentId: "test-agent",
      conversationId: "test-conversation",
      userId: "test-user",
      tenantId: "test-tenant",
      toolCalled: "test_tool",
      toolInput: input,
      toolOutput: result,
    });

    const wrappedHandler = auditLogMiddleware(mockDefinition.handler, mockDefinition);
    const executionResult = await wrappedHandler(input, mockContext);

    expect(mockPrisma.aiActionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: "test-agent",
        conversationId: "test-conversation",
        userId: "test-user",
        tenantId: "test-tenant",
        toolCalled: "test_tool",
        toolInput: input,
        toolOutput: result,
      }),
    });
    expect(executionResult).toEqual(result);
  });

  it("should log tool execution even when handler throws", async () => {
    const input = { test: "value" };
    const error = new Error("Test error");
    
    mockPrisma.aiActionLog.create.mockResolvedValue({
      id: "log-id",
      agentId: "test-agent",
      conversationId: "test-conversation",
      userId: "test-user",
      tenantId: "test-tenant",
      toolCalled: "test_tool",
      toolInput: input,
      toolOutput: null,
      error: error.message,
    });

    const wrappedHandler = auditLogMiddleware(
      () => Promise.reject(error), 
      mockDefinition
    );

    await expect(wrappedHandler(input, mockContext)).rejects.toThrow(error);
    expect(mockPrisma.aiActionLog.create).toHaveBeenCalled();
  });
});

describe("Error Handler Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should format domain errors correctly", async () => {
    const domainError = new DomainError(
      "TEST_ERROR", 
      "Test error message",
      { suggestedTools: ["test_tool"] }
    );
    
    const wrappedHandler = errorHandlerMiddleware(
      () => Promise.reject(domainError),
      mockDefinition
    );

    const result = await wrappedHandler({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TEST_ERROR");
    expect(result.error?.message).toBe("Test error message");
    expect(result.error?.suggestedTools).toEqual(["test_tool"]);
  });

  it("should handle Prisma unique constraint violations", async () => {
    const prismaError = {
      code: "P2002",
      message: "Unique constraint violation",
    };
    
    const wrappedHandler = errorHandlerMiddleware(
      () => Promise.reject(prismaError),
      mockDefinition
    );

    const result = await wrappedHandler({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    expect(result.error?.suggestedTools).toEqual(["search_test", "test_tool"]);
  });

  it("should handle Prisma not found errors", async () => {
    const prismaError = {
      code: "P2025",
      message: "Record not found",
    };
    
    const wrappedHandler = errorHandlerMiddleware(
      () => Promise.reject(prismaError),
      mockDefinition
    );

    const result = await wrappedHandler({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
    expect(result.error?.suggestedTools).toEqual(["search_test", "get_test"]);
  });

  it("should handle generic errors with fallback", async () => {
    const genericError = new Error("Unexpected error");
    
    const wrappedHandler = errorHandlerMiddleware(
      () => Promise.reject(genericError),
      mockDefinition
    );

    const result = await wrappedHandler({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.error?.message).toContain("test_tool");
  });

  it("should return success handler result unchanged", async () => {
    const successResult = { success: true, data: "test" };
    
    const wrappedHandler = errorHandlerMiddleware(
      () => Promise.resolve(successResult),
      mockDefinition
    );

    const result = await wrappedHandler({}, mockContext);

    expect(result).toEqual(successResult);
  });
});