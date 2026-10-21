// Integration tests for the full MCP middleware pipeline.
//
// These tests exercise the REAL production composition — ToolRegistry +
// errorHandler → auditLog → confirmationGate → idempotency → handler — with
// a strict Zod schema, because the individual middlewares are unit-tested in
// isolation elsewhere and that isolation is exactly what let the
// confirmation-gate dead end ship:
//
//   - the confirmation gate injected `confirmation` into the tool INPUT,
//   - every tool schema is a `z.strictObject` that rejects undeclared keys,
//   - so the final Zod step rejected EVERY gated tool with
//     "Unrecognized key(s) in object: 'confirmation'",
//   - and because the idempotency middleware hashes the input through the
//     same strict schema, the parse failed there too and idempotency was
//     silently skipped — no dedup, no record, for every gated write.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../registry/tool-registry.js";
import {
  auditLogMiddleware,
  confirmationGateMiddleware,
  errorHandlerMiddleware,
  idempotencyMiddleware,
} from "../middleware/index.js";
import { ToolContext } from "../schema/tool-definition.js";

interface MockPrisma {
  idempotencyRecord: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  aiActionLog: { create: ReturnType<typeof vi.fn> };
  confirmationGate: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

function createMockPrisma(): MockPrisma {
  const idempotencyRecord = {
    findUnique: vi.fn(),
    create: vi.fn().mockResolvedValue({ idempotencyKey: "key-1", status: "pending" }),
    update: vi.fn().mockResolvedValue({}),
  };
  const aiActionLog = { create: vi.fn().mockResolvedValue({ id: "log-1" }) };
  const confirmationGate = { findUnique: vi.fn().mockResolvedValue({ enabled: true }) };
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: idempotencyRecord.create,
      },
    };
    return fn(tx);
  });
  return { idempotencyRecord, aiActionLog, confirmationGate, $transaction };
}

const baseContext: ToolContext = {
  tenantId: "tenant-acme",
  userId: "user-1",
  services: {},
};

/**
 * Build a registry wired with the production middleware order.
 * Mirrors McpService.onModuleInit().
 */
function createRegistry(prisma: MockPrisma, handler: (input: unknown, ctx: ToolContext) => Promise<{ success: boolean; data?: unknown }>) {
  const registry = new ToolRegistry();
  registry.addGlobalMiddleware(errorHandlerMiddleware);
  registry.addGlobalMiddleware(auditLogMiddleware(prisma as never));
  registry.addGlobalMiddleware(confirmationGateMiddleware(prisma as never));
  registry.addGlobalMiddleware(idempotencyMiddleware(prisma as never));
  registry.register({
    name: "gated_tool",
    description: "A high-risk tool gated by the confirmation gate",
    inputSchema: z.strictObject({
      name: z.string().min(1).max(100),
    }),
    riskLevel: "high",
    entity: "test",
    handler: async (input, ctx) => handler(input, ctx),
  });
  return registry;
}

describe("MCP pipeline integration — confirmation gate", () => {
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("executes a gated tool when a valid confirmation is supplied", async () => {
    const handler = vi.fn(async (input: unknown) => ({ success: true, data: input }));
    const registry = createRegistry(prisma, handler);

    const result = await registry.execute(
      "gated_tool",
      { name: "Jane", confirmation: "Creating a customer for invoice follow-up" },
      baseContext,
    );

    expect(result.success).toBe(true);
    // The handler must receive the SCHEMA-VALIDATED input — the envelope key
    // must not leak into it.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ name: "Jane" }, expect.anything());
  });

  it("keeps idempotency protection enabled for gated tools", async () => {
    // Regression: the confirmation key made the idempotency middleware's
    // input hash fail schema validation, so it skipped deduplication
    // entirely — the duplicate-write the middleware exists to prevent.
    const handler = vi.fn(async (input: unknown) => ({ success: true, data: input }));
    const registry = createRegistry(prisma, handler);

    const result = await registry.execute(
      "gated_tool",
      { name: "Jane", confirmation: "Creating a customer for invoice follow-up", idempotencyKey: "key-1" },
      baseContext,
    );

    expect(result.success).toBe(true);
    expect(prisma.idempotencyRecord.create).toHaveBeenCalledTimes(1);
  });

  it("hashes the input independently of the confirmation wording", async () => {
    // The confirmation is free text that the agent may reword between
    // retries. Because it is stripped before hashing, a reworded retry
    // produces the SAME input hash — otherwise the retry would be rejected
    // with IDEMPOTENCY_KEY_MISMATCH instead of replaying the stored result.
    const hashes: string[] = [];
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async (args: { data: { inputHash: string } }) => {
            hashes.push(args.data.inputHash);
            return { idempotencyKey: "key-1", status: "pending" };
          }),
        },
      };
      return fn(tx);
    });

    const registry = createRegistry(prisma, vi.fn(async (input: unknown) => ({ success: true, data: input })));

    await registry.execute(
      "gated_tool",
      { name: "Jane", confirmation: "Creating a customer for invoice follow-up", idempotencyKey: "key-1" },
      baseContext,
    );
    await registry.execute(
      "gated_tool",
      { name: "Jane", confirmation: "Approved by the account manager on 2026-10-21", idempotencyKey: "key-1" },
      baseContext,
    );

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("rejects a gated tool without a confirmation and does NOT consume the idempotency key", async () => {
    // The gate runs BEFORE the idempotency middleware, so a blocked request
    // never creates an idempotency record — otherwise the agent's next
    // attempt (with a valid confirmation) would be rejected as "already in
    // progress" for the whole stale-pending window.
    const handler = vi.fn(async (input: unknown) => ({ success: true, data: input }));
    const registry = createRegistry(prisma, handler);

    const result = await registry.execute(
      "gated_tool",
      { name: "Jane", idempotencyKey: "key-1" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
    expect(prisma.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("rejects a gated tool whose confirmation is too short", async () => {
    const handler = vi.fn(async (input: unknown) => ({ success: true, data: input }));
    const registry = createRegistry(prisma, handler);

    const result = await registry.execute(
      "gated_tool",
      { name: "Jane", confirmation: "short" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIRMATION");
    expect(handler).not.toHaveBeenCalled();
  });

  it("persists the sanitized confirmation in the durable audit row", async () => {
    const registry = createRegistry(prisma, vi.fn(async (input: unknown) => ({ success: true, data: input })));

    await registry.execute(
      "gated_tool",
      { name: "Jane", confirmation: "<script>alert(1)</script> Creating a customer for invoice follow-up" },
      baseContext,
    );

    expect(prisma.aiActionLog.create).toHaveBeenCalledTimes(1);
    const auditData = prisma.aiActionLog.create.mock.calls[0]![0].data;
    const confirmation = auditData.toolInput.confirmation as string;
    expect(confirmation).not.toContain("<script>");
    expect(confirmation).not.toContain("alert");
    expect(confirmation).toContain("Creating a customer");
  });

  it("ignores a confirmation on a non-gated tool without failing schema validation", async () => {
    // Before the fix, an agent that passed `confirmation` to a low-risk tool
    // got "Unrecognized key(s) in object: 'confirmation'" — the envelope key
    // is now stripped for every tool.
    const registry = new ToolRegistry();
    registry.addGlobalMiddleware(errorHandlerMiddleware);
    registry.register({
      name: "plain_tool",
      description: "A low-risk tool",
      inputSchema: z.strictObject({ name: z.string().min(1).max(100) }),
      riskLevel: "low",
      handler: async (input) => ({ success: true, data: input }),
    });

    const result = await registry.execute(
      "plain_tool",
      { name: "Jane", confirmation: "Just because" },
      baseContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "Jane" });
  });
});
