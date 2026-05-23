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

/** Helper: create a next function that returns a known result. */
function successNext(result?: ToolResult): (input: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async () => result ?? { success: true, data: "ok" };
}

/** Helper: create a next function that throws. */
function throwingNext(error: unknown): (input: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async () => { throw error; };
}

describe("Idempotency Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create idempotency record on first execution", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // No existing record found — first execution
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "created" }));

    expect(mockPrisma.idempotencyRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey,
          toolName: "test_tool",
          tenantId: "test-tenant",
          status: "pending",
        }),
      })
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe("created");
  });

  it("should return existing result for completed record with matching hash", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // Compute the actual hash so it matches what the middleware generates
    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
      idempotencyKey,
      status: "completed",
      inputHash, // exact hash match
      result: { success: true, data: "existing result" },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: true, data: "existing result" });
    expect(result.replayed).toBe(true);
  });

  it("should reject input hash mismatch for completed record", async () => {
    const input = { test: "different value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // Simulate findUnique returning a completed record with a DIFFERENT hash
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
      idempotencyKey,
      status: "completed",
      inputHash: "sha256:original",
      result: { success: true },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
  });

  it("should return REQUEST_IN_PROGRESS for pending record with matching hash", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // Compute the actual hash so it matches what the middleware generates
    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
      idempotencyKey,
      status: "pending",
      inputHash,
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("REQUEST_IN_PROGRESS");
  });

  it("should reject input hash mismatch for pending record", async () => {
    const input = { test: "different value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
      idempotencyKey,
      status: "pending",
      inputHash: "sha256:original",
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
  });

  it("should pass through when no idempotency key", async () => {
    const input = { test: "value" };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext({ success: true, data: "passed through" }));

    expect(mockPrisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toBe("passed through");
  });
});

describe("Audit Log Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should log successful tool execution", async () => {
    const input = { test: "value" };
    const toolResult: ToolResult = { success: true, data: "test result" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    expect(mockPrisma.aiActionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: "test-agent",
        conversationId: "test-conversation",
        userId: "test-user",
        tenantId: "test-tenant",
        toolCalled: "test_tool",
        toolInput: input,
        toolOutput: toolResult.data,
      }),
    });
    expect(result).toEqual(toolResult);
  });

  it("should log tool execution even when handler throws", async () => {
    const input = { test: "value" };
    const error = new Error("Test error");

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await expect(
      middleware(input, mockContext, mockDefinition, throwingNext(error))
    ).rejects.toThrow(error);

    expect(mockPrisma.aiActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toolCalled: "test_tool",
          toolOutput: { error: { message: "Test error", code: undefined } },
        }),
      })
    );
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

    const middleware = errorHandlerMiddleware;
    const result = await middleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TEST_ERROR");
    expect(result.error?.message).toBe("Test error message");
    expect(result.error?.suggestedTools).toEqual(["test_tool"]);
  });

  it("should handle Prisma unique constraint violations", async () => {
    const prismaError: any = new Error("Unique constraint violation");
    prismaError.code = "P2002";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    expect(result.error?.suggestedTools).toEqual(["search_test", "test_tool"]);
  });

  it("should handle Prisma not found errors", async () => {
    const prismaError: any = new Error("Record not found");
    prismaError.code = "P2025";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
    expect(result.error?.suggestedTools).toEqual(["search_test", "get_test"]);
  });

  it("should handle generic errors with fallback", async () => {
    const genericError = new Error("Unexpected error");

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(genericError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.error?.message).toContain("test_tool");
  });

  it("should return success handler result unchanged", async () => {
    const successResult: ToolResult = { success: true, data: "test" };

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, successNext(successResult));

    expect(result).toEqual(successResult);
  });
});