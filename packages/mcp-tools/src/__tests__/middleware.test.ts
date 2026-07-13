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
          findUnique: vi.fn().mockResolvedValue(record),
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
      createdAt: new Date(),
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
      createdAt: new Date(),
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
          findUnique: vi.fn().mockResolvedValue({
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

  it("should re-execute for stale pending record (crash recovery)", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-stale";
    const contextWithKey = { ...mockContext, idempotencyKey };

    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    // Simulate a stale pending record (created >60s ago) — the previous
    // request likely crashed before completing. The stale detection should
    // reset it to pending and allow re-execution.
    const staleCreatedAt = new Date(Date.now() - 120_000); // 2 minutes ago
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>, _opts?: any) => {
      const tx = {
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue({
            idempotencyKey,
            status: "pending",
            inputHash,
            createdAt: staleCreatedAt,
          }),
          update: vi.fn().mockResolvedValue({}),
          create: mockPrisma.idempotencyRecord.create,
        },
      };
      return fn(tx);
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "re-executed after stale" }));

    expect(result.success).toBe(true);
    expect(result.data).toBe("re-executed after stale");
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

  it("should sanitize DB connection strings from the non-retryable acquire warning", async () => {
    // Regression guard: a non-P2034 acquire failure (e.g. DB connection lost)
    // is logged to stderr with the raw error message. A driver error embeds
    // the datasource URL, so it must be scrubbed before reaching operator logs
    // — matching the audit-log and shutdown sanitization paths.
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockPrisma.$transaction.mockRejectedValue(
      new Error("connect failed: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp")
    );

    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrCalls: unknown[][] = [];
    const writeSpy = vi.fn((...args: unknown[]) => {
      stderrCalls.push(args);
      return true;
    });
    process.stderr.write = writeSpy as typeof process.stderr.write;

    let result;
    try {
      const middleware = idempotencyMiddleware(mockPrisma as any);
      result = await middleware(input, contextWithKey, mockDefinition, successNext());
      // The non-P2034 warning is written synchronously inside acquireIdempotencyRecord
      // before it returns, so no microtask flush is required.
    } finally {
      process.stderr.write = originalWrite;
    }

    // Non-P2034 → surfaces as SERVICE_UNAVAILABLE after logging the warning.
    // This distinguishes infrastructure failures (retrying with a new key
    // won't help) from serialization contention (P2034).
    expect(result?.success).toBe(false);
    expect(result?.error?.code).toBe("SERVICE_UNAVAILABLE");

    const allArgs = stderrCalls
      .map((args) => args.map((a) => (typeof a === "string" ? a : "<binary>")).join(" "))
      .join("\n");
    expect(allArgs).not.toContain("s3cret-pw");
    expect(allArgs).not.toContain("postgres://besterp");
    expect(allArgs).toContain("[DATABASE_URL]");
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

  it("should short-circuit on P2025 (record expired mid-operation) without retrying or throwing", async () => {
    // Regression guard: when the 24h-TTL cleanup job (or a concurrent reset)
    // removes the pending idempotency record between acquire and update, the
    // update throws Prisma P2025 ("record not found"). Previously this was
    // retried IDEMPOTENCY_MAX_RETRIES times — each retry re-throws P2025 since
    // the row is gone permanently — burning backoff latency before throwing a
    // ConcurrencyConflictError that was then swallowed by executeAndUpdate's
    // try/catch. The only observable effect was wasted latency + a misleading
    // "could not be updated after N attempts" warning. Now P2025 short-
    // circuits: a single update attempt, one warning, and the success result
    // is returned normally (both call sites tolerate a non-throwing return).
    const input = { test: "value" };
    const idempotencyKey = "test-p2025-expired";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    // The update fails with P2025 — the record vanished between acquire & update.
    const p2025 = Object.assign(new Error("Record to update not found."), { code: "P2025" });
    mockPrisma.idempotencyRecord.update.mockRejectedValue(p2025);

    // Capture stderr so we can assert the (non-misleading) warning is emitted
    // exactly once, and that it explains the expiry rather than blaming retries.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result: ToolResult | undefined;
    try {
      const middleware = idempotencyMiddleware(mockPrisma as any);
      result = await middleware(
        input,
        contextWithKey,
        mockDefinition,
        successNext({ success: true, data: "ok" })
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    // The operation result is returned to the caller regardless.
    expect(result?.success).toBe(true);
    expect(result?.data).toBe("ok");
    // Exactly ONE update attempt — P2025 must not trigger the retry loop.
    expect(mockPrisma.idempotencyRecord.update).toHaveBeenCalledTimes(1);
    const combined = stderrChunks.join("");
    // The warning explains the expiry and does NOT blame "N attempts" (the old
    // misleading message from the exhausted-retry path).
    expect(combined).toContain("no longer exists");
    expect(combined).not.toContain("after 3 attempts");
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
    expect(mockPrisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
  });

  it("should skip idempotency entirely when Zod validation fails (avoid false mismatch on retry)", async () => {
    // When safeParse fails, the middleware must NOT create an idempotency
    // record. Storing a hash of the raw (un-normalised) invalid input would
    // cause a false IDEMPOTENCY_KEY_MISMATCH on a subsequent retry with valid
    // (Zod-normalised) input. The handler receives the raw input and returns
    // INVALID_INPUT without side effects.
    const input = { test: 123 }; // wrong type — Zod expects string
    const idempotencyKey = "test-zod-fail";
    const contextWithKey = { ...mockContext, idempotencyKey };

    const failingSchemaDefinition: ToolDefinition = {
      ...mockDefinition,
      inputSchema: {
        type: "object",
        safeParse: (_raw: unknown) => ({
          success: false,
          error: { issues: [{ message: "Expected string, received number" }] },
        }),
      } as any,
    };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, failingSchemaDefinition, successNext({ success: true, data: "should not reach" }));

    // Handler was called (middleware passes through on validation failure)
    expect(result.success).toBe(true);
    expect(result.data).toBe("should not reach");
    // No idempotency record was created or queried
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
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

  it("should sanitize DB connection strings from the thrown-error message", async () => {
    // Regression guard: the hard-throw path in executeAndUpdate receives
    // the raw error (before errorHandlerMiddleware scrubs it) and persists
    // its message into the durable idempotency_record.error.message. A
    // driver/Prisma error can embed a connection string (credentials +
    // hostname); that secret must be redacted (→ [DATABASE_URL]) before it
    // is written, mirroring the audit-log error path.
    const input = { test: "value" };
    const idempotencyKey = "test-hard-msg-sanitize";
    const contextWithKey = { ...mockContext, idempotencyKey };
    const error = new Error(
      "Connection failed: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp (ECONNREFUSED)"
    );

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await expect(
      middleware(input, contextWithKey, mockDefinition, throwingNext(error))
    ).rejects.toThrow();

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const stored = updateCall[0].data.error.message;
    expect(stored).not.toContain("s3cret-pw");
    expect(stored).not.toContain("postgres://");
    expect(stored).toContain("[DATABASE_URL]");
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

  it("should redact snake_case sensitive fields (auth_token, session_token, client_secret, …)", async () => {
    // Regression guard: the catch-all regex used `\b` boundaries, and `_` is a
    // word character under `\w`, so `\btoken\b` could NOT match `session_token`,
    // `auth_token`, `bearer_token`, `id_token`, or `client_secret` — there is no
    // word boundary between `_` and the keyword. These standard credential
    // field names therefore leaked into ai_action_log.tool_input verbatim.
    // The regex now uses alnum-only lookarounds so `_`/`-` act as separators.
    const input = {
      auth_token: "eyJhbGci...",
      session_token: "sess-xyz",
      bearer_token: "bearer-abc",
      id_token: "id-jwt",
      client_secret: "topsecret",
      user_token: "u-token",
      auth_key: "ak",
      authToken: "camel-secret", // camelCase must still be caught
      // Unrelated fields carrying the same letters must NOT be redacted.
      tokenize: "false",
      name: "Jane Doe",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedInput = createCall[0].data.toolInput;
    expect(storedInput.auth_token).toBe("[REDACTED]");
    expect(storedInput.session_token).toBe("[REDACTED]");
    expect(storedInput.bearer_token).toBe("[REDACTED]");
    expect(storedInput.id_token).toBe("[REDACTED]");
    expect(storedInput.client_secret).toBe("[REDACTED]");
    expect(storedInput.user_token).toBe("[REDACTED]");
    expect(storedInput.auth_key).toBe("[REDACTED]");
    expect(storedInput.authToken).toBe("[REDACTED]");
    // No over-redaction of unrelated fields that merely contain the letters.
    expect(storedInput.tokenize).toBe("false");
    expect(storedInput.name).toBe("Jane Doe");
  });

  it("should redact camelCase sensitive fields (clientSecret, bearerToken, accessToken, …)", async () => {
    // Regression guard: SENSITIVE_FIELD_PATTERN uses alnum-only lookarounds
    // so `_` and `-` act as separators, but the lowercase→uppercase
    // transition does NOT. The snake_case siblings were redacted
    // (`client_secret`, `bearer_token`, `access_token`) but the camelCase
    // forms leaked verbatim into ai_action_log.tool_input. These are common
    // OAuth/credential field names, so the gap was a real redaction bypass.
    // A token-based fallback now splits on camelCase + snake/kebab boundaries
    // and matches each token against an unambiguous keyword set.
    const input = {
      clientSecret: "cs-topsecret",
      bearerToken: "bearer-xyz",
      accessToken: "access-jwt",
      refreshToken: "refresh-jwt",
      userPassword: "hunter2",
      sessionToken: "sess-abc",
      // snake_case siblings must still be redacted (unchanged behaviour).
      client_secret: "snake-cs",
      access_token: "snake-at",
      // `key` is intentionally NOT a sensitive token — it over-redacts
      // benign names like primaryKey/foreignKey. Key-bearing sensitive
      // fields stay covered by the explicit SENSITIVE_FIELDS set + the
      // `api[_-]?key` regex.
      primaryKey: "party-uuid",
      foreignKey: "role-uuid",
      idempotencyKey: "idem-1",
      // Single-token words that merely contain the keyword letters must
      // still NOT be redacted (no over-redaction).
      tokenize: "false",
      secrets: "plural-not-a-secret-value",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    const storedInput = mockPrisma.aiActionLog.create.mock.calls[0][0].data.toolInput;
    expect(storedInput.clientSecret).toBe("[REDACTED]");
    expect(storedInput.bearerToken).toBe("[REDACTED]");
    expect(storedInput.accessToken).toBe("[REDACTED]");
    expect(storedInput.refreshToken).toBe("[REDACTED]");
    expect(storedInput.userPassword).toBe("[REDACTED]");
    expect(storedInput.sessionToken).toBe("[REDACTED]");
    expect(storedInput.client_secret).toBe("[REDACTED]");
    expect(storedInput.access_token).toBe("[REDACTED]");
    // Benign key-bearing fields are preserved (no over-redaction).
    expect(storedInput.primaryKey).toBe("party-uuid");
    expect(storedInput.foreignKey).toBe("role-uuid");
    expect(storedInput.idempotencyKey).toBe("idem-1");
    // Single-token words containing the keyword letters are preserved.
    expect(storedInput.tokenize).toBe("false");
    expect(storedInput.secrets).toBe("plural-not-a-secret-value");
  });

  it("should not leak sensitive fields nested beyond MAX_REDACTION_DEPTH", async () => {
    // Regression guard: redactSensitiveFields previously returned the RAW
    // (unredacted) value once depth exceeded the cap, because isTerminal
    // short-circuited on the depth check BEFORE the key-name redaction loop
    // ran. A sensitive field buried deeper than the cap (password 12 levels
    // down) was therefore persisted verbatim to ai_action_log.tool_input.
    // The depth guard now returns "[Too deep]" (matching the error-handler)
    // so descent — and redaction — never silently stops at the cap.
    let deep: Record<string, unknown> = { password: "leak-me" };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    const input = { root: deep };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    const storedInput = mockPrisma.aiActionLog.create.mock.calls[0][0].data.toolInput;
    const serialized = JSON.stringify(storedInput);
    // The raw secret must never reach the audit row, even when deeply nested.
    expect(serialized).not.toContain("leak-me");
    // Descent stops at the cap with a placeholder rather than the raw object.
    expect(serialized).toContain("[Too deep]");
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

  it("should sanitize DB connection strings from error-path output", async () => {
    // Regression guard: the throw path stores error.message into the
    // durable ai_action_log.tool_output. A raw Prisma/driver error can
    // embed a connection string (credentials + hostname). Without
    // sanitization that secret would be persisted to the audit table —
    // worse than the stderr path, which the errorHandlerMiddleware already
    // scrubs. The message must be redacted before it lands in the DB.
    const input = { test: "value" };
    const error = new Error(
      "Connection failed: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp (ECONNREFUSED)"
    );

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await expect(
      middleware(input, mockContext, mockDefinition, throwingNext(error))
    ).rejects.toThrow(error);

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedMessage = createCall[0].data.toolOutput.error.message;
    expect(storedMessage).not.toContain("s3cret-pw");
    expect(storedMessage).not.toContain("postgres://");
    expect(storedMessage).toContain("[DATABASE_URL]");
  });

  it("should sanitize DB connection strings from the audit-write failure stderr log", async () => {
    // Regression guard: when the aiActionLog.create write itself rejects, the
    // backpressure manager writes the rejection's message to stderr. That
    // message is a Prisma/driver error that can embed a connection string, so
    // it must be scrubbed before reaching operator logs — matching the
    // error-path persistence sanitization above.
    const input = { test: "value" };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockRejectedValue(
      new Error("write failed: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp")
    );

    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrCalls: unknown[][] = [];
    const writeSpy = vi.fn((...args: unknown[]) => {
      stderrCalls.push(args);
      return true;
    });
    process.stderr.write = writeSpy as typeof process.stderr.write;

    try {
      const middleware = auditLogMiddleware(mockPrisma as any);
      // The middleware must not throw on a write failure — it is fire-and-forget.
      const result = await middleware(input, mockContext, mockDefinition, successNext(toolResult));
      expect(result).toEqual(toolResult);
      // Let the fire-and-forget .catch land in the stderr spy.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.stderr.write = originalWrite;
    }

    const allArgs = stderrCalls
      .map((args) => args.map((a) => (typeof a === "string" ? a : "<binary>")).join(" "))
      .join("\n");
    expect(allArgs).not.toContain("s3cret-pw");
    expect(allArgs).not.toContain("postgres://besterp");
    expect(allArgs).toContain("[DATABASE_URL]");
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

  it("should omit context when domain error carries no context", async () => {
    const domainError = new DomainError(
      "NO_CONTEXT",
      "No context provided",
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NO_CONTEXT");
    expect(result.error?.context).toBeUndefined();
  });

  it("should include context when domain error carries context", async () => {
    const domainError = new DomainError(
      "WITH_CONTEXT",
      "With context",
      { context: { field: "name", reason: "too short" } },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WITH_CONTEXT");
    expect(result.error?.context).toBeDefined();
    expect(result.error?.context?.field).toBe("name");
    expect(result.error?.context?.reason).toBe("too short");
  });

  it("should redact sensitive-named context fields before surfacing to the AI agent", async () => {
    // Defense-in-depth: DomainError.context is application-constructed and
    // by design never carries raw user secrets, but a future DomainError that
    // places a secret under a sensitive-named key must not leak it to the AI
    // agent. The error-handler now reuses the audit-log's isSensitiveField
    // detection so both agent-facing surfaces (tool result + audit row) apply
    // the same key-based redaction. Covers explicit names, snake/camel-case
    // regex hits, and the camelCase token fallback (clientSecret etc.).
    const domainError = new DomainError(
      "SENSITIVE_CONTEXT",
      "Carries a secret",
      {
        context: {
          password: "hunter2",
          apiKey: "sk-live-abc",
          api_key: "sk-live-def",
          accessToken: "jwt-token",
          clientSecret: "cs-topsecret",
          // Benign diagnostic fields must pass through untouched.
          field: "email",
          conflictingFields: "party_id",
          partyId: "12345678-1234-1234-1234-123456789abc",
          // `email` as a KEY is not sensitive (the value here is an
          // already-redacted preview, mirroring checkEmailDuplicate).
          email: "ab***@x.com",
        },
      },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    const ctx = result.error?.context as Record<string, unknown>;
    expect(ctx).toBeDefined();
    // Every sensitive-named key is replaced wholesale.
    expect(ctx.password).toBe("[REDACTED]");
    expect(ctx.apiKey).toBe("[REDACTED]");
    expect(ctx.api_key).toBe("[REDACTED]");
    expect(ctx.accessToken).toBe("[REDACTED]");
    expect(ctx.clientSecret).toBe("[REDACTED]");
    // No over-redaction of benign diagnostic fields actually in use.
    expect(ctx.field).toBe("email");
    expect(ctx.conflictingFields).toBe("party_id");
    expect(ctx.partyId).toBe("12345678-1234-1234-1234-123456789abc");
    expect(ctx.email).toBe("ab***@x.com");
    // The raw secret values never reach the agent.
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("jwt-token");
    expect(serialized).not.toContain("cs-topsecret");
  });

  it("should keep URL/path scrubbing for non-sensitive context values", async () => {
    // The sensitive-key redaction must compose with (not replace) the existing
    // value-level URL/path sanitization on non-sensitive keys.
    const domainError = new DomainError(
      "URL_IN_CONTEXT",
      "Has infra detail",
      { context: { detail: "failed at postgresql://user:pass@db-host:5432/app" } },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    const ctx = result.error?.context as Record<string, unknown>;
    expect(ctx.detail).toBe("failed at [DATABASE_URL]");
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

  it("should handle Prisma referential integrity violations (P2003)", async () => {
    const prismaError: any = new Error("Foreign key constraint failed");
    prismaError.code = "P2003";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("REFERENCE_ERROR");
    expect(result.error?.suggestedTools).toContain("search_tests");
  });

  it("should handle Prisma value-too-long errors (P2000)", async () => {
    const prismaError: any = new Error("Value too long for column");
    prismaError.code = "P2000";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(result.error?.suggestedTools).toContain("test_tool");
  });

  it("should handle Prisma required-relation violations (P2014)", async () => {
    const prismaError: any = new Error("Required relation violation");
    prismaError.code = "P2014";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("REFERENCE_ERROR");
    expect(result.error?.suggestedTools).toContain("search_tests");
  });

  it("should handle Prisma missing-table errors (P2021)", async () => {
    const prismaError: any = new Error("Table not found");
    prismaError.code = "P2021";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATABASE_ERROR");
    expect(result.error?.suggestedTools).toContain("list_available_tools");
  });

  it("should handle Prisma connection errors (P1001/P1000)", async () => {
    const prismaError: any = new Error("Can't reach database server");
    prismaError.code = "P1001";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATABASE_CONNECTION_ERROR");
    expect(result.error?.suggestedTools).toContain("list_available_tools");
  });

  it("should handle Prisma transaction timeout (P2028)", async () => {
    const prismaError: any = new Error("Transaction timed out");
    prismaError.code = "P2028";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONCURRENCY_CONFLICT");
    expect(result.error?.message).toContain("test_tool");
    expect(result.error?.suggestedTools).toContain("get_test");
  });

  it("should handle Prisma connection pool timeout (P2024)", async () => {
    const prismaError: any = new Error("Connection pool timeout");
    prismaError.code = "P2024";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATABASE_CONNECTION_ERROR");
    expect(result.error?.message).toContain("test_tool");
    expect(result.error?.suggestedTools).toContain("test_tool");
  });

  it("should handle Map with sensitive keys in error context (value-level scrub only)", async () => {
    // Maps in DomainError.context are converted to [[key, value], ...] arrays.
    // The error-handler's sanitizeContextValue recursively sanitizes values
    // (URL/path scrubbing) but does NOT apply isSensitiveField on Map keys —
    // that is the audit-log's domain. The Map must not crash and must
    // preserve the data structure.
    const m = new Map<string, unknown>([
      ["password", "hunter2"],
      ["name", "Jane"],
    ]);

    const domainError = new DomainError(
      "MAP_SENSITIVE",
      "Map with sensitive key",
      { context: { mapData: m } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    const ctx = result.error?.context as Record<string, unknown>;
    // Map is serialized to [[key, value], ...] entries
    const entries = ctx.mapData as unknown[][];
    expect(entries).toHaveLength(2);
    // Keys and values are preserved (error-handler doesn't redact Map keys
    // by field name — that's the audit-log's responsibility).
    const passwordEntry = entries.find((e: unknown[]) => Array.isArray(e) && e[0] === "password");
    expect(passwordEntry).toBeDefined();
    expect(passwordEntry![1]).toBe("hunter2");
    const nameEntry = entries.find((e: unknown[]) => Array.isArray(e) && e[0] === "name");
    expect(nameEntry).toBeDefined();
    expect(nameEntry![1]).toBe("Jane");
  });

  it("should handle Set with nested sensitive objects in error context", async () => {
    const s = new Set<unknown>([{ password: "hunter2" }]);

    const domainError = new DomainError(
      "SET_SENSITIVE",
      "Set with sensitive nested object",
      { context: { setData: s } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    const ctx = result.error?.context as Record<string, unknown>;
    // Set is serialized to [value, ...]
    const arr = ctx.setData as Record<string, unknown>[];
    expect(arr).toHaveLength(1);
    expect(arr[0].password).toBe("[REDACTED]");
  });

  it("should handle unrecognized Prisma error code (fall through to generic)", async () => {
    const prismaError: any = new Error("Unknown Prisma error");
    prismaError.code = "P9999";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
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

  it("should handle circular arrays in error context without stack overflow", async () => {
    const ctx: any[] = ["level0"];
    ctx.push(ctx);

    const domainError = new DomainError(
      "CIRCULAR_ARRAY",
      "Circular array in context",
      { context: { items: ctx } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CIRCULAR_ARRAY");
    expect(result.error?.context?.items).toBeDefined();
    expect(JSON.stringify(result.error?.context?.items)).toContain("[Circular]");
  });

  it("should handle circular Map in error context without stack overflow", async () => {
    const m = new Map<string, unknown>([["key", "value"]]);
    m.set("self", m);

    const domainError = new DomainError(
      "CIRCULAR_MAP",
      "Circular Map in context",
      { context: { mapData: m } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CIRCULAR_MAP");
  });

  it("should handle WeakSet in error context as [WeakCollection]", async () => {
    const ws = new WeakSet<object>();

    const domainError = new DomainError(
      "WEAK_SET",
      "WeakSet in context",
      { context: { weakData: ws } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WEAK_SET");
    expect(result.error?.context?.weakData).toBe("[WeakCollection]");
  });
});