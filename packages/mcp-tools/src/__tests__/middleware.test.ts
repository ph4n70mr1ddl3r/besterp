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
import { Prisma } from "@prisma/client";

// Mock Prisma client for testing
const mockPrisma = {
  idempotencyRecord: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  aiActionLog: {
    create: vi.fn(),
  },
  // $transaction wraps a callback and provides a tx client that mirrors the parent mock.
  // The idempotency middleware now uses $transaction with Serializable isolation for race-free check-or-create.
  $transaction: vi.fn(),
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
    safeParse: (input: unknown) => ({ success: true, data: input }),
  } as any,
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

  /** Setup $transaction mock: when tx has a record, return it; when null, create it. */
  function mockFindInTransaction(record: any | null) {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>, _opts?: any) => {
      const tx = {
        idempotencyRecord: {
          findFirst: vi.fn().mockResolvedValue(record),
          create: mockPrisma.idempotencyRecord.create,
        },
      };
      return fn(tx);
    });
  }

  it("should create idempotency record on first execution", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // No existing record found — first execution. The tx.findUnique returns null,
    // then tx.create runs, and the callback returns null → middleware proceeds.
    mockFindInTransaction(null);
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

  it("should treat idempotency keys as tenant-scoped (same key, different tenants each create their own record)", async () => {
    // Regression: idempotency_record's primary key is composite
    // (idempotency_key, tenant_id), so a key is unique only WITHIN a tenant.
    // Two tenants that independently reuse the same key must both succeed.
    // A global PK on idempotency_key alone would throw P2002 on the second
    // create and surface as a misleading IDEMPOTENCY_CONTENTION error.
    const input = { test: "value" };
    const idempotencyKey = "shared-key";

    // Neither tenant has an existing record → both proceed to create.
    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({ idempotencyKey, status: "pending" });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const ctxA = { ...mockContext, tenantId: "tenant-a", idempotencyKey };
    const ctxB = { ...mockContext, tenantId: "tenant-b", idempotencyKey };

    const resA = await middleware(input, ctxA, mockDefinition, successNext({ success: true, data: "a" }));
    const resB = await middleware(input, ctxB, mockDefinition, successNext({ success: true, data: "b" }));

    expect(resA.success).toBe(true);
    expect(resB.success).toBe(true);

    // Two distinct records were created, one per tenant, both carrying the same key.
    const createCalls = mockPrisma.idempotencyRecord.create.mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0][0].data).toMatchObject({ idempotencyKey, tenantId: "tenant-a" });
    expect(createCalls[1][0].data).toMatchObject({ idempotencyKey, tenantId: "tenant-b" });
  });

  it("should return existing result for completed record with matching hash", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // Compute the actual hash so it matches what the middleware generates
    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    mockFindInTransaction({
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

    mockFindInTransaction({
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

    mockFindInTransaction({
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

    mockFindInTransaction({
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

    expect(mockPrisma.idempotencyRecord.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toBe("passed through");
  });

  it("should pass through when prisma is null", async () => {
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: "some-key" };

    const middleware = idempotencyMiddleware(null as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "passed through" }));

    expect(result.success).toBe(true);
    expect(result.data).toBe("passed through");
  });

  it("should re-execute for failed record (reset to pending atomically)", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // Compute the actual hash so it matches what the middleware generates
    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    // Simulate a failed record being found and reset inside the transaction
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>, _opts?: any) => {
      const tx = {
        idempotencyRecord: {
          findFirst: vi.fn().mockResolvedValue({
            idempotencyKey,
            status: "failed",
            inputHash, // Matching hash allows re-execution
          }),
          // The reset-to-pending update
          update: vi.fn().mockResolvedValue({}),
          create: mockPrisma.idempotencyRecord.create,
        },
      };
      return fn(tx);
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "re-executed" }));

    // The failed record was reset and the tool was re-executed
    expect(result.success).toBe(true);
    expect(result.data).toBe("re-executed");
  });

  it("should return contention error when all serialization retries fail", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // Simulate all retries failing with P2034 (serialization failure)
    mockPrisma.$transaction.mockRejectedValue({ code: "P2034" });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_CONTENTION");
  });

  it("should record soft-failure results (success:false) as 'failed', not 'completed'", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-soft-fail";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    // Handler returns a soft failure (success: false) instead of throwing.
    // This is the Zod-validation path: the registry's pipeline returns
    // `{ success: false, error: ... }` for invalid input rather than throwing.
    const softFailureNext = async () => ({
      success: false as const,
      error: {
        code: "INVALID_INPUT",
        message: "Input validation failed: test: Required",
      },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, softFailureNext);

    // Result is propagated unchanged
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");

    // The idempotency record must be stored as 'failed', not 'completed' —
    // a completed record would let a retry receive a stale (or absent) success
    // response. The 'failed' status forces re-execution on the next call.
    expect(mockPrisma.idempotencyRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey_tenantId: { idempotencyKey, tenantId: mockContext.tenantId } },
        data: expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({
            code: "INVALID_INPUT",
            message: expect.stringContaining("Input validation failed"),
          }),
        }),
      })
    );
  });

  it("should record successful results (success:true) as 'completed'", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-success";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(
      input,
      contextWithKey,
      mockDefinition,
      successNext({ success: true, data: "ok" })
    );

    expect(result.success).toBe(true);
    expect(mockPrisma.idempotencyRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "completed",
          result: "ok",
        }),
      })
    );
  });

  it("should not record an error field on successful completions", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-no-error-field";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "ok" }));

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const updateData = updateCall[0].data;
    // Prisma.DbNull explicitly nulls out the error column in the database
    expect(updateData.error).toBe(Prisma.DbNull);
  });

  it("should log to stderr when the failed-status update itself fails", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-update-fails";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    // Top-level findFirst for tenant ownership check in error path
    mockPrisma.idempotencyRecord.findFirst.mockResolvedValue({ idempotencyKey });
    // First update (the catch-up to 'failed') rejects; subsequent updates ignored.
    mockPrisma.idempotencyRecord.update.mockRejectedValue(new Error("DB down"));

    // Spy on stderr.write to verify the log line. process.stderr is a native
    // WritableStream — its `write` method has multiple overloads and the
    // vitest spy interacts with all of them. We replace the method with a
    // vi.fn() rather than mockImplementation on the spy to make assertion
    // straightforward.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrCalls: unknown[][] = [];
    const writeSpy = vi.fn((...args: unknown[]) => {
      stderrCalls.push(args);
      return true;
    });
    process.stderr.write = writeSpy as typeof process.stderr.write;

    try {
      const middleware = idempotencyMiddleware(mockPrisma as any);
      await expect(
        middleware(input, contextWithKey, mockDefinition, throwingNext(new Error("boom")))
      ).rejects.toThrow("boom");

      // The catch handler runs as a microtask after the rejected update is
      // caught. Let the event loop flush so the fire-and-forget stderr.write
      // lands in the spy before we assert.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.stderr.write = originalWrite;
    }

    // Stringify all call args — process.stderr.write can be called with
    // (string | Uint8Array, encoding?, cb?), so we coerce to string and join.
    const allArgs = stderrCalls
      .map((args) => args.map((a) => (typeof a === "string" ? a : "<binary>")).join(" "))
      .join("\n");
    expect(allArgs).toContain("test-update-fails");
  });

  it("should pass through when idempotencyKey is absurdly long (defensive pre-check)", async () => {
    // The middleware sees the raw key BEFORE Zod validation. Without the
    // pre-check, a 5KB junk key would create a `pending` record, Zod would
    // then mark it `failed`, and the junk would sit in the table for 24h.
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: "x".repeat(501) };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "passed through" }));

    expect(result.success).toBe(true);
    expect(result.data).toBe("passed through");
    // No record should have been created — the middleware bailed out early.
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyRecord.findFirst).not.toHaveBeenCalled();
  });

  it("should pass through when idempotencyKey is not a string (defensive pre-check)", async () => {
    // The key type isn't enforced at the boundary, so a buggy caller could
    // send a number, object, or boolean. Pass through to Zod to reject
    // rather than TypeError inside the middleware.
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: 12345 as unknown as string };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "passed through" }));

    expect(result.success).toBe(true);
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("should truncate oversized stored result data to 64 KB", async () => {
    // A 100 KB tool response would otherwise produce a 100 KB row in
    // `idempotency_record.result`. The middleware must cap the stored value.
    const input = { test: "value" };
    const idempotencyKey = "test-truncate";
    const contextWithKey = { ...mockContext, idempotencyKey };
    const largeData = { blob: "y".repeat(70000) };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await middleware(
      input,
      contextWithKey,
      mockDefinition,
      successNext({ success: true, data: largeData })
    );

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const stored = updateCall[0].data.result;
    expect(stored._truncated).toBe(true);
    expect(stored._originalSize).toBeGreaterThan(65536);
  });

  it("should cap oversized soft-failure error.message at 4 KB", async () => {
    // A Zod validation failure with many issues, or a deeply nested input,
    // can produce a multi-KB error string. Storing it verbatim in
    // idempotency_record.error.message would bloat the row and the
    // 24h-TTL cleanup job's I/O. The middleware must cap the message.
    const input = { test: "value" };
    const idempotencyKey = "test-soft-msg-cap";
    const contextWithKey = { ...mockContext, idempotencyKey };
    const hugeMessage = "x".repeat(8000);

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const softFailureNext = async () => ({
      success: false as const,
      error: {
        code: "INVALID_INPUT",
        message: hugeMessage,
      },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await middleware(input, contextWithKey, mockDefinition, softFailureNext);

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const stored = updateCall[0].data.error.message;
    // Cap is 4 KB; the marker suffix adds a few dozen bytes.
    expect(stored.length).toBeLessThan(4500);
    expect(stored.length).toBeGreaterThan(0);
    // Truncation marker should be present so operators can tell.
    expect(stored).toMatch(/truncated/);
  });

  it("should cap oversized thrown-error (hard-failure) message at 4 KB", async () => {
    // The throw path in executeAndUpdate must apply the same capString
    // bound as the soft-failure path. Without it, a verbose thrown error
    // (Prisma dump, network stack trace) would be stored verbatim and
    // bloat idempotency_record.error.message.
    const input = { test: "value" };
    const idempotencyKey = "test-hard-msg-cap";
    const contextWithKey = { ...mockContext, idempotencyKey };
    const hugeMessage = "x".repeat(8000);

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await expect(
      middleware(input, contextWithKey, mockDefinition, throwingNext(new Error(hugeMessage)))
    ).rejects.toThrow();

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const stored = updateCall[0].data.error.message;
    expect(stored.length).toBeLessThan(4500);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).toMatch(/truncated/);
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

  it("should redact sensitive fields (e.g. birthDate, taxId, password) from the audit log", async () => {
    // Regression guard: birthDate is the camelCase field that actually
    // flows through person subtype inputs. The redaction list previously
    // only had date_of_birth/dob (snake), so DOB was persisted in
    // plaintext in ai_action_log.tool_input.
    const input = {
      person: { birthDate: "1990-06-15", taxId: "123-45-6789" },
      password: "hunter2",
      name: "Jane Doe",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedInput = createCall[0].data.toolInput;
    expect(storedInput.person.birthDate).toBe("[REDACTED]");
    expect(storedInput.person.taxId).toBe("[REDACTED]");
    expect(storedInput.password).toBe("[REDACTED]");
    // Non-sensitive fields remain intact.
    expect(storedInput.name).toBe("Jane Doe");
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

  it("should pass through when prisma is null", async () => {
    const input = { test: "value" };
    const toolResult: ToolResult = { success: true, data: "ok" };

    const middleware = auditLogMiddleware(null as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    // Should not throw, should pass through the result
    expect(result).toEqual(toolResult);
  });

  it("should truncate oversized tool inputs", async () => {
    // Create an input larger than 64KB
    const largeInput = { data: "x".repeat(70000) };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(largeInput, mockContext, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedInput = createCall[0].data.toolInput;
    expect(storedInput._truncated).toBe(true);
    expect(storedInput._originalSize).toBeGreaterThan(65536);
    expect(typeof storedInput._preview).toBe("string");
  });

  it("should truncate oversized tool outputs", async () => {
    const input = { test: "value" };
    const largeOutput = { data: "y".repeat(70000) };
    const toolResult: ToolResult = { success: true, data: largeOutput };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedOutput = createCall[0].data.toolOutput;
    expect(storedOutput._truncated).toBe(true);
    expect(storedOutput._originalSize).toBeGreaterThan(65536);
    expect(typeof storedOutput._preview).toBe("string");
  });

  it("should truncate oversized error-path outputs", async () => {
    const input = { test: "value" };
    const longMessage = "x".repeat(70000);
    const error = new Error(longMessage);

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await expect(
      middleware(input, mockContext, mockDefinition, throwingNext(error))
    ).rejects.toThrow(error);

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedOutput = createCall[0].data.toolOutput;
    // Error output should be truncated consistently with the success path
    expect(storedOutput._truncated).toBe(true);
  });
});

describe("Error Handler Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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

  it("should provide fallback suggested tools for domain errors with no suggestedTools", async () => {
    const domainError = new DomainError(
      "TEST_ERROR",
      "No tools suggested",
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.suggestedTools).toEqual(["test_tool", "list_available_tools"]);
  });

  it("should handle Prisma unique constraint violations", async () => {
    const prismaError: any = new Error("Unique constraint violation");
    prismaError.code = "P2002";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    expect(result.error?.suggestedTools).toEqual(["search_tests", "test_tool"]);
  });

  it("should surface Prisma P2002 meta.target in the error message and context", async () => {
    // Prisma carries the conflicting field(s) in `meta.target`. The
    // handler should include them so the AI can correct the input
    // rather than re-trying the same operation blindly.
    const prismaError: any = new Error("Unique constraint violation");
    prismaError.code = "P2002";
    prismaError.meta = { target: "email" };

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    expect(result.error?.message).toContain("email");
    expect(result.error?.context?.conflictingFields).toBe("email");
  });

  it("should join P2002 meta.target arrays into a comma-separated list", async () => {
    // Compound unique constraints produce a string[] target — both
    // field names should be surfaced in the message and context.
    const prismaError: any = new Error("Unique constraint violation");
    prismaError.code = "P2002";
    prismaError.meta = { target: ["party_id", "role_type_id"] };

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.error?.message).toContain("party_id");
    expect(result.error?.message).toContain("role_type_id");
    expect(result.error?.context?.conflictingFields).toBe("party_id, role_type_id");
  });

  it("should fall back to the generic P2002 message when meta is absent", async () => {
    // Older Prisma versions or non-Prisma throwables that just happen
    // to carry `code: "P2002"` may not include `meta`. The handler
    // must still produce a useful response without crashing.
    const prismaError: any = new Error("Unique constraint violation");
    prismaError.code = "P2002";
    // No `meta` attached

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    expect(result.error?.context?.conflictingFields).toBeUndefined();
  });

  it("should handle Prisma not found errors", async () => {
    const prismaError: any = new Error("Record not found");
    prismaError.code = "P2025";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
    expect(result.error?.suggestedTools).toEqual(["search_tests", "get_test"]);
  });

  it("should handle Prisma optimistic concurrency / deadlock (P2034)", async () => {
    const prismaError: any = new Error("Transaction failed due to a write conflict");
    prismaError.code = "P2034";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONCURRENCY_CONFLICT");
    expect(result.error?.message).toContain("test_tool");
    expect(result.error?.suggestedTools).toContain("get_test");
  });

  it("should handle generic errors with fallback (always returns generic message)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const genericError = new Error("connection to db at 10.0.0.5:5432 failed");

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(genericError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    // Always returns a generic message to prevent leaking internals
    expect(result.error?.message).toContain("Unexpected error in 'test_tool'");
    expect(result.error?.message).not.toContain("10.0.0.5");
  });

  it("should strip the raw error message in production (no internals leak)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const sensitiveMessage = "PrismaClientKnownRequestError: Invalid `prisma.party.create()` invocation: connect ECONNREFUSED 10.0.0.5:5432";
    const genericError = new Error(sensitiveMessage);

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(genericError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    // Production must not echo the raw message (which can contain hostnames,
    // stack frames, SQL, etc.). A generic message is sent instead.
    expect(result.error?.message).not.toContain("10.0.0.5");
    expect(result.error?.message).not.toContain("PrismaClient");
    expect(result.error?.message).not.toContain("ECONNREFUSED");
    expect(result.error?.message).toContain("test_tool");
  });

  it("should return success handler result unchanged", async () => {
    const successResult: ToolResult = { success: true, data: "test" };

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, successNext(successResult));

    expect(result).toEqual(successResult);
  });
});