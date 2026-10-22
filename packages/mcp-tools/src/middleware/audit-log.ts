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
import { getErrorCode, sanitizeLogMessage, sanitizeForLogOutput, stripHtmlTags, MAX_REASONING_LENGTH, MAX_SOFT_FAILURE_MESSAGE_SIZE, MAX_CONFIRMATION_LENGTH, redactSensitiveFieldValues, MAX_CONCURRENT_AUDIT_WRITES, MAX_AUDIT_QUEUE_SIZE, AUDIT_WRITE_QUEUE_TIMEOUT_MS, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolContext, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, capString, MAX_STORED_PAYLOAD_SIZE } from "./truncate.js";
import { sanitizeAgentFacingResult } from "../agent-result.js";

const AUDIT_DROP_WARNING =
  "Some audit log entries were dropped due to high load. The operation succeeded but the durable audit trail may be incomplete.";

/**
 * Attach the audit-drop warning to a tool result without corrupting the
 * payload.
 *
 * Object-spreading a non-object result would corrupt it: spreading a string
 * produces numeric index keys (`"ok"` → `{ 0: "o", 1: "k" }`), a number is
 * silently discarded, an array's indices become keys, and — the case the
 * original object/array check missed — spreading a Map, Set, or Date yields
 * `{}` because none of them own enumerable properties, so the ENTIRE payload
 * was replaced by `{ _auditWarning }` with no trace of the tool's data. Class
 * instances survive the spread as own-property bags but lose their prototype
 * and methods. Only merge the warning INTO a PLAIN-object result (prototype
 * is Object.prototype or null); every other value routes to the wrapper
 * alongside the original so the agent sees both the warning and the
 * uncorrupted data.
 */
export function attachAuditWarning(result: ToolResult, warning = AUDIT_DROP_WARNING): ToolResult {
  const data = result.data;
  if (data != null && isPlainObjectData(data)) {
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
 * True for plain objects only (prototype Object.prototype or null) — the same
 * discriminator truncate.ts's normaliseContainer and crypto.ts's sortObject
 * use before recursing into user-shaped objects. Arrays, Map/Set/Date/class
 * instances fail this check and take the non-destructive wrapper path in
 * attachAuditWarning instead of being spread into a bare object literal.
 */
function isPlainObjectData(data: unknown): data is Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const proto = Object.getPrototypeOf(data);
  return proto === Object.prototype || proto === null;
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

/**
 * A tool call that was rejected BEFORE the middleware pipeline ran.
 *
 * The pipeline is composed PER TOOL, so a rejection that happens before the
 * tool is even looked up (an unknown tool name, a conflicting idempotency
 * key) never reaches the audit middleware — the attempt was invisible in the
 * durable trail. A hallucinated tool call is one of the most useful
 * agent-behaviour signals an ERP has, so it must be recorded.
 */
export interface RejectedToolCall {
  /** The tool name the caller asked for. */
  toolName: string;
  /** The validated caller identity. */
  context: ToolContext;
  /** The machine-readable rejection code (e.g. "UNKNOWN_TOOL"). */
  code: string;
  /** The human-readable rejection message. */
  message: string;
  /** The raw tool arguments, when they are available. */
  input?: unknown;
}

/**
 * Create a callback that records a pre-pipeline rejection in the durable
 * audit trail.
 *
 * The write goes through the SAME backpressure manager and the SAME entry
 * builder as the audit middleware, so a rejection row is shaped identically
 * to any other audit row (sanitized identity, redacted input, capped
 * output). Fire-and-forget: a failure to write the audit row must never
 * change the outcome of the call.
 */
export function createRejectionAuditor(prisma: PrismaClient): (rejection: RejectedToolCall) => void {
  const backpressure = createBackpressureManager(prisma);

  return (rejection: RejectedToolCall): void => {
    if (!prisma?.aiActionLog) return;
    try {
      const base = createBaseEntry(rejection.context, { name: rejection.toolName }, rejection.input ?? {});
      backpressure.log({
        ...base,
        toolOutput: {
          error: {
            message: capString(sanitizeForLogOutput(rejection.message), MAX_SOFT_FAILURE_MESSAGE_SIZE),
            // Stored under `errorCode` (not `code`) so the shared redactor does
            // not rewrite the machine-readable failure code to "[REDACTED]" —
            // see formatSoftFailureOutput for the full rationale.
            errorCode: capString(sanitizeForLogOutput(rejection.code), MAX_SOFT_FAILURE_MESSAGE_SIZE) || undefined,
          },
        },
      });
    } catch {
      // The audit path must never break the call it is recording.
    }
  };
}

function createBaseEntry(context: { agentId?: string; conversationId?: string; reasoning?: string; confirmation?: string; userId: string; tenantId: string }, definition: { name: string }, input: unknown): Omit<AuditLogEntry, "toolOutput"> {
  // `reasoning` originates from the AI agent / tool-call context, which is
  // attacker-influenceable (any string may be supplied in the MCP request
  // body). It is persisted verbatim to ai_action_log.reasoning, a durable
  // cross-tenant audit sink, so a connection string, JWT, or api_key query
  // param embedded in it would leak to the durable row even though every
  // other durable sink (toolInput, toolOutput) and every agent-facing
  // surface is sanitized. Sanitize FIRST, then trim to the length cap so a
  // secret in the tail is still scrubbed (sanitizeForLogOutput collapses
  // URLs/secrets regardless of position). Mirrors the toolInput handling.
  //
  // This helper MUST NOT throw. The audit middleware is documented as
  // fire-and-forget and must never break the tool — and `createBaseEntry`
  // runs OUTSIDE the try/catch in `executeAndLog`, so a throw here aborts
  // the whole tool call before the handler even runs.
  //
  // It used to throw in two ways:
  //   * `sanitizeForLogOutput` calls `sanitizeLogMessage`, which does
  //     `message.replace(...)` — on a NON-STRING `reasoning` that is a
  //     `TypeError: message.replace is not a function`. `ToolContext` is a
  //     public, hand-constructible type and the registry validates
  //     tenantId/userId/agentId/conversationId but NOT `reasoning`, so a
  //     directly-constructed context could abort the tool call.
  //   * `stripHtmlTags` rejects inputs over 100 KB by throwing, and
  //     `reasoning` has no boundary length-validates.
  // The two sibling helpers in this file (`sanitizeIdentityField`,
  // `sanitizeConfirmation`) each wrap their body in try/catch for exactly
  // this reason — `reasoning` was the one field that was missed.
  //
  // `reasoning` is also the only field that was NOT passed through
  // `stripHtmlTags`, so raw HTML could be persisted into the durable
  // `ai_action_log.reasoning` column. It is stripped here, like every other
  // free-text field.
  const reasoning = sanitizeReasoning(context.reasoning);
  // `userId`/`agentId`/`conversationId` originate from the caller's MCP request
  // and are persisted verbatim to the cross-tenant `ai_action_log` durable sink.
  // A caller could embed a secret (connection string, `?api_key=…`) in any of
  // these fields, so they are sanitized before the row is written — with the
  // caveat that a CHARSET-VALIDATED identity is only stripped of HTML (see
  // `sanitizeIdentityField`): running it through the generic high-entropy
  // rule would rewrite a legal 20+ character id ("ServiceAccount12345678")
  // into "[REDACTED_TOKEN]" and destroy the audit correlation.
  // `stripHtmlTags` rejects inputs over 100 KB by throwing, and
  // `createBaseEntry` runs OUTSIDE the try/catch in executeAndLog — so a
  // throw here would abort the tool call (the audit middleware is documented
  // as fire-and-forget and must never break the tool). Clamp FIRST (these
  // fields are length-capped anyway) and never throw.
  const userId = sanitizeIdentityField(context.userId, MAX_USER_ID_LENGTH);
  const agentId = context.agentId !== undefined
    ? sanitizeIdentityField(context.agentId, MAX_AGENT_ID_LENGTH)
    : undefined;
  const conversationId = context.conversationId !== undefined
    ? sanitizeIdentityField(context.conversationId, MAX_CONVERSATION_ID_LENGTH)
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
    // other identity fields (userId, agentId, conversationId) are validated
    // with the looser OPTIONAL_ID_PATTERN, so they are HTML-stripped and,
    // when they fail that validation, fully sanitized.
    tenantId: context.tenantId,
    toolCalled: definition.name,
    toolInput: withConfirmation(redactSensitiveFields(input), context.confirmation),
  };
}

/**
 * Attach the agent's confirmation to the durable `toolInput` payload.
 *
 * The confirmation used to travel on the tool input, which meant it was
 * captured implicitly by the redaction pass — but the confirmation gate had
 * to inject it AFTER the strict schema validation boundary, so the row could
 * not be trusted to contain it. The confirmation now travels on the context
 * (see ToolRegistry.execute), and this helper writes it into the audit row
 * explicitly so operators can still audit the agent's stated reason for a
 * gated operation.
 *
 * The value is sanitized + capped exactly like `reasoning`: a confirmation
 * is attacker-influenceable free text that lands in a durable cross-tenant
 * sink.
 *
 * This helper MUST NOT throw. The audit middleware is documented as
 * fire-and-forget ("audit should never break the tool"), but `stripHtmlTags`
 * rejects inputs over 100 KB by throwing. An oversized confirmation — which
 * no boundary length-validates — therefore aborted the whole tool call with
 * an opaque INTERNAL_ERROR and wrote NO audit row. Clamp FIRST (the value is
 * over the length cap anyway, so the tail is discarded either way) and then
 * sanitize inside a try/catch so the audit path can never break execution.
 */
function withConfirmation(toolInput: unknown, confirmation: string | undefined): unknown {
  if (confirmation === undefined) return toolInput;
  const safeConfirmation = sanitizeConfirmation(confirmation);
  if (isPlainObjectData(toolInput)) {
    return { ...(toolInput as Record<string, unknown>), confirmation: safeConfirmation };
  }
  // A non-plain-object input (array, Map, class instance) was previously
  // REPLACED by `{}` — the entire tool input vanished from the durable audit
  // row. Wrap it instead so both the input and the confirmation survive.
  return { input: toolInput, confirmation: safeConfirmation };
}

/**
 * Sanitize + cap a confirmation string without ever throwing.
 */
function sanitizeConfirmation(confirmation: string): string {
  try {
    // Clamp before stripping: stripHtmlTags rejects inputs over 100 KB, and
    // the value is over MAX_CONFIRMATION_LENGTH (500 chars) anyway.
    const clamped = confirmation.slice(0, MAX_CONFIRMATION_LENGTH);
    return sanitizeForLogOutput(stripHtmlTags(clamped)).slice(0, MAX_CONFIRMATION_LENGTH);
  } catch {
    // Never let the audit path break the tool call.
    return "";
  }
}

/**
 * Sanitize + cap an identity field (userId / agentId / conversationId)
 * without ever throwing.
 *
 * The recognised-secret rules (provider keys, connection strings,
 * `name=value` pairs, URLs, paths) still apply — a caller-supplied identity
 * CAN embed a secret, and the durable row is a cross-tenant sink.
 *
 * The generic "opaque token" rule does NOT: it rewrites any 20-128 character
 * run that mixes letters and digits into "[REDACTED_TOKEN]", so a perfectly
 * legal user id such as "ServiceAccount12345678" was persisted as
 * "[REDACTED_TOKEN]" — destroying the audit correlation the row exists to
 * provide. The identity fields are charset-validated (OPTIONAL_ID_PATTERN)
 * before any middleware runs, so an opaque token in one of them is an
 * identifier, not a secret.
 */
function sanitizeIdentityField(value: string, maxLength: number): string {
  try {
    const clamped = value.slice(0, maxLength);
    return sanitizeForLogOutput(stripHtmlTags(clamped), { keepOpaqueTokens: true }).slice(0, maxLength);
  } catch {
    return "";
  }
}

/**
 * Sanitize + cap the agent's `reasoning` without ever throwing.
 *
 * Returns `null` when there is no usable reasoning. The value is clamped
 * BEFORE sanitization (it is over the length cap anyway, so the tail is
 * discarded either way) and every step is guarded: `stripHtmlTags` rejects
 * inputs over 100 KB by throwing, and `sanitizeForLogOutput` throws on a
 * non-string input. Either would abort the tool call, because
 * `createBaseEntry` runs outside the audit middleware's try/catch.
 */
function sanitizeReasoning(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const clamped = trimmed.slice(0, MAX_REASONING_LENGTH);
    const sanitized = sanitizeForLogOutput(stripHtmlTags(clamped)).slice(0, MAX_REASONING_LENGTH);
    return sanitized.length === 0 ? null : sanitized;
  } catch {
    // Never let the audit path break the tool call. The reasoning is
    // advisory, so dropping it is preferable to failing the operation.
    return null;
  }
}

/**
 * Shape a soft-failure result's error into the durable `toolOutput` payload.
 *
 * Extracted so `executeAndLog` stays within the lint complexity cap. Mirrors
 * the throw branch (sanitized + capped message and code) so the ai_action_log
 * row captures the failure detail either way: this branch handles a failure
 * the handler RETURNED, the catch branch handles a failure the handler
 * THREW. (The errorHandler middleware is OUTSIDE the audit middleware, so the
 * audit middleware's catch runs first — both branches are live.)
 *
 * The machine-readable code is stored under `errorCode`, NOT `code`: the
 * shared redactor treats the exact key `code` as a sensitive field name and
 * rewrote it to "[REDACTED]", so the durable audit trail lost the only
 * machine-readable discriminator for a failure (the idempotency sink stores
 * the same value verbatim under `error.code` — the two durable sinks
 * disagreed). `errorCode` is not a sensitive field name, so the value
 * survives the redaction pass intact.
 */
function formatSoftFailureOutput(result: ToolResult): { error: { message: string | null; errorCode: string | undefined } } {
  return {
    error: {
      message: result.error?.message
        ? capString(sanitizeForLogOutput(result.error.message), MAX_SOFT_FAILURE_MESSAGE_SIZE)
        : null,
      errorCode: result.error?.code
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
      toolOutput: {
        error: {
          message: capString(sanitizeForLogOutput(error instanceof Error ? error.message : String(error)), MAX_SOFT_FAILURE_MESSAGE_SIZE),
          // Stored under `errorCode` (not `code`) so the shared redactor does
          // not rewrite the machine-readable failure code to "[REDACTED]" —
          // see formatSoftFailureOutput for the full rationale.
          errorCode: capString(sanitizeForLogOutput(getErrorCode(error) ?? ""), MAX_SOFT_FAILURE_MESSAGE_SIZE) || undefined,
        },
      },
    });
    throw error;
  }

  // A RETURNED soft-failure result (success:false) is one of the two paths
  // that records a failure in the durable trail. The other is the catch
  // branch above, which handles a THROWN error.
  //
  // The comment that used to sit here claimed the catch branch was dead code
  // ("the OUTERMEST errorHandlerMiddleware converts every thrown error into a
  // non-thrown ToolResult before the throw branch above could run"). That is
  // backwards: the errorHandler is OUTSIDE the audit middleware, so the
  // audit middleware's catch runs FIRST and is the LIVE path for a thrown
  // error. The catch branch records every thrown DomainError/Prisma error;
  // this branch records every failure the handler RETURNED. Deleting the
  // catch branch on the strength of the old comment would have silently lost
  // every thrown-error audit row.
  const auditWrite = backpressure.log({
    ...base,
    toolOutput: result.success ? result.data ?? null : formatSoftFailureOutput(result),
  });

  // If THIS request's audit entry was dropped due to backpressure, surface a
  // non-fatal warning to the agent so it knows the durable audit trail has a
  // gap. This is critical for compliance-sensitive ERP systems where silent
  // audit loss is a regulatory issue. The warning does NOT affect
  // success/data — the tool still completed successfully; only the audit
  // side-effect was lost. Drop status is tracked PER ENTRY: the previous
  // process-global wasDropDetected() flag was consumed by whichever request
  // polled next, so an unrelated concurrent response could carry (or swallow)
  // another request's warning.
  if (auditWrite.wasDropped()) {
    result = attachAuditWarning(result);
  }

  // The success payload returned to the AI agent must be redacted the SAME
  // way the durable sinks (audit row via truncateValue(redactSensitiveFields…)
  // and idempotency replay via redactSensitiveFields) are. Without this, a
  // tool returning a value under a sensitive-named key (e.g. a credential)
  // leaks to the agent live on the first call, while the identical value is
  // redacted when persisted or replayed — an asymmetric secret-leak path.
  //
  // `sanitizeAgentFacingResult` is the SHARED agent-facing boundary: it
  // redacts the success payload, the soft-failure `error.context`, the error
  // code/message and the `nextActions` strings, and it never throws (the
  // previous inline `stripHtmlTags(n)` on a `nextActions` entry THREW for
  // inputs over 100 KB, turning a SUCCESSFUL write into an
  // INVALID_TYPE_VALUE error whose message was unrelated to the input — the
  // agent was told the call failed and retried, duplicating the write).
  //
  // The registry's final handler applies the same helper to the handler's own
  // result, so a pipeline composed WITHOUT the audit middleware still
  // sanitizes the handler output; the audit middleware additionally covers
  // results produced by the middlewares inside it (the confirmation gate and
  // the idempotency middleware), which never reach the final handler.
  result = sanitizeAgentFacingResult(result);
  return result;
}

// ─── Backpressure Manager ────────────────────────────────────────

/**
 * Per-entry handle returned by BackpressureManager.log(). `wasDropped()`
 * reports whether THIS entry was dropped by backpressure — queue-full drops
 * are known synchronously (before log() returns); write-slot timeouts flip
 * the flag asynchronously, which is best-effort (the response may already
 * have been returned — the stderr drop log remains the durable signal).
 */
interface AuditWriteHandle {
  wasDropped(): boolean;
}

interface BackpressureManager {
  log(entry: AuditLogEntry): AuditWriteHandle;
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

  function acquireWriteSlot(onDrop: () => void): Promise<{ acquired: boolean }> {
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
          // Count slot-timeout drops the same way queue-full drops are
          // counted (droppedCount + the per-entry onDrop flip consumed by
          // executeAndLog's agent-facing audit-gap warning) so they are
          // reflected. Previously only the queue-full path bumped these,
          // so a sustained write-slot stall was silently lost.
          droppedCount++;
          onDrop();
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
        onDrop();
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
    log(entry: AuditLogEntry): AuditWriteHandle {
      // Per-entry drop flag: the agent-facing warning must reflect THIS
      // request's entry only. The previous process-global dropDetected flag
      // was consumed once by an arbitrary later request, attaching the
      // warning to the wrong response (and dropping it for the right one).
      let entryDropped = false;
      if (writeQueue.length >= MAX_AUDIT_QUEUE_SIZE) {
        droppedCount++;
        entryDropped = true;
        try {
          process.stderr.write(`[AuditLog] Queue full (${MAX_AUDIT_QUEUE_SIZE}), dropping audit entry for '${sanitizeLogMessage(entry.toolCalled)}' (total dropped: ${droppedCount})\n`);
        } catch {
          // stderr may be closed.
        }
        return { wasDropped: () => true };
      }
      let slotAcquired = false;
      // Top-level .catch prevents unhandledRejection if logAction throws
      // synchronously before returning a promise. The inner .catch only
      // handles async rejections from within the .then() callback.
      acquireWriteSlot(() => {
        entryDropped = true;
      })
        .then(({ acquired }) => {
          if (!acquired) {
            // Slot timeout for THIS entry — flip its flag for any caller
            // still polling (best-effort: the response may already be gone).
            entryDropped = true;
            return;
          }
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
      return { wasDropped: () => entryDropped };
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
