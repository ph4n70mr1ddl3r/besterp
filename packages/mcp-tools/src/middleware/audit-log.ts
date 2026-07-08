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

/**
 * Regex pattern for catch-all sensitive field detection (password, secret,
 * token, key, etc.).
 *
 * Boundary notes: `\b` is NOT used because `_` is a word character under `\w`,
 * so `\btoken\b` would NOT match `session_token`, `auth_token`, `bearer_token`,
 * `id_token`, or `client_secret` — there is no word boundary between `_` and
 * the keyword. We instead delimit the keyword with alnum-only lookarounds
 * (`(?<![a-z0-9])` / `(?![a-z0-9])`), which treat `_` and `-` as separators.
 * This catches both snake_case (`auth_token`, `client_secret`) and camelCase
 * (`authToken`) sensitive names while still rejecting infix matches inside
 * unrelated words.
 *
 * The `auth` subgroup accepts an optional snake/camel `token|key|code` suffix
 * (`auth_token`, `authKey`, bare `auth`), mirroring the `api[_-]?key` form.
 */
const SENSITIVE_FIELD_PATTERN = /(?<![a-z0-9])(password|secret|token|api[_-]?key|credential|auth(?:token|key|code|[_-](?:token|key|code))?)(?![a-z0-9])/i;

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
  const writeQueue: Array<{ resolve: (value: { acquired: boolean }) => void; timer: ReturnType<typeof setTimeout>; settled: boolean }> = [];
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
      timer.unref();
      writeQueue.push({ resolve, timer, settled: false });
    });
  }

  function releaseWriteSlot(): void {
    if (activeWrites > 0) activeWrites--;
    while (writeQueue.length > 0) {
      const next = writeQueue.shift()!;
      clearTimeout(next.timer);
      if (next.settled) continue;
      next.settled = true;
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
            // Sanitize: a failed audit write is typically a Prisma/driver error
            // whose message can embed a connection string or hostname. This
            // path writes to stderr (operator logs) — strip infra details the
            // same way the error-handler and shutdown paths do.
            error: sanitizeLogOutput(logErr instanceof Error ? logErr.message : String(logErr)),
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
      toolOutput: truncateValue(redactSensitiveFields(entry.toolOutput), MAX_STORED_PAYLOAD_SIZE) as Prisma.InputJsonValue | undefined,
      reasoning: entry.reasoning ?? null,
    },
  });
}

/** Returns true if a field name matches a sensitive pattern. */
function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key) || SENSITIVE_FIELD_PATTERN.test(key);
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

function isTerminal(value: unknown, depth: number): boolean {
  return depth > MAX_REDACTION_DEPTH || value === null || value === undefined || typeof value !== "object"
    || value instanceof Date || value instanceof RegExp;
}

function redactSensitiveFields(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (isTerminal(value, depth)) return value;
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
