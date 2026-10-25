// Unit tests for MCP middleware functionality
// Tests idempotency, audit logging, and error handling

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  idempotencyMiddleware,
  auditLogMiddleware,
  errorHandlerMiddleware,
  confirmationGateMiddleware,
} from "../middleware/index.js";
import { attachAuditWarning } from "../middleware/audit-log.js";
import { ToolDefinition, ToolContext, ToolResult } from "../schema/tool-definition.js";
import { DomainError, hashInput } from "@besterp/shared";
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
  // The follow-up tools the error handler suggests are DECLARED by the tool
  // definition — they are never derived from the entity string, because the
  // derived names ("search_agent_registryies", "get_type_table") are not
  // registered tools and an agent that followed them got UNKNOWN_TOOL back.
  relatedTools: { get: "get_test", search: "search_tests" },
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
    // The durable record ALWAYS carries the caller's identity (the columns
    // are NOT NULL in the schema). Fill them in from the context so the
    // fixture matches what the database really holds — the middleware
    // compares the stored userId/agentId against the incoming caller, and a
    // fixture without them would report a caller mismatch for the very
    // caller that created the record.
    const stored = record
      ? {
          userId: mockContext.userId,
          agentId: mockContext.agentId ?? null,
          conversationId: mockContext.conversationId ?? null,
          ...record,
        }
      : record;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>, _opts?: any) => {
      const tx = {
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue(stored),
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
      toolName: "test_tool",
      inputHash, // exact hash match
      result: { success: true, data: "existing result" },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: true, data: "existing result" });
    expect(result.replayed).toBe(true);
  });

  it("should reject cross-tool reuse of an idempotency key (no wrong-tool replay)", async () => {
    // Regression: the idempotency record is keyed by (idempotencyKey, tenantId)
    // and the input hash covers the Zod-normalized input only — no tool
    // component. A caller reusing a key for a DIFFERENT tool whose schema
    // normalizes to an identical input would previously replay the first
    // tool's cached result as if it were the second tool's, silently skipping
    // the second operation's side effect. The stored toolName must be
    // compared so cross-tool reuse surfaces as IDEMPOTENCY_KEY_MISMATCH.
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    mockFindInTransaction({
      idempotencyKey,
      status: "completed",
      toolName: "some_other_tool", // stored by a different tool
      inputHash, // identical normalized input → identical hash
      result: { success: true, data: "other tool's result" },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "must NOT be skipped" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    expect(result.error?.message).toContain("some_other_tool");
    expect(result.replayed).toBeUndefined();
    // The second tool must never receive the first tool's cached data as a replay.
    expect(result.data).toBeUndefined();
  });

  it("should reject a key already owned by ANOTHER caller in the same tenant", async () => {
    // Regression: the idempotency record's primary key is
    // (idempotencyKey, tenantId) — the key is tenant-scoped, NOT
    // user-scoped — and the stored userId/agentId were never compared. A
    // second user in the same tenant who happened to reuse the same key
    // received the FIRST user's stored result as a `success: true` replay:
    // a cross-user disclosure of another user's entity payload, and the
    // second user's own operation never ran.
    const input = { test: "value" };
    const idempotencyKey = "shared-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    const { hashInput } = await import("@besterp/shared");
    const inputHash = hashInput(input);

    mockFindInTransaction({
      idempotencyKey,
      status: "completed",
      toolName: "test_tool",
      inputHash, // identical input → identical hash
      userId: "another-user", // a DIFFERENT caller owns this key
      agentId: null,
      result: { success: true, data: "the other user's result" },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const next = vi.fn(async () => ({ success: true, data: "must NOT be skipped" }));
    const result = await middleware(input, contextWithKey, mockDefinition, next);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    // The other caller's payload must never be handed to this caller.
    expect(result.data).toBeUndefined();
    expect(result.replayed).toBeUndefined();
    // And this caller's own operation must still be able to run.
    expect(next).not.toHaveBeenCalled();
  });

  it("should reject input hash mismatch for completed record", async () => {
    const input = { test: "different value" };
    const idempotencyKey = "test-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction({
      idempotencyKey,
      status: "completed",
      toolName: "test_tool",
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
      toolName: "test_tool",
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
      toolName: "test_tool",
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

  it("should reject when idempotencyKey is absurdly long", async () => {
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: "x".repeat(501) };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "should not reach" }));

    // Should return an error, not pass through — the key exceeds the max length.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("should reject an empty-string idempotency key (present but invalid)", async () => {
    // An empty string is a PRESENT key (distinct from a missing key, which is a
    // no-op pass-through per ADR-004) and must be rejected rather than silently
    // creating a blank-key record.
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: "" };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "should not reach" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("should reject a non-string idempotency key (present but invalid)", async () => {
    // A numeric/boolean/object key in the context is a PRESENT but out-of-contract
    // value. The registry now promotes ANY present envelope key (round 174) so
    // this middleware's typeof guard can reject it — the write must never execute
    // unprotected just because the caller sent a malformed key.
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: 12345 as unknown as string };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "should not reach" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("fails CLOSED when prisma is null and a key was supplied", async () => {
    // The middleware used to pass the call through, so the write executed with
    // deduplication silently DISABLED and the agent was never told — a retry
    // of the same request executed the side effect a second time. That is
    // exactly what the sibling `handleUnhashableInput` path refuses to
    // accept, and what the sibling guards in the same pipeline (agent
    // policy, confirmation gate) already do.
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: "some-key" };

    const middleware = idempotencyMiddleware(null as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "passed through" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("passes through when prisma is null and NO key was supplied", async () => {
    // With no key there is nothing to deduplicate, so the call is a no-op
    // pass-through whether or not the store is reachable.
    const input = { test: "value" };

    const middleware = idempotencyMiddleware(null as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext({ success: true, data: "passed through" }));

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
            toolName: "test_tool",
            inputHash, // Matching hash allows re-execution
            userId: mockContext.userId,
            agentId: mockContext.agentId ?? null,
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
            toolName: "test_tool",
            inputHash,
            createdAt: staleCreatedAt,
            userId: mockContext.userId,
            agentId: mockContext.agentId ?? null,
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

  it("should cap an oversized error.code in the persisted soft-failure record", async () => {
    const input = { test: "value" };
    const idempotencyKey = "test-oversize-code";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({ idempotencyKey, status: "pending" });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    // error.code is a free-form string (getErrorCode is defensive), so a tool
    // could return a multi-KB code. It must be capped before persistence, the
    // same way the message is, so it can't bloat idempotency_record.error.code.
    const hugeCode = "Z".repeat(20_000);
    const softFailureNext = async () => ({
      success: false as const,
      error: { code: hugeCode, message: "boom" },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await middleware(input, contextWithKey, mockDefinition, softFailureNext);

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0][0];
    const storedCode = updateCall.data.error.code as string;
    expect(new TextEncoder().encode(storedCode).byteLength).toBeLessThanOrEqual(4096);
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
    // The idempotency key is redacted to a non-reversible hash token in logs,
    // so the raw key ("test-update-fails") must NOT appear verbatim — only the
    // "id-" prefixed hash token does.
    expect(allArgs).not.toContain("test-update-fails");
    expect(allArgs).toContain("id-");
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

  it("should reject when idempotencyKey is not a string", async () => {
    // The key type isn't enforced at the boundary, so a buggy caller could
    // send a number, object, or boolean. Return a structured error instead
    // of passing through to the handler with a bogus key.
    const input = { test: "value" };
    const contextWithKey = { ...mockContext, idempotencyKey: 12345 as unknown as string };

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "should not reach" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_IDEMPOTENCY_KEY");
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

  it("should cap and sanitize the thrown-error (hard-failure) error.code", async () => {
    // Regression guard for an asymmetric-leak path: the soft-failure branch
    // capped + scrubbed error.code, but the hard-throw branch stored it verbatim
    // (getErrorCode(error) with no cap/sanitize). A thrown custom error whose
    // .code carries a long or secret-shaped value would persist into the durable
    // 24h-TTL idempotency_record.error.code unredacted. Both paths must apply
    // capString(sanitizeForLogOutput(...)) to the code.
    const input = { test: "value" };
    const idempotencyKey = "test-hard-code-cap";
    const contextWithKey = { ...mockContext, idempotencyKey };
    const hugeCode = "x".repeat(8000);

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const errWithCode = Object.assign(new Error("boom"), { code: hugeCode });
    await expect(
      middleware(input, contextWithKey, mockDefinition, throwingNext(errWithCode))
    ).rejects.toThrow();

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const stored = updateCall[0].data.error.code;
    expect(stored.length).toBeLessThan(4500);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).toMatch(/truncated/);
  });

  it("should sanitize DB connection strings from the soft-failure error.message", async () => {
    // Regression guard for an asymmetric-leak path: the soft-failure (returned
    // `{ success: false }`, NOT thrown) branch persisted its error.message
    // via capString only, while the hard-throw branch scrubbed it via
    // sanitizeForLogOutput. A tool returning a non-thrown failure whose message
    // embeds a connection string (e.g. a downstream credential-check failure)
    // would therefore persist the secret verbatim into the durable 24h-TTL
    // idempotency_record, which the thrown-error path redacted. Both paths must
    // apply sanitizeForLogOutput before the durable write.
    const input = { test: "value" };
    const idempotencyKey = "test-soft-msg-sanitize";
    const contextWithKey = { ...mockContext, idempotencyKey };

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
        message: "Credential check failed: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp",
      },
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await middleware(input, contextWithKey, mockDefinition, softFailureNext);

    const updateCall = mockPrisma.idempotencyRecord.update.mock.calls[0];
    const stored = updateCall[0].data.error.message;
    expect(stored).not.toContain("s3cret-pw");
    expect(stored).not.toContain("postgres://");
    expect(stored).toContain("[DATABASE_URL]");
  });

  it("should sanitize userId/agentId/conversationId before persisting to idempotency_record", async () => {
    // Regression guard (round 85): buildContext validates identity fields at
    // the auth boundary but returns them raw (not sanitized) so downstream
    // tool-registry.validateContextIdentity can apply its own format check.
    // The idempotency middleware is the durable sink, so it must sanitize
    // userId/agentId/conversationId before writing to idempotency_record —
    // a secret-bearing identity field would otherwise leak to the cross-tenant
    // durable 24h-TTL record verbatim.
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const contextWithSecretIdentity = {
      ...mockContext,
      idempotencyKey,
      userId: "us-sk_live_realsecret123",
      agentId: "agent-a-password-hidden",
      conversationId: "conv_123_session-token",
    };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    await middleware(input, contextWithSecretIdentity as any, mockDefinition, successNext({ success: true, data: "created" }));

    const createCall = mockPrisma.idempotencyRecord.create.mock.calls[0];
    const stored = createCall[0].data;
    // userId with secret-shaped pattern should be redacted
    expect(stored.userId).not.toContain("sk_live_realsecret123");
    expect(stored.userId).toContain("[REDACTED_API_KEY]");
    // agentId without secret patterns passes through unchanged
    expect(stored.agentId).toBe("agent-a-password-hidden");
    // conversationId is an IDENTIFIER, not a secret: the generic
    // long-token rule must not rewrite it.
    //
    // It used to be redacted to "[REDACTED_TOKEN]" here while the AUDIT sink
    // (audit-log.ts) kept the SAME value verbatim — the two durable sinks
    // disagreed about who performed the operation, and the idempotency row
    // could no longer be correlated to the audit row, to the user or to the
    // agent. The recognised-secret rules still apply: the `userId` above
    // (which embeds a provider key) IS still redacted.
    expect(stored.conversationId).toBe("conv_123_session-token");
  });

  it("stores the SAME identity values as the audit sink", async () => {
    // The two durable sinks must never disagree about an identity field.
    // This test pins that contract directly so a future change to either
    // side fails loudly instead of silently re-introducing the divergence.
    const input = { test: "value" };
    const idempotencyKey = "test-key";
    const sharedIdentity = {
      ...mockContext,
      idempotencyKey,
      userId: "ServiceAccount12345678",
      agentId: "agent-a-password-hidden",
      conversationId: "conv_123_session-token",
    };

    mockFindInTransaction(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({
      idempotencyKey,
      status: "pending",
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});
    mockPrisma.aiActionLog.create.mockResolvedValue({});

    const idemMiddleware = idempotencyMiddleware(mockPrisma as any);
    await idemMiddleware(input, sharedIdentity as any, mockDefinition, successNext({ success: true, data: "created" }));
    const idemStored = mockPrisma.idempotencyRecord.create.mock.calls[0][0].data;

    const auditMiddleware = auditLogMiddleware(mockPrisma as any);
    await auditMiddleware(input, sharedIdentity as any, mockDefinition, successNext({ success: true, data: "created" }));
    const auditStored = mockPrisma.aiActionLog.create.mock.calls[0][0].data;

    expect(idemStored.userId).toBe(auditStored.userId);
    expect(idemStored.agentId).toBe(auditStored.agentId);
    expect(idemStored.conversationId).toBe(auditStored.conversationId);
  });
});

describe("Audit Log Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("attachAuditWarning", () => {
    it("merges the warning into a plain-object result without losing data", () => {
      const out = attachAuditWarning({ success: true, data: { name: "Acme", count: 3 } });
      expect(out.data).toMatchObject({ name: "Acme", count: 3 });
      expect((out.data as Record<string, unknown>)._auditWarning).toContain("audit");
    });

    it("does NOT corrupt a string result (object spread of a string would produce numeric index keys)", () => {
      // Regression: the old code spread result.data into an object literal,
      // so a string result "ok" became { _auditWarning, 0: "o", 1: "k" }.
      const out = attachAuditWarning({ success: true, data: "ok" });
      expect(out.data).toEqual({ _auditWarning: expect.stringContaining("audit"), data: "ok" });
    });

    it("does NOT discard a number result (object spread of a number drops it)", () => {
      const out = attachAuditWarning({ success: true, data: 42 });
      expect(out.data).toEqual({ _auditWarning: expect.stringContaining("audit"), data: 42 });
    });

    it("does NOT convert an array result into numeric-keyed keys", () => {
      const out = attachAuditWarning({ success: true, data: ["a", "b"] });
      expect(out.data).toEqual({ _auditWarning: expect.stringContaining("audit"), data: ["a", "b"] });
    });

    it("returns just the warning for a null/undefined result", () => {
      const out = attachAuditWarning({ success: true, data: null });
      expect(out.data).toEqual({ _auditWarning: expect.stringContaining("audit") });
    });

    it("does NOT let a tool's own _auditWarning field override the injected warning", () => {
      // Regression: the warning was set first and the tool's data spread
      // second, so a tool result carrying its own `_auditWarning` key silently
      // replaced the compliance-critical audit-gap notice. The injected
      // warning must always win.
      const out = attachAuditWarning({ success: true, data: { _auditWarning: "tool's own message", value: 1 } });
      expect(out.data).toMatchObject({ value: 1 });
      expect((out.data as Record<string, unknown>)._auditWarning).toContain("audit");
    });

    it("does NOT wipe a Map result (round 176)", () => {
      // Regression: the plain-object check was only typeof+!Array.isArray,
      // so a Map reached the spread branch. Spreading a Map yields {} (Maps
      // own no enumerable properties), silently REPLACING the payload with
      // { _auditWarning } on the rare backpressure-drop path.
      const map = new Map([["a", 1], ["b", 2]]);
      const out = attachAuditWarning({ success: true, data: map });
      expect(out.data).toEqual({ _auditWarning: expect.stringContaining("audit"), data: map });
      expect((out.data as { data: Map<string, number> }).data.get("a")).toBe(1);
    });

    it("does NOT wipe a Set or Date result (round 176)", () => {
      const set = new Set([1, 2, 3]);
      const date = new Date("2026-01-01T00:00:00Z");
      const setOut = attachAuditWarning({ success: true, data: set });
      const dateOut = attachAuditWarning({ success: true, data: date });
      expect(setOut.data).toEqual({ _auditWarning: expect.stringContaining("audit"), data: set });
      expect(dateOut.data).toEqual({ _auditWarning: expect.stringContaining("audit"), data: date });
    });

    it("preserves the prototype of class-instance results instead of flattening them", () => {
      class Result {
        constructor(public value: number) {}
        double(): number { return this.value * 2; }
      }
      const instance = new Result(21);
      const out = attachAuditWarning({ success: true, data: instance });
      // The wrapper keeps the original reference — spread would have produced
      // a bare own-property bag ({ value: 21 }) with double() lost.
      expect((out.data as { data: Result }).data).toBe(instance);
      expect((out.data as { data: Result }).data.double()).toBe(42);
    });

    it("still merges into null-prototype objects", () => {
      const data = Object.create(null) as Record<string, unknown>;
      data.value = 1;
      const out = attachAuditWarning({ success: true, data });
      expect(out.data).toMatchObject({ value: 1 });
      expect((out.data as Record<string, unknown>)._auditWarning).toContain("audit");
    });
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

  it("should persist Prisma null sentinels for a successful tool with no data (audit row not dropped)", async () => {
    // Regression (round 150): a successful tool returning { success: true }
    // with no data produced toolOutput=null (result.data ?? null), and a tool
    // invoked with no input produced toolInput=undefined. Prisma rejects a
    // bare JS null/undefined for Json columns ("Provided Json null, expected
    // JsonNull or DbNull"), so the create() call threw and the fire-and-forget
    // catch silently dropped the durable audit row for every such call.
    // Mirror of idempotency.ts: JsonNull for the REQUIRED toolInput column,
    // DbNull for the nullable toolOutput column.
    const toolResult: ToolResult = { success: true };
    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(undefined, mockContext, mockDefinition, successNext(toolResult));

    expect(mockPrisma.aiActionLog.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.aiActionLog.create.mock.calls[0][0].data;
    expect(data.toolInput).toBe(Prisma.JsonNull);
    expect(data.toolOutput).toBe(Prisma.DbNull);
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

  it("should redact sensitive fields from the LIVE tool result returned to the agent", async () => {
    // Regression guard for the live-vs-replay redaction asymmetry: the success
    // payload returned to the AI agent must be redacted the SAME way the
    // durable audit row (redactSensitiveFieldValues) and idempotency replay
    // (redactSensitiveFieldValues) are. A tool returning a credential under a
    // sensitive-named key must never leak to the agent on the first (live) call.
    const input = { name: "Jane Doe" };
    const toolResult: ToolResult = { success: true, data: { password: "hunter2", name: "Jane Doe" } };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.password).toBe("[REDACTED]");
    expect(data.name).toBe("Jane Doe");
  });

  it("should redact a Map whose key is a non-string object toString()-ing to a sensitive name", async () => {
    // Regression (round 50): the MCP audit-log redactMap only redacted
    // when `typeof k === "string" && isSensitiveField(k)`. The canonical
    // shared redactSensitiveFieldValues coerces the key via String(k), so a Map
    // keyed by an object whose toString() yields e.g. "password" was
    // redacted on the REST surface but NOT on the MCP/durable surface —
    // a divergence between the two "must-match" redactors. redactMap now
    // uses String(k) too, so the key + value are redacted on both.
    const secretKey = { toString: () => "password" } as unknown as string;
    const m = new Map<unknown, unknown>([[secretKey, "hunter2"]]);
    const input = { name: "Jane Doe" };
    const toolResult: ToolResult = { success: true, data: { mapData: m, name: "Jane Doe" } };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    expect(result.success).toBe(true);
    const data = (result as any).data;
    // The Map is serialized to [[key, value], ...] entries.
    const entries = data.mapData as unknown[][];
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("[REDACTED]");
    expect(entries[0][1]).toBe("[REDACTED]");
  });

  it("should sanitize secret-bearing string values under NON-sensitive keys (live + durable)", async () => {
    // Regression guard (round 48): redactSensitiveFieldValues returned terminal
    // string values verbatim, so a connection string / JWT / `?api_key=…`
    // embedded in a tool result value under a benign key (e.g. `url`, `note`)
    // survived the MCP redactor even though the canonical REST redactor
    // (shared redactSensitiveFieldValues) scrubs every string leaf. The secret
    // therefore leaked to the agent (live path) and the ai_action_log durable
    // row. String leaves must now pass through sanitizeForLogOutput.
    const input = { note: "ok" };
    const toolResult: ToolResult = {
      success: true,
      data: {
        url: "postgres://user:topsecret@db.example.com:5432/prod",
        note: "see https://api.example.com/v1/charge?api_key=sk_live_abc123",
        name: "Jane Doe",
      },
    };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    const result = await middleware(input, mockContext, mockDefinition, successNext(toolResult));

    const live = (result as any).data;
    expect(live.url).toContain("[DATABASE_URL]");
    expect(live.url).not.toContain("topsecret");
    expect(live.note).toContain("[HOST]/[PATH]");
    expect(live.note).not.toContain("sk_live_abc123");
    expect(live.name).toBe("Jane Doe");

    const storedOutput = mockPrisma.aiActionLog.create.mock.calls[0][0].data.toolOutput;
    expect(JSON.stringify(storedOutput)).not.toContain("topsecret");
    expect(JSON.stringify(storedOutput)).not.toContain("sk_live_abc123");
  });

  it("should sanitize secret-bearing reasoning before persisting to ai_action_log", async () => {
    // Regression guard (round 49): `reasoning` comes from the AI agent /
    // tool-call context (attacker-influenceable via the MCP request body) and is
    // persisted verbatim to ai_action_log.reasoning — a durable, cross-tenant
    // audit sink. Unlike toolInput/toolOutput (both redacted) and every
    // agent-facing surface (all sanitized), reasoning was only length-sliced, so a
    // connection string / JWT / `?api_key=…` embedded in it leaked to the
    // durable row. Sanitize before persisting, mirroring toolInput handling.
    const input = { name: "Jane Doe" };
    const contextWithReasoning = {
      ...mockContext,
      reasoning: "calling from postgres://user:topsecret@db.example.com:5432/prod via ?api_key=sk_live_abc123",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, contextWithReasoning as any, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedReasoning = createCall[0].data.reasoning as string;
    expect(storedReasoning).toContain("[DATABASE_URL]");
    expect(storedReasoning).not.toContain("topsecret");
    expect(storedReasoning).not.toContain("sk_live_abc123");
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
    // Regression guard: redactSensitiveFieldValues previously returned the RAW
    // (unredacted) value once depth exceeded the cap, because isTerminal
    // short-circuited on the depth check BEFORE the key-name redaction loop
    // ran. A sensitive field buried deeper than the cap was therefore
    // persisted verbatim to ai_action_log.tool_input. The depth guard now
    // returns "[Too deep]" (matching the error-handler) so descent — and
    // redaction — never silently stops at the cap. MAX_REDACTION_DEPTH is
    // kept in lock-step with the canonical shared redactor (20), so we nest
    // well past it (25 levels) to confirm the cap still bites.
    let deep: Record<string, unknown> = { password: "leak-me" };
    for (let i = 0; i < 25; i++) deep = { nested: deep };
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
          // The machine-readable code is stored under `errorCode`, NOT `code`:
          // the shared redactor treats the exact key `code` as a sensitive
          // field name and rewrote it to "[REDACTED]", which stripped the
          // only machine-readable discriminator from the durable audit trail.
          toolOutput: { error: { message: "Test error", errorCode: undefined } },
        }),
      })
    );
  });

  it("should persist sanitized error detail for soft-failure results (the real production error path)", async () => {
    // Regression (round 143): in the real pipeline the OUTERMOST
    // errorHandlerMiddleware converts every thrown error into a non-thrown
    // `{ success: false }` ToolResult, so the audit middleware's throw branch
    // never fires for real failures — previously the durable ai_action_log
    // row stored `toolOutput: null` for every failure, losing all error
    // detail from the audit trail. A soft-failure result must persist its
    // sanitized code + message instead.
    const input = { test: "value" };
    const softFailureNext = async (): Promise<ToolResult> => ({
      success: false,
      error: { code: "BUSINESS_RULE", message: "A party with this name already exists" },
    });

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    const result = await middleware(input, mockContext, mockDefinition, softFailureNext);

    expect(result.success).toBe(false);
    expect(mockPrisma.aiActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toolCalled: "test_tool",
          // The machine-readable code is stored under `errorCode` (not the
          // sensitive-named key `code`) so it survives the shared redactor —
          // the durable audit trail keeps the failure discriminator.
          toolOutput: { error: { message: "A party with this name already exists", errorCode: "BUSINESS_RULE" } },
        }),
      })
    );
  });

  it("should sanitize DB connection strings from soft-failure output", async () => {
    // Regression (round 143): a soft failure returned through the
    // errorHandlerMiddleware can embed a driver/connection-string-shaped
    // message (or one whose handler interpolates an attacker-controlled
    // value). The soft-failure branch previously persisted NO output at all;
    // now that it stores the message, it must scrub it exactly like the throw
    // branch before it lands in the durable ai_action_log row.
    const input = { test: "value" };
    const softFailureNext = async (): Promise<ToolResult> => ({
      success: false,
      error: {
        code: "DATABASE_ERROR",
        message: "Connection failed: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp (ECONNREFUSED)",
      },
    });

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, mockContext, mockDefinition, softFailureNext);

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const storedMessage = createCall[0].data.toolOutput.error.message;
    expect(storedMessage).not.toContain("s3cret-pw");
    expect(storedMessage).not.toContain("postgres://");
    expect(storedMessage).toContain("[DATABASE_URL]");
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
    // Error output stores { error: { message, code } } where message is
    // capped via capString (not truncateValue), so check the textual marker
    expect(storedOutput.error.message).toContain("[truncated, original was");
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

  it("should sanitize userId/agentId/conversationId before persisting to audit log", async () => {
    // Regression guard (round 85): buildContext returns raw identity values,
    // so audit-log middleware must sanitize them before persisting to the
    // cross-tenant durable sink (ai_action_log) to prevent secret leaks.
    //
    // "Sanitize" means: redact the RECOGNISED secret shapes (provider keys,
    // connection strings, `name=value` pairs, URLs, paths, Bearer/JWT). The
    // generic "opaque token" rule is deliberately NOT applied to identity
    // fields: it rewrites every 20-128 character run that mixes letters and
    // digits to "[REDACTED_TOKEN]", so a legal identifier such as
    // "ServiceAccount12345678" or "conv_123_session-token" was persisted
    // mangled — destroying the audit correlation the row exists to provide.
    const input = { test: "value" };
    const contextWithSecretIdentity = {
      ...mockContext,
      userId: "us-sk_live_realsecret123",
      agentId: "agent-a-password-hidden",
      conversationId: "conv_123_session-token",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, contextWithSecretIdentity as any, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const stored = createCall[0].data;
    // A recognised provider key embedded in the userId IS redacted.
    expect(stored.userId).not.toContain("sk_live_realsecret123");
    expect(stored.userId).toContain("[REDACTED_API_KEY]");
    expect(stored.agentId).toBe("agent-a-password-hidden");
    // An opaque identifier is preserved so the audit row still identifies its
    // subject.
    expect(stored.conversationId).toBe("conv_123_session-token");
  });

  it("redacts recognised secrets embedded in an identity field", async () => {
    // The identity fields are charset-validated but NOT secret-free: a
    // caller can embed a connection string or a provider key in one. Those
    // shapes must still be scrubbed before the row reaches the cross-tenant
    // durable sink.
    const input = { test: "value" };
    const contextWithSecretIdentity = {
      ...mockContext,
      userId: "postgres://besterp:hunter2@db.internal:5432/besterp",
      agentId: "agent-with-sk_live_realsecret123",
      conversationId: "conv-with-AKIAIOSFODNN7EXAMPLE",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, contextWithSecretIdentity as any, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const stored = createCall[0].data;
    expect(stored.userId).toContain("[DATABASE_URL]");
    expect(stored.userId).not.toContain("hunter2");
    expect(stored.agentId).not.toContain("sk_live_realsecret123");
    expect(stored.conversationId).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("preserves a legitimate long opaque identifier in the audit row", async () => {
    // Regression guard: the durable audit trail is useless if its subject
    // column contains "[REDACTED_TOKEN]" instead of the identifier.
    const input = { test: "value" };
    const contextWithLongIdentity = {
      ...mockContext,
      userId: "ServiceAccount12345678",
    };
    const toolResult: ToolResult = { success: true, data: "ok" };

    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });

    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(input, contextWithLongIdentity as any, mockDefinition, successNext(toolResult));

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const stored = createCall[0].data;
    expect(stored.userId).toBe("ServiceAccount12345678");
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

  it("should preserve empty context (not drop it to undefined)", async () => {
    // Regression guard (round 182): sanitizeContextValueForToolResult
    // previously returned undefined for empty objects, silently dropping
    // context that existed but carried no keys. An empty context must now
    // be reflected to the agent so the caller can distinguish "no context"
    // from "empty context".
    const domainError = new DomainError(
      "NO_CONTEXT",
      "No context provided",
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NO_CONTEXT");
    expect(result.error?.context).toEqual({});
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

  it("should preserve array context values with element-level redaction", async () => {
    // Regression: sanitizeContextValueForToolResult previously dropped array
    // values (e.g. { issues: [...] }) because it treated them as non-objects.
    // A DomainError whose context carries an array must reflect it to the
    // agent so the structured data is not silently lost.
    const domainError = new DomainError(
      "ARRAY_CONTEXT",
      "Has array data",
      { context: { issues: ["issue-a", "issue-b"] } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    const ctx = result.error?.context as Record<string, unknown>;
    expect(ctx).toBeDefined();
    expect(ctx.issues).toEqual(["issue-a", "issue-b"]);
  });

  it("should preserve primitive context values (string, number, boolean)", async () => {
    // Regression guard: sanitizeContextValueForToolResult previously returned
    // undefined for every non-object value, silently dropping useful scalar
    // context like { count: 42 } or { active: true } from agent-facing errors.
    const domainError = new DomainError(
      "PRIMITIVE_CONTEXT",
      "Has scalar data",
      { context: { count: 42, active: true, label: "test" } as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    const ctx = result.error?.context as Record<string, unknown>;
    expect(ctx.count).toBe(42);
    expect(ctx.active).toBe(true);
    expect(ctx.label).toBe("test");
  });

  it("should handle Prisma unique constraint violations", async () => {
    const prismaError: any = new Error("Unique constraint violation");
    prismaError.code = "P2002";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    expect(result.error?.suggestedTools).toEqual(["search_tests", "test_tool"]);
  });

  it("should not suggest unregistered tools when the definition declares no related tools", async () => {
    // The handler used to derive the follow-up tool names from the entity
    // string, producing names that are not registered ("search_tests" for
    // entity "test"). A tool that declares no mapping now suggests only
    // itself, so every suggestion is callable.
    const prismaError: any = new Error("Record not found");
    prismaError.code = "P2025";

    const definitionWithoutRelated = { ...mockDefinition, relatedTools: undefined };
    const result = await errorHandlerMiddleware({}, mockContext, definitionWithoutRelated, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.suggestedTools).toEqual(["test_tool"]);
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
    expect(result.error?.suggestedTools).toEqual(["search_tests", "get_test", "test_tool"]);
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

  it("should handle Prisma connection timeout (P1008)", async () => {
    const prismaError: any = new Error("Connection timed out");
    prismaError.code = "P1008";

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(prismaError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATABASE_CONNECTION_ERROR");
    expect(result.error?.message).toContain("same idempotency key");
    expect(result.error?.suggestedTools).toContain("list_available_tools");
  });

  it("should redact Map values whose key is a sensitive field name", async () => {
    // Maps in DomainError.context are converted to [[key, value], ...] arrays.
    // The shared redactor applies isSensitiveFieldName to Map keys so a secret
    // stored under a sensitive-named Map key is not reflected to the AI agent.
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
    // The value under a sensitive key is redacted (key itself is also redacted
    // by the shared redactor), while non-sensitive entries are preserved.
    const passwordEntry = entries.find((e: unknown[]) => Array.isArray(e) && e[0] === "[REDACTED]");
    expect(passwordEntry).toBeDefined();
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

  it("should not over-redact deep-but-legitimate context trees (depth cap aligned with canonical 20)", async () => {
    // Regression guard (round 51): the error-handler previously used a depth
    // cap of 10 while the canonical shared redactor and the audit-log both use
    // 20. A DomainError.context tree 11–20 levels deep was silently replaced
    // with "[Too deep]" on the MCP agent-facing surface while the REST surface
    // preserved it — data loss on the agent path. The error-handler now
    // delegates to the shared MAX_REDACTION_DEPTH so both surfaces agree.
    //
    // Note: sanitizeContextValueForToolResult → sanitizeContextValue(value, 0)
    // → sanitizeObject iterates entries calling sanitizeContextValue(v, depth+1),
    // so the first nesting level starts at depth 1. A 20-deep tree (level0…level19)
    // reaches depth 20 at level19, which is NOT > 20, so it is preserved.
    const domainError = new DomainError(
      "DEEP_CONTEXT",
      "Deep context",
      {
        context: {
          level0: {
            level1: {
              level2: {
                level3: {
                  level4: {
                    level5: {
                      level6: {
                        level7: {
                          level8: {
                            level9: {
                              level10: {
                                level11: {
                                  level12: {
                                    level13: {
                                      level14: {
                                        level15: {
                                          level16: {
                                            level17: {
                                              level18: {
                                                level19: "deep-value",
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DEEP_CONTEXT");
    const ctx = result.error?.context as Record<string, unknown> | undefined;
    // Depth 20 must be preserved (the cap is exclusive: depth > 20 → "[Too deep]")
    expect(ctx).toBeDefined();
    expect(ctx!.level0.level1.level2.level3.level4.level5.level6.level7.level8.level9.level10.level11.level12.level13.level14.level15.level16.level17.level18.level19).toBe("deep-value");
  });

  it("should preserve an empty object context instead of dropping it", async () => {
    // Regression guard (round 182): sanitizeContextValueForToolResult
    // previously returned undefined for empty objects, silently dropping
    // context that existed but carried no keys. The audit-log path
    // preserves empty objects, so the two surfaces were inconsistent. An
    // empty context must now be reflected to the agent so the caller can
    // distinguish "no context" from "empty context".
    const domainError = new DomainError(
      "EMPTY_CONTEXT",
      "Has empty context",
      { context: {} as any },
    );

    const result = await errorHandlerMiddleware({}, mockContext, mockDefinition, throwingNext(domainError));

    expect(result.success).toBe(false);
    const ctx = result.error?.context;
    // Empty object must be preserved, not dropped to undefined.
    expect(ctx).toBeDefined();
    expect(ctx).toEqual({});
  });
});

describe("Confirmation Gate Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPrismaForGate = {
    confirmationGate: {
      findUnique: vi.fn(),
    },
  };

  const highRiskDefinition: ToolDefinition = {
    ...mockDefinition,
    riskLevel: "high",
  };

  const criticalRiskDefinition: ToolDefinition = {
    ...mockDefinition,
    riskLevel: "critical",
  };

  const lowRiskDefinition: ToolDefinition = {
    ...mockDefinition,
    riskLevel: "low",
  };

  it("should pass through low-risk tools without checking the gate", async () => {
    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const result = await middleware({}, mockContext, lowRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(mockPrismaForGate.confirmationGate.findUnique).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("should pass through when gate is not configured for the tool", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const result = await middleware({}, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(true);
  });

  it("should pass through when gate is disabled", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: false });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const result = await middleware({}, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(true);
  });

  it("should require confirmation when gate is enabled and risk is high", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const result = await middleware({}, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("should require confirmation for critical-risk tools too", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const result = await middleware({}, mockContext, criticalRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("should accept a valid confirmation and pass it through sanitized", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const input = { name: "Jane", confirmation: "This is a valid confirmation reason for creating this party" };
    const result = await middleware(input, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(true);
    // The next handler should receive the sanitized confirmation.
    // Since we used successNext which ignores input, we verify via
    // a custom next that captures the input.
    let capturedInput: unknown;
    const capturingNext = async (inp: unknown) => {
      capturedInput = inp;
      return { success: true, data: "ok" };
    };
    await middleware(input, mockContext, highRiskDefinition, capturingNext);
    expect((capturedInput as Record<string, unknown>).confirmation).toBe(
      "This is a valid confirmation reason for creating this party",
    );
  });

  it("should reject a confirmation that is too short", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const input = { name: "Jane", confirmation: "too short" };
    const result = await middleware(input, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIRMATION");
    expect(result.error?.message).toContain("at least 10 characters");
  });

  it("should reject a non-string confirmation", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const input = { name: "Jane", confirmation: 12345 as unknown as string };
    const result = await middleware(input, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIRMATION");
  });

  it("should reject a whitespace-only confirmation", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const input = { name: "Jane", confirmation: "   " };
    const result = await middleware(input, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIRMATION");
  });

  it("should sanitize HTML in confirmation before propagating it", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const input = { name: "Jane", confirmation: "<script>alert(1)</script> Creating a customer for invoice follow-up" };
    let capturedContext: ToolContext | undefined;
    const capturingNext = async (_inp: unknown, ctx: ToolContext) => {
      capturedContext = ctx;
      return { success: true, data: "ok" };
    };
    await middleware(input, mockContext, highRiskDefinition, capturingNext);
    // The confirmation travels on the CONTEXT — the tool input is left
    // untouched because every tool schema is a z.strictObject that rejects
    // undeclared keys (the gate used to inject the key into the input, which
    // made every gated tool fail schema validation).
    const confirmation = capturedContext?.confirmation as string;
    expect(confirmation).not.toContain("<script>");
    expect(confirmation).not.toContain("alert");
    expect(confirmation).toContain("Creating a customer");
  });

  it("should propagate the confirmation on the context when it is supplied there", async () => {
    // The registry promotes the confirmation from the tool arguments onto the
    // context and strips it from the validated input — the gate must read it
    // from the context.
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    let capturedContext: ToolContext | undefined;
    const capturingNext = async (_inp: unknown, ctx: ToolContext) => {
      capturedContext = ctx;
      return { success: true, data: "ok" };
    };
    const result = await middleware(
      { name: "Jane" },
      { ...mockContext, confirmation: "Creating a customer for invoice follow-up" },
      highRiskDefinition,
      capturingNext,
    );

    expect(result.success).toBe(true);
    expect(capturedContext?.confirmation).toBe("Creating a customer for invoice follow-up");
  });

  it("should BLOCK the call when the gate lookup fails (fails closed)", async () => {
    // The gate used to pass through when the database was unreachable, which
    // made the control bypassable by making the database unavailable: a
    // high-risk write executed with NO confirmation and no justification
    // recorded in the audit trail. The sibling agentPolicy middleware in the
    // same pipeline already fails closed, and the two must not disagree.
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const next = vi.fn(async () => ({ success: true, data: "ok" }));
    const result = await middleware({}, mockContext, highRiskDefinition, next);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONFIRMATION_GATE_UNAVAILABLE");
    // The handler must NOT have run.
    expect(next).not.toHaveBeenCalled();
  });

  it("should reject null/undefined input object", async () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    // Pass a primitive instead of an object
    const result = await middleware("not-an-object" as unknown as object, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
  });
});

describe("Regression: confirmation gate validates the SANITIZED value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPrismaForGate = {
    confirmationGate: { findUnique: vi.fn() },
  };

  const highRiskDefinition: ToolDefinition = {
    ...mockDefinition,
    riskLevel: "high",
  };

  it("rejects a confirmation that is only HTML markup (nothing left after stripping)", () => {
    // The length gate ran on the RAW value, but the value that is propagated
    // on the context and persisted to ai_action_log.toolInput is the
    // post-strip one. A markup-only confirmation (an HTML comment wrapping a
    // justification) passed the >= 10 character check on the raw value but
    // collapsed to "" — so a high-risk operation executed with NO recorded
    // justification at all.
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    const input = { name: "Jane", confirmation: `<!--${"y".repeat(50)}-->` };
    return middleware(input, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" })).then((result) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_CONFIRMATION");
    });
  });

  it("rejects a confirmation whose visible text is shorter than the minimum", () => {
    (mockPrismaForGate.confirmationGate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });

    const middleware = confirmationGateMiddleware(mockPrismaForGate as any);
    // 12 raw characters, but only 2 survive the HTML strip.
    const input = { name: "Jane", confirmation: "<b>ok</b>" };
    return middleware(input, mockContext, highRiskDefinition, successNext({ success: true, data: "ok" })).then((result) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_CONFIRMATION");
    });
  });
});

describe("Regression: audit middleware never breaks the tool call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const auditPrisma = {
    aiActionLog: { create: vi.fn().mockResolvedValue({}) },
    idempotencyRecord: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  };

  it("does not abort the call when the confirmation is oversized", async () => {
    // `stripHtmlTags` rejects inputs over 100 KB by THROWING, and the audit
    // middleware runs OUTSIDE the confirmation gate — so an oversized
    // confirmation (which no boundary length-validates) aborted the whole
    // tool call with an opaque INTERNAL_ERROR and wrote NO audit row.
    const middleware = auditLogMiddleware(auditPrisma as any);
    const hugeConfirmation = "x".repeat(150_000);
    const result = await middleware(
      { name: "Jane" },
      { ...mockContext, confirmation: hugeConfirmation },
      mockDefinition,
      successNext({ success: true, data: "ok" }),
    );
    expect(result.success).toBe(true);
    expect(auditPrisma.aiActionLog.create).toHaveBeenCalled();
  });

  it("keeps a non-plain-object tool input in the durable audit row", async () => {
    // The audit row used to be `{ ...{}, confirmation }` for a non-plain-object
    // input (array / Map / class instance) — the ENTIRE tool input vanished
    // from the durable trail.
    const middleware = auditLogMiddleware(auditPrisma as any);
    await middleware(
      [1, 2, 3],
      { ...mockContext, confirmation: "A perfectly reasonable justification" },
      mockDefinition,
      successNext({ success: true, data: "ok" }),
    );
    const row = auditPrisma.aiActionLog.create.mock.calls[0]![0].data;
    expect(row.toolInput).toBeDefined();
    expect(JSON.stringify(row.toolInput)).toContain("1");
    expect(row.toolInput).toHaveProperty("confirmation");
  });

  it("does not abort the call when a nextActions entry is oversized", async () => {
    // `nextActions` is an agent-facing string array built by handlers from
    // user input. The sanitizer called `stripHtmlTags(n)` with no length
    // clamp and no try/catch, and `stripHtmlTags` THROWS for inputs over
    // 100 KB — so a handler that legitimately returned a large nextActions
    // entry turned a SUCCESSFUL write into an INVALID_TYPE_VALUE error whose
    // message was unrelated to the input. The agent was told the call failed
    // and retried, duplicating the write.
    const middleware = auditLogMiddleware(auditPrisma as any);
    const huge = "x".repeat(150_000);
    const result = await middleware(
      { name: "Jane" },
      mockContext,
      mockDefinition,
      successNext({ success: true, data: "ok", nextActions: [huge] }),
    );
    expect(result.success).toBe(true);
    expect(auditPrisma.aiActionLog.create).toHaveBeenCalled();
  });

  it("does not abort the call when the reasoning is a NON-STRING", async () => {
    // `reasoning` was sanitized with `sanitizeForLogOutput(context.reasoning)`
    // and NO try/catch, while `createBaseEntry` runs OUTSIDE the audit
    // middleware's try/catch. `sanitizeForLogOutput` calls
    // `sanitizeLogMessage`, which does `message.replace(...)` — on a
    // non-string that is a TypeError, so the whole tool call aborted BEFORE
    // the handler ran and the agent was told INTERNAL_ERROR.
    //
    // `ToolContext` is a public, hand-constructible type and the registry
    // validates tenantId/userId/agentId/conversationId but NOT `reasoning`.
    const middleware = auditLogMiddleware(auditPrisma as any);
    for (const badReasoning of [123, {}, [], true]) {
      const result = await middleware(
        { name: "Jane" },
        { ...mockContext, reasoning: badReasoning } as never,
        mockDefinition,
        successNext({ success: true, data: "ok" }),
      );
      expect(result.success).toBe(true);
    }
    expect(auditPrisma.aiActionLog.create).toHaveBeenCalled();
  });

  it("does not abort the call when the reasoning is oversized", async () => {
    // `stripHtmlTags` rejects inputs over 100 KB by throwing.
    const middleware = auditLogMiddleware(auditPrisma as any);
    const result = await middleware(
      { name: "Jane" },
      { ...mockContext, reasoning: "x".repeat(150_000) },
      mockDefinition,
      successNext({ success: true, data: "ok" }),
    );
    expect(result.success).toBe(true);
    expect(auditPrisma.aiActionLog.create).toHaveBeenCalled();
  });

  it("strips HTML from the reasoning before it reaches the durable audit row", async () => {
    // `reasoning` was the only free-text field that was NOT passed through
    // `stripHtmlTags` (both identity fields and the confirmation are), so raw
    // HTML could be persisted into the durable `ai_action_log.reasoning`
    // column.
    const middleware = auditLogMiddleware(auditPrisma as any);
    await middleware(
      { name: "Jane" },
      { ...mockContext, reasoning: "<img src=x onerror=alert(1)>reason" },
      mockDefinition,
      successNext({ success: true, data: "ok" }),
    );
    const row = auditPrisma.aiActionLog.create.mock.calls[0]![0].data;
    expect(row.reasoning).not.toContain("<img");
    expect(row.reasoning).toContain("reason");
  });
});

describe("Regression: agent-facing error surfaces are length-capped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caps a DomainError message at the shared agent-facing bound", async () => {
    const middleware = errorHandlerMiddleware;
    const huge = "y".repeat(50_000);
    const result = await middleware(
      { name: "Jane" },
      mockContext,
      mockDefinition,
      throwingNext(new DomainError("CUSTOM", huge)),
    );
    expect(result.success).toBe(false);
    expect(result.error!.message!.length).toBeLessThanOrEqual(2_001);
  });
});

describe("Regression: idempotency P2002 is contention, not an outage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-reads the row and reports REQUEST_IN_PROGRESS instead of SERVICE_UNAVAILABLE", async () => {
    // A concurrent request inserted the same (idempotencyKey, tenantId) row
    // between our findUnique and our create → P2002. That is CONTENTION (the
    // other request holds the record), not an infrastructure outage. The
    // agent was told "the operation cannot be retried at this time", which
    // is the wrong recovery instruction for a duplicate-key race.
    const idempotencyKey = "race-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>, _opts?: any) => {
      const tx = {
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockRejectedValue(
            Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
          ),
        },
      };
      return fn(tx);
    });
    // The re-read (outside the failed transaction) finds the concurrent row.
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
      idempotencyKey,
      tenantId: "test-tenant",
      toolName: "test_tool",
      status: "pending",
      inputHash: hashInput({ test: "value" }),
      createdAt: new Date(),
      userId: mockContext.userId,
      agentId: mockContext.agentId ?? null,
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(
      { test: "value" },
      contextWithKey,
      mockDefinition,
      successNext({ success: true, data: "created" }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("REQUEST_IN_PROGRESS");
    expect(result.error?.code).not.toBe("SERVICE_UNAVAILABLE");
  });
});

describe("Error Handler Middleware — the error mapper itself must not fail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a Prisma code that collides with an Object.prototype member", () => {
    // `PRISMA_ERROR_HANDLERS` is a plain object literal, so the old lookup
    // walked the prototype chain: `code: "__proto__"` resolved to
    // `Object.prototype` (truthy) and was then CALLED as a factory, throwing
    // a TypeError from INSIDE the catch block of the error handler — i.e.
    // from the last line of defence. The exception escaped `execute()`
    // entirely and the agent received an unstructured HTTP 500.
    const middleware = errorHandlerMiddleware;
    const definition = { ...mockDefinition };
    return middleware(
      { test: "value" },
      mockContext,
      definition,
      throwingNext(Object.assign(new Error("boom"), { code: "__proto__" })),
    ).then((result) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INTERNAL_ERROR");
      expect(typeof result.error?.message).toBe("string");
    });
  });

  it("does not resolve a prototype member to a NON-ToolResult", () => {
    // `code: "constructor"` resolved to `Object`, was called, and returned a
    // STRING — so `execute()` resolved with `"entity"` and the MCP controller
    // answered 200 with the JSON string `"entity"` as the whole body.
    return errorHandlerMiddleware(
      { test: "value" },
      mockContext,
      mockDefinition,
      throwingNext(Object.assign(new Error("boom"), { code: "constructor" })),
    ).then((result) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INTERNAL_ERROR");
    });
  });

  it("still maps a REAL Prisma code", () => {
    return errorHandlerMiddleware(
      { test: "value" },
      mockContext,
      mockDefinition,
      throwingNext(Object.assign(new Error("boom"), { code: "P2002" })),
    ).then((result) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("DUPLICATE_ENTITY");
    });
  });
});

describe("Audit Log Middleware — durable payload encoding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces an UNPAIRED surrogate so the JSONB write cannot be rejected", async () => {
    // A lone surrogate is a legal JavaScript string but NOT a legal Unicode
    // scalar value: PostgreSQL rejects the whole `jsonb` value with
    // "Unicode low surrogate must follow a high surrogate". The audit write
    // is fire-and-forget, so the row was silently DROPPED — a caller could
    // make specific tool calls disappear from the compliance trail.
    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });
    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(
      { name: "bad\ud800surrogate" },
      mockContext,
      mockDefinition,
      successNext({ success: true, data: "ok" }),
    );

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    const stored = JSON.stringify(createCall[0].data.toolInput);
    expect(stored).not.toContain("\\ud800");
    // JSON.stringify emits the replacement character itself, not an escape.
    expect(stored).toContain("\uFFFD");
  });

  it("caps the tool name written to the unbounded `tool_called` column", async () => {
    // The rejection path records a CALLER-SUPPLIED tool name; the column is
    // an unbounded `text`, so a hallucinated name could write a 100 KB row.
    mockPrisma.aiActionLog.create.mockResolvedValue({ id: "log-id" });
    const middleware = auditLogMiddleware(mockPrisma as any);
    await middleware(
      { test: "value" },
      mockContext,
      { ...mockDefinition, name: "x".repeat(5000) },
      successNext({ success: true, data: "ok" }),
    );

    const createCall = mockPrisma.aiActionLog.create.mock.calls[0];
    expect(createCall[0].data.toolCalled.length).toBeLessThanOrEqual(200);
  });
});

describe("Idempotency Middleware — the TTL is enforced by the middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats an EXPIRED record as absent and re-creates it", async () => {
    // The 24-hour TTL used to be enforced ONLY by the out-of-band cleanup
    // script, which nothing schedules. A `completed` record from months ago
    // was therefore still found and REPLAYED FOREVER, and a `failed` record
    // was reset and the side effect RE-EXECUTED.
    const input = { test: "value" };
    const idempotencyKey = "expired-key";
    const contextWithKey = { ...mockContext, idempotencyKey };
    const expiredAt = new Date(Date.now() - 1000);

    const deleteMock = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue({
            idempotencyKey,
            tenantId: mockContext.tenantId,
            toolName: "test_tool",
            status: "completed",
            inputHash: hashInput(input),
            createdAt: new Date(Date.now() - 100_000),
            expiresAt: expiredAt,
            userId: mockContext.userId,
            agentId: mockContext.agentId ?? null,
          }),
          delete: deleteMock,
          create: vi.fn().mockResolvedValue({ idempotencyKey, status: "pending" }),
        },
      };
      return fn(tx);
    });
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "fresh" }));

    expect(deleteMock).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toBe("fresh");
  });

  it("honours the TTL when an expired record is re-read after a race", async () => {
    // The P2002 path re-reads the record OUTSIDE the failed transaction. An
    // expired record must not be reported as "already in progress".
    const input = { test: "value" };
    const idempotencyKey = "expired-race-key";
    const contextWithKey = { ...mockContext, idempotencyKey };

    // The first attempt loses the insert race (P2002); the re-read finds an
    // EXPIRED row, so the record is treated as absent and the loop retries —
    // the second attempt creates the record and the call proceeds.
    let attempts = 0;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn({
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ idempotencyKey, status: "pending" }),
        },
      });
    });
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
      idempotencyKey,
      tenantId: mockContext.tenantId,
      toolName: "test_tool",
      status: "completed",
      inputHash: hashInput(input),
      createdAt: new Date(Date.now() - 100_000),
      expiresAt: new Date(Date.now() - 1000),
      userId: mockContext.userId,
      agentId: mockContext.agentId ?? null,
    });

    const middleware = idempotencyMiddleware(mockPrisma as any);
    const result = await middleware(input, contextWithKey, mockDefinition, successNext({ success: true, data: "fresh" }));

    expect(result.success).toBe(true);
    expect(result.data).toBe("fresh");
  });
});
