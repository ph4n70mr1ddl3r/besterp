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
import { getErrorCode, MAX_REASONING_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE } from "./truncate.js";

/** Fields whose values must be redacted before persisting in the audit log. */
const SENSITIVE_FIELDS = new Set([
  "password", "passwd", "secret", "token", "api_key", "apiKey",
  "authorization", "creditCard", "credit_card", "ssn", "taxId", "tax_id",
  "access_token", "refresh_token", "session_id", "sessionId",
  "private_key", "privateKey", "secret_key", "secretKey",
  "accessKey", "access_key", "encryption_key", "encryptionKey",
  // ERP-specific sensitive fields
  "pin", "cc_number", "card_number", "date_of_birth", "dob",
  "bank_account", "routing_number", "national_id", "passport",
]);

/** Regex pattern for catch-all sensitive field detection (password, secret, token, key, etc.). */
const SENSITIVE_FIELD_PATTERN = /password|secret|token|key|credential|auth/i;

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
  // Semaphore to limit concurrent audit log writes and prevent unbounded
  // promise accumulation if the database is slow or unavailable.
  let activeWrites = 0;
    const writeQueue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  function acquireWriteSlot(): Promise<void> {
    if (activeWrites < MAX_CONCURRENT_AUDIT_WRITES) {
      activeWrites++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Remove from queue and resolve — the entry will be dropped
        const idx = writeQueue.findIndex((entry) => entry.timer === timer);
        if (idx !== -1) writeQueue.splice(idx, 1);
        process.stderr.write(`[AuditLog] Write slot timeout after ${WRITE_QUEUE_TIMEOUT_MS}ms — dropping audit entry\n`);
        // Don't increment activeWrites — just let it resolve without writing.
        // slotAcquired remains false in logWithBackpressure, so releaseWriteSlot
        // is NOT called in .finally().
        resolve();
      }, WRITE_QUEUE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      writeQueue.push({ resolve, timer });
    });
  }

  function releaseWriteSlot(): void {
    activeWrites--;
    if (writeQueue.length > 0) {
      const next = writeQueue.shift();
      if (next) {
        clearTimeout(next.timer);
        activeWrites++;
        next.resolve();
      }
    }
  }

  function logWithBackpressure(entry: AuditLogEntry): void {
    if (writeQueue.length >= MAX_AUDIT_QUEUE_SIZE) {
      process.stderr.write(`[AuditLog] Queue full (${MAX_AUDIT_QUEUE_SIZE}), dropping audit entry for '${entry.toolCalled}'\n`);
      return;
    }
    let slotAcquired = false;
    void acquireWriteSlot()
      .then(() => {
        slotAcquired = true;
        return logAction(prisma, entry);
      })
      .catch((logErr) => {
        const errorMeta = {
          timestamp: new Date().toISOString(),
          tool: entry.toolCalled,
          tenant: entry.tenantId,
          user: entry.userId,
          error: logErr instanceof Error ? logErr.message : String(logErr),
        };
        process.stderr.write(`[AuditLog] ${JSON.stringify(errorMeta)}\n`);
      })
      .finally(() => {
        // Only release the slot if it was actually acquired (not on timeout-drop).
        // Timed-out entries resolve without incrementing activeWrites, so
        // calling releaseWriteSlot would decrement the counter below zero.
        if (!slotAcquired) return;
        releaseWriteSlot();
      });
  }

  return async (input, context, definition, next) => {
    // Guard against misconfigured middleware (e.g., null prisma).
    if (!prisma?.aiActionLog) {
      const warnMeta = {
        timestamp: new Date().toISOString(),
        message: "Prisma client not available — skipping audit log",
      };
      process.stderr.write(`[AuditLog] ${JSON.stringify(warnMeta)}\n`);
      return next(input, context);
    }

    function baseEntry(): Omit<AuditLogEntry, "toolOutput"> {
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

    let result: ToolResult;
    try {
      result = await next(input, context);
    } catch (error: unknown) {
      logWithBackpressure({
        ...baseEntry(),
        toolOutput: { error: { message: error instanceof Error ? error.message : String(error), code: getErrorCode(error) } },
      });

      throw error;
    }

    logWithBackpressure({
      ...baseEntry(),
      toolOutput: result.data ?? null,
    });

    return result;
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

function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1));
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([k, v]) => [k, redactSensitiveFields(v, depth + 1)]));
  }
  if (value instanceof Set) {
    return new Set([...value].map((v) => redactSensitiveFields(v, depth + 1)));
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(key) || SENSITIVE_FIELD_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitiveFields(val, depth + 1);
    }
  }
  return result;
}
