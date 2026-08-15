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
import { getErrorCode, sanitizeLogMessage, sanitizeForLogOutput, stripHtmlTags, MAX_REASONING_LENGTH, MAX_SOFT_FAILURE_MESSAGE_SIZE, redactSensitiveFieldValues, MAX_CONCURRENT_AUDIT_WRITES, MAX_AUDIT_QUEUE_SIZE, AUDIT_WRITE_QUEUE_TIMEOUT_MS, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolContext, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, capString, MAX_STORED_PAYLOAD_SIZE } from "./truncate.js";

const AUDIT_DROP_WARNING =
  "Some audit log entries were dropped due to high load. The operation succeeded but the durable audit trail may be incomplete.";

/**
 * Attach the audit-drop warning to a tool result without corrupting the
 * payload.
 *
 * Object-spreading a non-object result would corrupt it: spreading a string
 * produces numeric index keys (`"ok"` → `{ 0: "o", 1: "k" }`), a number is
 * silently discarded, and an array's indices become keys. Only merge the
 * warning INTO a plain-object result; for scalar/array results wrap the
 * warning alongside the original value so the agent sees both the warning and
 * the uncorrupted data.
 */
export function attachAuditWarning(result: ToolResult, warning = AUDIT_DROP_WARNING): ToolResult {
  const data = result.data;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    // Spread the tool's own fields first, then set `_auditWarning` LAST so a
    // tool result that happens to carry its own `_auditWarning` key cannot
    // overwrite the injected audit-gap warning — the compliance-critical
    // notice (backpressure drops) must always win.
    return { ...result, data: { ...(data as Record<string, unknown>), _auditWarning: warning } };
  }
  if (data != null) {
    return { ...result, data: { _auditWarning: warning, data } };
  }
  return { ...result, data: { _auditWarning: warning } };
}

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
  // `reasoning` originates from the AI agent / tool-call context, which is
  // attacker-influenceable (any string may be supplied in the MCP request
  // body). It is persisted verbatim to ai_action_log.reasoning, a durable
  // cross-tenant audit sink, so a connection string, JWT, or api_key query
  // param embedded in it would leak to the durable row even though every
  // other durable sink (toolInput, toolOutput) and every agent-facing
  // surface is sanitized. Sanitize FIRST, then trim to the length cap so a
  // secret in the tail is still scrubbed (sanitizeForLogOutput collapses
  // URLs/secrets regardless of position). Mirrors the toolInput handling.
  const reasoning = context.reasoning
    ? sanitizeForLogOutput(context.reasoning).slice(0, MAX_REASONING_LENGTH)
    : null;
  // `userId`/`agentId`/`conversationId` originate from the caller's MCP request
  // and are persisted verbatim to the cross-tenant `ai_action_log` durable sink.
  // A caller could embed a secret (connection string, `?api_key=…`) in any of
  // these fields, so sanitize them the same way `reasoning` is — via
  // `sanitizeForLogOutput` — before the row is written. `stripHtmlTags` is
  // applied first (HTML can hide secret-shaped patterns from the redactor) and
  // the length cap prevents oversized identity fields from bloating the row.
  const userId = sanitizeForLogOutput(stripHtmlTags(context.userId)).slice(0, MAX_USER_ID_LENGTH);
  const agentId = context.agentId !== undefined
    ? sanitizeForLogOutput(stripHtmlTags(context.agentId)).slice(0, MAX_AGENT_ID_LENGTH)
    : undefined;
  const conversationId = context.conversationId !== undefined
    ? sanitizeForLogOutput(stripHtmlTags(context.conversationId)).slice(0, MAX_CONVERSATION_ID_LENGTH)
    : undefined;
  return {
    agentId,
    conversationId,
    reasoning,
    userId,
    // tenantId is intentionally stored verbatim (no sanitizeForLogOutput):
    // validateTenantIdEnhancedForAuth (called at the auth boundary in
    // jwt.strategy.ts and tenant.guard.ts) enforces TENANT_ID_PATTERN
    // (/^[a-zA-Z0-9_-]+$/), so the value can only contain alphanumeric chars
    // and hyphens — it cannot embed secrets, connection strings, or HTML. The
    // other identity fields (userId, agentId, conversationId) use free-form
    // strings that are not charset-restricted, so they require sanitization.
    tenantId: context.tenantId,
    toolCalled: definition.name,
    toolInput: redactSensitiveFields(input),
  };
}

/**
 * Shape a soft-failure result's error into the durable `toolOutput` payload.
 *
 * Extracted so `executeAndLog` stays within the lint complexity cap. Mirrors
 * the throw branch (sanitized + capped message and code) so the ai_action_log
 * row captures failure detail on the path that ACTUALLY fires in production —
 * the OUTERMOST errorHandlerMiddleware converts every thrown error into a
 * non-thrown ToolResult, so the throw branch never runs for real failures.
 * `code` is redacted to `[REDACTED]` at the durable sink the same way it is
 * for the throw branch, because `code` is a sensitive field name.
 */
function formatSoftFailureOutput(result: ToolResult): { error: { message: string | null; code: string | undefined } } {
  return {
    error: {
      message: result.error?.message
        ? capString(sanitizeForLogOutput(result.error.message), MAX_SOFT_FAILURE_MESSAGE_SIZE)
        : null,
      code: result.error?.code
        ? capString(sanitizeForLogOutput(result.error.code), MAX_SOFT_FAILURE_MESSAGE_SIZE) || undefined
        : undefined,
    },
  };
}

async function executeAndLog(prisma: PrismaClient, backpressure: BackpressureManager, input: unknown, context: ToolContext, definition: { name: string }, next: (input: unknown, context: ToolContext) => Promise<ToolResult>): Promise<ToolResult> {
  if (!prisma?.aiActionLog) {
    try {
      process.stderr.write(`[AuditLog] ${JSON.stringify({ timestamp: new Date().toISOString(), message: "Prisma client not available — skipping audit log" })}\n`);
    } catch {
      // stderr may be closed — suppress to prevent uncaught exception.
    }
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
      toolOutput: { error: { message: capString(sanitizeForLogOutput(error instanceof Error ? error.message : String(error)), MAX_SOFT_FAILURE_MESSAGE_SIZE), code: capString(sanitizeForLogOutput(getErrorCode(error) ?? ""), MAX_SOFT_FAILURE_MESSAGE_SIZE) || undefined } },
    });
    throw error;
  }

  // Soft-failure results (success:false) are the path that ACTUALLY fires in
  // production: the OUTERMOST errorHandlerMiddleware converts every thrown
  // error into a non-thrown ToolResult before the throw branch above could run,
  // so real failures (validation, domain, Prisma) never reach it and would be
  // persisted with `toolOutput: null` — losing every failure's error from the
  // durable ai_action_log trail. Persist the sanitized error detail instead,
  // mirroring the throw branch (code is redacted to [REDACTED] at the sink the
  // same way, since `code` is a sensitive field name).
  backpressure.log({
    ...base,
    toolOutput: result.success ? result.data ?? null : formatSoftFailureOutput(result),
  });

  // If audit entries were dropped due to backpressure, surface a non-fatal
  // warning to the agent so it knows the durable audit trail has a gap. This
  // is critical for compliance-sensitive ERP systems where silent audit loss
  // is a regulatory issue. The warning does NOT affect success/data — the
  // tool still completed successfully; only the audit side-effect was lost.
  if (backpressure.wasDropDetected()) {
    result = attachAuditWarning(result);
  }

  // The success payload returned to the AI agent must be redacted the SAME
  // way the durable sinks (audit row via truncateValue(redactSensitiveFields…)
  // and idempotency replay via redactSensitiveFields) are. Without this, a
  // tool returning a value under a sensitive-named key (e.g. a credential)
  // leaks to the agent live on the first call, while the identical value is
  // redacted when persisted or replayed — an asymmetric secret-leak path.
  if (result.success && result.data != null) {
    result = { ...result, data: redactSensitiveFields(result.data) };
  }
  // `nextActions` is an agent-facing string array constructed by handlers from
  // user input (e.g. an interpolated `roleType`). It is NOT part of `data`, so
  // the redaction above leaves it untouched — and it is excluded from the
  // error-handler's `context` redaction too. Sanitize every element the same
  // way the durable/agent surfaces scrub strings, so a secret embedded in a
  // handler-built `nextActions` entry cannot reach the agent verbatim.
  if (Array.isArray(result.nextActions) && result.nextActions.length > 0) {
    result = {
      ...result,
      nextActions: result.nextActions.map((n) =>
        typeof n === "string" ? sanitizeForLogOutput(stripHtmlTags(n)) : n,
      ),
    };
  }
  return result;
}

// ─── Backpressure Manager ────────────────────────────────────────

interface BackpressureManager {
  log(entry: AuditLogEntry): void;
  wasDropDetected(): boolean;
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
  let dropDetected = false;

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
          // Set settled BEFORE splicing to prevent a TOCTOU race where
          // releaseWriteSlot() could shift this entry out of the queue and
          // resolve it after the timeout has already marked it settled.
          entry.settled = true;
          const idx = writeQueue.indexOf(entry);
          if (idx !== -1) writeQueue.splice(idx, 1);
          // Count slot-timeout drops the same way queue-full drops are counted
          // (droppedCount/dropDetected) so the drop-detector consumed by
          // executeAndLog (wasDropDetected → agent-facing audit-gap warning)
          // reflects them. Previously only the queue-full path bumped these
          // counters, so a sustained write-slot stall was silently lost.
          droppedCount++;
          dropDetected = true;
          try {
            process.stderr.write(`[AuditLog] Write slot timeout after ${AUDIT_WRITE_QUEUE_TIMEOUT_MS}ms — dropping audit entry (total dropped: ${droppedCount})\n`);
          } catch {
            // stderr may be closed.
          }
          resolve({ acquired: false });
        }, AUDIT_WRITE_QUEUE_TIMEOUT_MS);
        entry.timer.unref();
      } catch {
        // setTimeout can fail under extreme memory pressure — drop immediately
        // rather than leaving the entry in the queue without a timer.
        droppedCount++;
        dropDetected = true;
        try {
          process.stderr.write(`[AuditLog] Failed to create timeout for write slot — dropping audit entry (total dropped: ${droppedCount})\n`);
        } catch {
          // stderr may be closed.
        }
        resolve({ acquired: false });
        return;
      }
      writeQueue.push(entry);
    });
  }

  function releaseWriteSlot(): void {
    if (activeWrites <= 0) {
      try {
        process.stderr.write(`[AuditLog] releaseWriteSlot called with activeWrites=${activeWrites} — possible double-release, ignoring\n`);
      } catch {
        // stderr may be closed.
      }
      return;
    }
    activeWrites--;
    if (writeQueue.length > 0) {
      const next = writeQueue.shift() as QueueEntry;
      // Guard against double-release: if the timeout already settled this
      // entry (and removed it from the queue) before releaseWriteSlot was
      // called, next.settled is true and we must not resolve it again.
      if (next.settled) return;
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
        dropDetected = true;
        try {
          process.stderr.write(`[AuditLog] Queue full (${MAX_AUDIT_QUEUE_SIZE}), dropping audit entry for '${sanitizeLogMessage(entry.toolCalled)}' (total dropped: ${droppedCount})\n`);
        } catch {
          // stderr may be closed.
        }
        return;
      }
      let slotAcquired = false;
      // Top-level .catch prevents unhandledRejection if logAction throws
      // synchronously before returning a promise. The inner .catch only
      // handles async rejections from within the .then() callback.
      acquireWriteSlot()
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
          try {
            process.stderr.write(`[AuditLog] ${JSON.stringify(errorMeta)}\n`);
          } catch {
            // stderr may be closed.
          }
        })
        .finally(() => {
          try {
            if (slotAcquired) releaseWriteSlot();
          } catch {
            // releaseWriteSlot should never throw; suppress to prevent
            // the outer .catch from swallowing the original error log.
          }
        })
        .catch(() => {
          // Suppress any top-level rejection to prevent unhandledRejection.
          // This is a fire-and-forget path; errors are already logged above.
        });
    },
    wasDropDetected() {
      const detected = dropDetected;
      dropDetected = false;
      return detected;
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
  const toolOutput = truncateValue(redactSensitiveFieldValues(entry.toolOutput), MAX_STORED_PAYLOAD_SIZE);

  await prisma.aiActionLog.create({
    data: {
      agentId: entry.agentId ?? null,
      conversationId: entry.conversationId ?? null,
      userId: entry.userId,
      tenantId: entry.tenantId,
      toolCalled: entry.toolCalled,
      // Prisma's Json columns reject a bare JS null/undefined ("Provided Json
      // null, expected JsonNull or DbNull") — without these guards, a
      // successful tool with no data (result.data ?? null) or a tool invoked
      // with no input (redactSensitiveFields(undefined) → undefined) made the
      // create() call itself throw, and the fire-and-forget catch meant the
      // durable audit row was silently dropped for every such call. Mirror
      // idempotency.ts: JSON null for the REQUIRED toolInput column (DbNull
      // would violate the NOT NULL constraint), database NULL for the
      // nullable toolOutput column.
      toolInput: (toolInput === null || toolInput === undefined ? Prisma.JsonNull : toolInput) as unknown as Prisma.InputJsonValue,
      toolOutput: (toolOutput === null || toolOutput === undefined ? Prisma.DbNull : toolOutput) as unknown as Prisma.InputJsonValue | undefined,
      reasoning: entry.reasoning ?? null,
    },
  });
}

/**
 * Redact sensitive fields in audit-log payloads.
 *
 * Delegates to the canonical shared `redactSensitiveFieldValues` so the MCP
 * audit surface cannot diverge from the REST canonical redactor. The shared
 * redactor handles Map/Set conversion, cycle detection, depth capping, and
 * key-based redaction — keeping this middleware a thin passthrough.
 */
export function redactSensitiveFields(value: unknown): unknown {
  return redactSensitiveFieldValues(value);
}
