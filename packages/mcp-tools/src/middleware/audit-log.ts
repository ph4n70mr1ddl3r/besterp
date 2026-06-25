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
import { getErrorCode, sanitizeForLog, sanitizeLogOutput, MAX_REASONING_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolContext, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE } from "./truncate.js";

/** Fields whose values must be redacted before persisting in the audit log. */
const SENSITIVE_FIELDS = new Set([
  "password", "passwd", "secret", "token", "api_key", "apiKey",
  "authorization", "creditCard", "credit_card", "ssn", "taxId", "tax_id",
  "access_token", "refresh_token", "session_id", "sessionId",
  "private_key", "privateKey", "secret_key", "secretKey",
  "accessKey", "access_key", "encryption_key", "encryptionKey",
  // ERP-specific sensitive fields. birthDate/birth_date are the camelCase
  // field names that actually flow through MCP tool inputs and the Person
  // subtype — date_of_birth/dob alone miss them, leaking DOB (sensitive PII)
  // into ai_action_log.tool_input.
  "pin", "cc_number", "card_number", "date_of_birth", "dob",
  "birthDate", "birth_date",
  "bank_account", "routing_number", "national_id", "passport",
]);

/** Regex pattern for catch-all sensitive field detection (password, secret, token, key, etc.). */
const SENSITIVE_FIELD_PATTERN = /\b(password|secret|token|api[_-]?key|credential|auth)\b/i;

/** Audit log uses the same 64 KB cap as other stored payloads. */
const MAX_AUDIT_INPUT_SIZE = MAX_STORED_PAYLOAD_SIZE;
const MAX_AUDIT_OUTPUT_SIZE = MAX_STORED_PAYLOAD_SIZE;

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
    toolInput: input,
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
      toolOutput: { error: { message: sanitizeLogOutput(error instanceof Error ? error.message : String(error)), code: getErrorCode(error) } },
    });
    throw error;
  }

  backpressure.log({ ...base, toolOutput: result.data ?? null });
  return result;
}

// ─── Backpressure Manager ────────────────────────────────────────

interface BackpressureManager {
  log(entry: AuditLogEntry): void;
}

function createBackpressureManager(prisma: PrismaClient): BackpressureManager {
  let activeWrites = 0;
  const writeQueue: Array<{ resolve: (value: { acquired: boolean }) => void; timer: ReturnType<typeof setTimeout>; settled?: boolean }> = [];
  let droppedCount = 0;
  let errorCount = 0;

  function acquireWriteSlot(): Promise<{ acquired: boolean }> {
    if (activeWrites < MAX_CONCURRENT_AUDIT_WRITES) {
      activeWrites++;
      return Promise.resolve({ acquired: true });
    }
    return new Promise<{ acquired: boolean }>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = writeQueue.findIndex((entry) => entry.timer === timer);
        if (idx !== -1) writeQueue.splice(idx, 1);
        process.stderr.write(`[AuditLog] Write slot timeout after ${WRITE_QUEUE_TIMEOUT_MS}ms — dropping audit entry\n`);
        resolve({ acquired: false });
      }, WRITE_QUEUE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      writeQueue.push({ resolve, timer, get settled() { return settled; } });
    });
  }

  function releaseWriteSlot(): void {
    if (activeWrites > 0) activeWrites--;
    while (writeQueue.length > 0) {
      const next = writeQueue.shift()!;
      clearTimeout(next.timer);
      if (next.settled) continue;
      activeWrites++;
      next.resolve({ acquired: true });
      return;
    }
  }

  return {
    log(entry: AuditLogEntry): void {
      if (writeQueue.length >= MAX_AUDIT_QUEUE_SIZE) {
        droppedCount++;
        process.stderr.write(`[AuditLog] Queue full (${MAX_AUDIT_QUEUE_SIZE}), dropping audit entry for '${sanitizeForLog(entry.toolCalled)}' (total dropped: ${droppedCount})\n`);
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
            error: logErr instanceof Error ? logErr.message : String(logErr),
            totalErrors: errorCount,
          };
          process.stderr.write(`[AuditLog] ${JSON.stringify(errorMeta)}\n`);
        })
        .finally(() => {
          if (slotAcquired) releaseWriteSlot();
        });
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
  const toolInput = truncateValue(redactSensitiveFields(entry.toolInput), MAX_AUDIT_INPUT_SIZE);

  await prisma.aiActionLog.create({
    data: {
      agentId: entry.agentId || null,
      conversationId: entry.conversationId || null,
      userId: entry.userId,
      tenantId: entry.tenantId,
      toolCalled: entry.toolCalled,
      toolInput: toolInput as unknown as Prisma.InputJsonValue,
      toolOutput: truncateValue(redactSensitiveFields(entry.toolOutput), MAX_AUDIT_OUTPUT_SIZE) as Prisma.InputJsonValue | undefined,
      reasoning: entry.reasoning ?? null,
    },
  });
}

/** Returns true if a field name matches a sensitive pattern. */
function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key) || SENSITIVE_FIELD_PATTERN.test(key);
}

function redactSensitiveFields(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (depth > 10 || value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Date || value instanceof RegExp) return value;
  seen = seen ?? new WeakSet();
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1, seen));
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([k, v]) => {
      const redactedKey = (typeof k === "string" && isSensitiveField(k)) ? "[REDACTED]" : k;
      return [redactedKey, redactSensitiveFields(v, depth + 1, seen)];
    }));
  }
  if (value instanceof Set) {
    return new Set([...value].map((v) => redactSensitiveFields(v, depth + 1, seen)));
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveField(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitiveFields(val, depth + 1, seen);
    }
  }
  return result;
}
