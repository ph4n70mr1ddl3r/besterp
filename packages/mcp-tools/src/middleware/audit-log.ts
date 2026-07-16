// Audit Log Middleware — Logs all AI agent actions for traceability.
//
// Implements Principle 8 from AGENTIC_AI_DESIGN.md: Every action is auditable
// for AI traceability. Captures who (human), what (agent), why (reasoning),
// and how (tools called).
//
// This is a "fire-and-forget" middleware — it logs asynchronously and never
// blocks tool execution. Log failures are silently ignored (audit should
// never break the tool).

import { PrismaClient, Prisma } from "@prisma/client";
import { getErrorCode, sanitizeLogMessage, sanitizeForLogOutput, MAX_REASONING_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolContext, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE } from "./truncate.js";
import { isSensitiveField } from "./sensitive-fields.js";

/** Maximum depth for recursive sensitive field redaction. */
const MAX_REDACTION_DEPTH = 10;

/** Maximum concurrent audit log writes to prevent memory pressure under DB slowdown. */
const MAX_CONCURRENT_AUDIT_WRITES = 100;
/** Maximum queued audit entries before dropping to prevent unbounded memory growth. */
const MAX_AUDIT_QUEUE_SIZE = 1000;
/** Maximum time (ms) a write can wait in the queue before being dropped. */
const WRITE_QUEUE_TIMEOUT_MS = 5_000;

/**
 * Create an audit log middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, for cross-tenant audit writes)
 */
export function auditLogMiddleware(prisma: PrismaClient): ToolMiddleware {
  const backpressure = createBackpressureManager(prisma);

  return (input, context, definition, next) => executeAndLog(prisma, backpressure, input, context, definition, next);
}

function createBaseEntry(context: { agentId?: string; conversationId?: string; reasoning?: string; userId: string; tenantId: string }, definition: { name: string }, input: unknown): Omit<AuditLogEntry, "toolOutput"> {
  return {
    agentId: context.agentId,
    conversationId: context.conversationId,
    reasoning: context.reasoning?.slice(0, MAX_REASONING_LENGTH) ?? null,
    userId: context.userId,
    tenantId: context.tenantId,
    toolCalled: definition.name,
    toolInput: redactSensitiveFields(input),
  };
}

async function executeAndLog(prisma: PrismaClient, backpressure: BackpressureManager, input: unknown, context: ToolContext, definition: { name: string }, next: (input: unknown, context: ToolContext) => Promise<ToolResult>): Promise<ToolResult> {
  if (!prisma?.aiActionLog) {
    const warnMeta = {
      timestamp: new Date().toISOString(),
      message: "Prisma client not available — skipping audit log",
    };
    process.stderr.write(`[AuditLog] ${JSON.stringify(warnMeta)}\n`);
    return next(input, context);
  }

  const base = createBaseEntry(context, definition, input);
  let result: ToolResult;
  try {
    result = await next(input, context);
  } catch (error: unknown) {
    // Sanitize before persisting: a thrown Prisma/driver error can embed a
    // connection string or hostname in its message. Unlike the stderr path
    // (handled by errorHandlerMiddleware), this value lands in the durable
    // ai_action_log table, so we strip it the same way shutdown/log paths do.
    backpressure.log({
      ...base,
      toolOutput: { error: { message: sanitizeForLogOutput(error instanceof Error ? error.message : String(error)), code: getErrorCode(error) } },
    });
    throw error;
  }

  backpressure.log({ ...base, toolOutput: result.data ?? null });
  return result;
}

// ─── Backpressure Manager ────────────────────────────────────────

interface BackpressureManager {
  log(entry: AuditLogEntry): void;
  getStats(): { activeWrites: number; queueLength: number; droppedCount: number; errorCount: number };
}

function createBackpressureManager(prisma: PrismaClient): BackpressureManager {
  let activeWrites = 0;
  interface QueueEntry {
    resolve: (value: { acquired: boolean }) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    settled: boolean;
  }
  const writeQueue: QueueEntry[] = [];
  let droppedCount = 0;
  let errorCount = 0;

  function acquireWriteSlot(): Promise<{ acquired: boolean }> {
    if (activeWrites < MAX_CONCURRENT_AUDIT_WRITES) {
      activeWrites++;
      return Promise.resolve({ acquired: true });
    }
    return new Promise<{ acquired: boolean }>((resolve) => {
      const entry: QueueEntry = { resolve, timer: undefined, settled: false };
      try {
        entry.timer = setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          const idx = writeQueue.indexOf(entry);
          if (idx !== -1) writeQueue.splice(idx, 1);
          process.stderr.write(`[AuditLog] Write slot timeout after ${WRITE_QUEUE_TIMEOUT_MS}ms — dropping audit entry\n`);
          resolve({ acquired: false });
        }, WRITE_QUEUE_TIMEOUT_MS);
        entry.timer.unref();
      } catch {
        // setTimeout can fail under extreme memory pressure — drop immediately
        // rather than leaving the entry in the queue without a timer.
        process.stderr.write(`[AuditLog] Failed to create timeout for write slot — dropping audit entry\n`);
        resolve({ acquired: false });
        return;
      }
      writeQueue.push(entry);
    });
  }

  function releaseWriteSlot(): void {
    if (activeWrites <= 0) {
      process.stderr.write(`[AuditLog] releaseWriteSlot called with activeWrites=${activeWrites} — possible double-release, ignoring\n`);
      return;
    }
    activeWrites--;
    if (writeQueue.length > 0) {
      const next = writeQueue.shift()!;
      clearTimeout(next.timer);
      next.settled = true;
      activeWrites++;
      next.resolve({ acquired: true });
    }
  }

  return {
    log(entry: AuditLogEntry): void {
      if (writeQueue.length >= MAX_AUDIT_QUEUE_SIZE) {
        droppedCount++;
        process.stderr.write(`[AuditLog] Queue full (${MAX_AUDIT_QUEUE_SIZE}), dropping audit entry for '${sanitizeLogMessage(entry.toolCalled)}' (total dropped: ${droppedCount})\n`);
        return;
      }
      let slotAcquired = false;
      void acquireWriteSlot()
        .then(({ acquired }) => {
          if (!acquired) return;
          slotAcquired = true;
          return logAction(prisma, entry);
        })
        .catch((logErr) => {
          errorCount++;
          const errorMeta = {
            timestamp: new Date().toISOString(),
            tool: entry.toolCalled,
            tenant: entry.tenantId,
            user: entry.userId,
            // Sanitize: a failed audit write is typically a Prisma/driver error
            // whose message can embed a connection string or hostname. This
            // path writes to stderr (operator logs) — strip infra details the
            // same way the error-handler and shutdown paths do.
            error: sanitizeForLogOutput(logErr instanceof Error ? logErr.message : String(logErr)),
            totalErrors: errorCount,
          };
          process.stderr.write(`[AuditLog] ${JSON.stringify(errorMeta)}\n`);
        })
        .finally(() => {
          if (slotAcquired) releaseWriteSlot();
        });
    },
    getStats() {
      return { activeWrites, queueLength: writeQueue.length, droppedCount, errorCount };
    },
  };
}

interface AuditLogEntry {
  agentId?: string;
  conversationId?: string;
  userId: string;
  tenantId: string;
  toolCalled: string;
  toolInput: unknown;
  toolOutput: unknown;
  reasoning?: string | null;
}

async function logAction(prisma: PrismaClient, entry: AuditLogEntry): Promise<void> {
  // toolInput is already redacted by createBaseEntry() before it reaches the
  // backpressure queue, so re-running redactSensitiveFields here would traverse
  // the (potentially large) object graph a second time for no effect. Only
  // toolOutput needs redaction — it is added raw in executeAndLog().
  const toolInput = truncateValue(entry.toolInput, MAX_STORED_PAYLOAD_SIZE);

  await prisma.aiActionLog.create({
    data: {
      agentId: entry.agentId ?? null,
      conversationId: entry.conversationId ?? null,
      userId: entry.userId,
      tenantId: entry.tenantId,
      toolCalled: entry.toolCalled,
      toolInput: toolInput as unknown as Prisma.InputJsonValue,
      toolOutput: truncateValue(redactSensitiveFields(entry.toolOutput), MAX_STORED_PAYLOAD_SIZE) as unknown as Prisma.InputJsonValue | undefined,
      reasoning: entry.reasoning ?? null,
    },
  });
}

function redactMap(value: Map<unknown, unknown>, depth: number, seen: WeakSet<object>): unknown {
  // Convert to array of [key, value] pairs: Map is not JSON-native, so
  // returning a Map would be serialised as {} by JSON.stringify, silently
  // dropping the data from the audit record. An array of entries survives
  // serialisation and preserves the iterable semantics.
  return [...value.entries()].map(([k, v]) => {
    if (typeof k === "string" && isSensitiveField(k)) {
      return ["[REDACTED]", "[REDACTED]"];
    }
    return [k, redactSensitiveFields(v, depth + 1, seen)];
  });
}

function redactSet(value: Set<unknown>, depth: number, seen: WeakSet<object>): unknown {
  // Convert to array: same JSON-serialisation rationale as Map above.
  return [...value].map((v) => redactSensitiveFields(v, depth + 1, seen));
}

function isTerminal(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object"
    || value instanceof Date || value instanceof RegExp;
}

export function redactSensitiveFields(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  // Depth guard: once we exceed MAX_REDACTION_DEPTH, stop descending and
  // return a placeholder. Returning the raw value here (the previous
  // behaviour, via the depth clause in isTerminal) would bypass the
  // key-name redaction loop below — so a sensitive field buried deeper
  // than the cap (e.g. `password` 11 levels down) would be persisted
  // verbatim to ai_action_log. That is a defense-in-depth gap in a
  // security-sensitive redaction path. Mirrors the error-handler's
  // sanitizeContextValue depth guard ("[Too deep]").
  if (depth > MAX_REDACTION_DEPTH) return "[Too deep]";
  if (isTerminal(value)) return value;
  seen = seen ?? new WeakSet();
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1, seen));
  if (value instanceof WeakMap || value instanceof WeakSet) return "[WeakCollection]";
  if (value instanceof Map) return redactMap(value, depth, seen);
  if (value instanceof Set) return redactSet(value, depth, seen);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveField(key) ? "[REDACTED]" : redactSensitiveFields(val, depth + 1, seen);
  }
  return result;
}
