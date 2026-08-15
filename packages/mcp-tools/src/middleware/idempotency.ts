// Idempotency Middleware — Prevents duplicate operations from retries.
//
// Implements ADR-004: Idempotency Key Pattern for Write Tools.
//
// If an idempotency key is provided in the context:
// 1. Check if a completed record exists → return stored result (replay)
// 2. Check if a pending record exists → return REQUEST_IN_PROGRESS error
// 3. Check if a failed record exists → re-execute
// 4. Otherwise, create a pending record, execute, and update on completion
//
// Uses Prisma's interactive transaction ($transaction) with a serializable
// isolation guard to avoid the check-then-insert race condition. Two concurrent
// requests with the same key will be serialized by the database, preventing
// duplicate pending records.
//
// If no idempotency key is provided, the middleware is a no-op pass-through.

import { PrismaClient, Prisma, IdempotencyRecord } from "@prisma/client";
import { createHash } from "node:crypto";
import { hashInput, getErrorCode, sanitizeForLogOutput, stripHtmlTags, redactSensitiveFieldValues, MAX_SOFT_FAILURE_MESSAGE_SIZE, IDEMPOTENCY_TTL_MS, MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, IDEMPOTENCY_MAX_RETRIES, IDEMPOTENCY_RETRY_BASE_DELAY_MS, IDEMPOTENCY_STALE_PENDING_THRESHOLD_MS, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolResult, ToolContext, ZodSchemaLike } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE, capString, isTruncationMarker } from "./truncate.js";

const LAST_RETRY_ATTEMPT = IDEMPOTENCY_MAX_RETRIES - 1;

/**
 * Create an idempotency middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, bypasses RLS for idempotency records)
 */
function validateIdempotencyKey(key: unknown, toolName: string): { valid: false; error: ToolResult } | { valid: true; key: string } {
  if (key === undefined || key === null) {
    return { valid: true, key: "" };
  }
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      valid: false,
      error: {
        success: false,
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: typeof key !== "string" || key.length === 0
            ? "Idempotency key is required and must be a non-empty string."
            : `Idempotency key exceeds maximum length of ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
          suggestedTools: [toolName],
        },
      },
    };
  }
  if (!SAFE_IDEMPOTENCY_KEY.test(key)) {
    const safeKey = redactKey(key);
    return {
      valid: false,
      error: {
        success: false,
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "The idempotency key contains invalid characters. Keys must be printable ASCII (no control characters, newlines, or non-ASCII bytes).",
          suggestedTools: [toolName],
          context: { keyPrefix: safeKey },
        },
      },
    };
  }
  return { valid: true, key };
}

const SKIP_HASH = Symbol("skipIdempotencyHash");

function computeInputHash(input: unknown, definition: { name: string; inputSchema: ZodSchemaLike }): string | symbol {
  const parseResult = definition.inputSchema.safeParse(input);
  if (!parseResult.success) {
    // Zod parse failure means the input is malformed — no side effect was
    // produced, so idempotency dedup is unnecessary. Log so operators can
    // detect pathological inputs (e.g. circular refs that pass Zod but break
    // the serializer, or schema drift that silently drops fields). Previously
    // this path was completely silent while the serialization-failure path
    // below emitted a warning, making the two skip reasons inconsistently
    // observable.
    logIdempotencyWarn(
      `Skipping idempotency for '${definition.name}': input failed Zod validation (${parseResult.error.issues.length} issue(s))`
    );
    return SKIP_HASH;
  }
  try {
    return hashInput(parseResult.data);
  } catch {
    logIdempotencyWarn(
      `Skipping idempotency for '${definition.name}': input cannot be hashed (circular reference or unserializable type)`
    );
    return SKIP_HASH;
  }
}

function handleRecordUnavailable(toolName: string): ToolResult {
  return {
    success: false,
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Idempotency service is temporarily unavailable. The operation cannot be retried at this time — retry the same request later (not with a new key).",
      suggestedTools: [toolName],
    },
  };
}

function handleRecordContention(key: string, toolName: string): ToolResult {
  const safeKey = redactKey(key);
  return {
    success: false,
    error: {
      code: "IDEMPOTENCY_CONTENTION",
      // P2034 exhaustion means a concurrent request is racing on the SAME
      // (key, tenant) row — this is serialization contention, not an
      // infrastructure failure, so retrying with a NEW key would not help
      // and would bypass idempotency protection (key-hopping can
      // double-execute the write). Guide the agent to wait and retry the
      // same request with the same key: either the concurrent request
      // completes (and the retry replays its result) or the insert succeeds.
      message: `Could not acquire idempotency record for '${safeKey}' after ${IDEMPOTENCY_MAX_RETRIES} attempts — a concurrent request holds the record. Wait briefly and retry the same request with the same idempotency key (do not use a new key).`,
      suggestedTools: [toolName],
    },
  };
}

export function idempotencyMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    if (!prisma?.idempotencyRecord) {
      logIdempotencyWarn("Prisma client not available — skipping idempotency check");
      return next(input, context);
    }

    const { idempotencyKey, tenantId, userId, agentId, conversationId } = context;

    const keyResult = validateIdempotencyKey(idempotencyKey, definition.name);
    if (!keyResult.valid) return keyResult.error;
    if (!keyResult.key) return next(input, context);

    const hashResult = computeInputHash(input, definition);
    if (typeof hashResult === "symbol") return next(input, context);
    const inputHash = hashResult;

    const { existingRecord, recordCreated, unavailable } = await acquireIdempotencyRecord(
      prisma, keyResult.key, tenantId, userId, agentId, conversationId, definition.name, inputHash,
    );

    if (!recordCreated && !existingRecord) {
      return unavailable
        ? handleRecordUnavailable(definition.name)
        : handleRecordContention(keyResult.key, definition.name);
    }

    if (existingRecord) {
      return handleExistingRecord(existingRecord, inputHash, keyResult.key, definition.name);
    }

    return executeAndUpdate(prisma, keyResult.key, tenantId, input, context, definition, next);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // unref so an in-flight retry backoff (used by both the acquire- and
    // update-record retry loops) does not hold the event loop open during
    // graceful shutdown. Mirrors the unref pattern in main.ts (hardExitTimer),
    // health.controller.ts (readiness timeout), and audit-log.ts. The promise
    // still resolves normally while the loop is running, so retry timing is
    // unchanged.
    timer.unref();
  });
}

/**
 * Compute a jittered backoff delay for the idempotency retry loops.
 *
 * Returns the deterministic backoff (`base * (attempt + 1)`) PLUS up to one
 * `base` interval of random jitter. Under P2034 serialization contention —
 * the exact scenario these loops exist to handle — concurrent transactions
 * fail at the same instant and, with deterministic backoff alone, retry at
 * identical intervals: synchronized bursts that immediately re-contend (the
 * thundering-herd pattern). Jitter de-synchronizes the retries so they spread
 * out. Mirrors the additive jitter already applied by
 * QueueModule.redisRetryStrategy for the same reason.
 */
function retryDelayMs(base: number, attempt: number): number {
  return base * (attempt + 1) + Math.random() * base;
}

function logIdempotencyWarn(message: string): void {
  try {
    process.stderr.write(`[Idempotency] ${JSON.stringify({ timestamp: new Date().toISOString(), message })}\n`);
  } catch {
    // stderr may be closed (e.g., container redirect issue) — suppress to
    // prevent the warning itself from surfacing as an uncaught exception.
  }
}

/**
 * Redact an idempotency key to a non-reversible token for agent-facing and
 * log messages. Previously the first 32 plaintext characters were embedded
 * verbatim — if a key ever carried a secret (defense-in-depth), up to 32 chars
 * would leak to the AI agent. We now hash it to a short opaque prefix so the
 * key remains distinguishable across messages without revealing its content.
 */
function redactKey(key: string): string {
  // SHA-256 hex output is ASCII-only (0-9, a-f), so no sanitization is needed.
  const token = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `id-${token}`;
}

async function acquireIdempotencyRecord(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string, userId: string,
  agentId: string | undefined, conversationId: string | undefined,
  toolName: string, inputHash: string,
): Promise<{ existingRecord: IdempotencyRecord | null; recordCreated: boolean; unavailable?: boolean }> {
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_RETRIES; attempt++) {
    try {
      const { existing, created } = await prisma.$transaction(async (tx) => {
        const record = await tx.idempotencyRecord.findUnique({ where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } } });

        if (!record) {
          // Sanitize identity fields before persisting to the durable
          // idempotency_record table. `userId`/`agentId`/`conversationId` are
          // caller-supplied and may embed secrets (connection strings,
          // `?api_key=…`); the raw values were already format-validated by
          // `buildContext` and `validateContextIdentity`, but sanitization is
          // still required so the durable sink never stores a raw secret.
          const safeUserId = sanitizeForLogOutput(stripHtmlTags(userId)).slice(0, MAX_USER_ID_LENGTH);
          const safeAgentId = agentId !== undefined
            ? sanitizeForLogOutput(stripHtmlTags(agentId)).slice(0, MAX_AGENT_ID_LENGTH)
            : undefined;
          const safeConversationId = conversationId !== undefined
            ? sanitizeForLogOutput(stripHtmlTags(conversationId)).slice(0, MAX_CONVERSATION_ID_LENGTH)
            : undefined;
          await tx.idempotencyRecord.create({
            data: {
              idempotencyKey, toolName, tenantId, userId: safeUserId,
              agentId: safeAgentId ?? null, conversationId: safeConversationId ?? null,
              status: "pending", inputHash,
              expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
            },
          });
          return { existing: null, created: true };
        }

        if (record.status === "failed") {
          if (record.inputHash !== inputHash || record.toolName !== toolName) {
            // Different input OR a different tool reusing the key: do NOT
            // reset-and-re-execute — the caller must use a new key. Routing
            // the existing record back surfaces the mismatch error via
            // handleExistingRecord (which now also checks toolName).
            return { existing: record, created: false };
          }
          await tx.idempotencyRecord.update({
            // Composite PK (idempotencyKey, tenantId) — select via the
            // compound unique selector.
            where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
            data: {
              status: "pending", inputHash,
              // Bump createdAt so the reset CLAIMS the record as a fresh
              // execution. Without it, a concurrent retry (or a second call
              // arriving seconds after this reset) re-reads the same record,
              // still sees createdAt older than
              // IDEMPOTENCY_STALE_PENDING_THRESHOLD_MS, and resets AGAIN —
              // re-executing the side effect instead of returning
              // REQUEST_IN_PROGRESS. The stale-pending path exists to recover
              // CRASHED requests; a record that has just been claimed by a
              // live execution must look fresh to everyone else.
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS), error: Prisma.DbNull,
            },
          });
          return { existing: null, created: true };
        }

        if (record.status === "pending") {
          // Guard against null createdAt — the Prisma schema allows it, and a
          // null value would throw TypeError on .getTime(). Treat a null-createdAt
          // as a brand-new record so the caller can proceed (the next acquire
          // attempt will create a fresh row).
          if (!record.createdAt) {
            await tx.idempotencyRecord.update({
              where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
              data: { status: "pending", inputHash, createdAt: new Date(), expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS), error: Prisma.DbNull },
            });
            return { existing: null, created: true };
          }
          const pendingAge = Date.now() - record.createdAt.getTime();
          if (pendingAge > IDEMPOTENCY_STALE_PENDING_THRESHOLD_MS) {
            // Stale pending record — the previous request likely crashed
            // before completing. Reset to pending so this request can proceed.
            // Only allow reset if the input hash matches AND the tool is the
            // same to prevent a stale record from being reset for a different
            // operation or a different tool reusing the key.
            if (record.inputHash !== inputHash || record.toolName !== toolName) {
              return { existing: record, created: false };
            }
            await tx.idempotencyRecord.update({
              where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
              // Bump createdAt here too (see the failed→pending path above) so
              // this reclaimed record is not instantly re-flagged as stale by a
              // concurrent retry of the same key.
              data: { status: "pending", inputHash, createdAt: new Date(), expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS), error: Prisma.DbNull },
            });
            return { existing: null, created: true };
          }
        }

        return { existing: record, created: false };
      }, { isolationLevel: "Serializable" });

      return { existingRecord: existing, recordCreated: created };
    } catch (e) {
      const code = getErrorCode(e);
      if (code === "P2034" && attempt < LAST_RETRY_ATTEMPT) {
        await delay(retryDelayMs(IDEMPOTENCY_RETRY_BASE_DELAY_MS, attempt));
        continue;
      }
      // Non-P2034 errors (connection failures, auth errors, schema mismatches)
      // are fatal — log them so operators can distinguish infrastructure issues
      // from normal serialization contention. Sanitize the message first: a
      // driver/Prisma error can embed a DB connection string or hostname, and
      // this path writes the detail verbatim to stderr (the durable
      // idempotency_record write below already caps + sanitizes via capString).
      // Return a distinct error so the caller can differentiate infrastructure
      // errors (retrying with a new key won't help) from serialization
      // contention (P2034).
      if (code !== "P2034") {
        logIdempotencyWarn(
          `Non-retryable error acquiring idempotency record '${redactKey(idempotencyKey)}' (code=${code ?? "none"}): ${sanitizeForLogOutput(e instanceof Error ? e.message : String(e))}`
        );
        return { existingRecord: null, recordCreated: false, unavailable: true };
      }
      // P2034 on the last attempt — fall through to the loop-end return below.
      // The caller receives recordCreated=false with unavailable=undefined,
      // which maps to IDEMPOTENCY_CONTENTION (not SERVICE_UNAVAILABLE), since
      // this is genuine serialization contention rather than an infrastructure
      // failure.
      break;
    }
  }
  // Exhausted all retries due to P2034 serialization failures — the record
  // was never created and no existing record was found. Return unavailable=undefined
  // so the caller surfaces IDEMPOTENCY_CONTENTION (this is contention, not an
  // infrastructure issue — retrying with a new key won't help either).
  return { existingRecord: null, recordCreated: false };
}

function handleExistingRecord(
  existing: IdempotencyRecord, inputHash: string,
  idempotencyKey: string, toolName: string,
): ToolResult {
  // An idempotency key identifies ONE operation. The record's PK is
  // (idempotencyKey, tenantId) and the input hash is computed over the
  // Zod-normalized input only (no tool component), so a caller that reuses a
  // key for a DIFFERENT tool with an identical input shape would otherwise
  // replay the first tool's cached result as if it were the second tool's —
  // silently skipping the second operation's side effect. The stored toolName
  // is never compared today; reject any cross-tool reuse of a key as a
  // mismatch so the agent must use a fresh key. Checked here (all status
  // branches) so a completed replay, a pending in-progress record, and a
  // failed record all surface the same actionable error.
  if (existing.toolName !== toolName) {
    return {
      success: false,
      error: {
        code: "IDEMPOTENCY_KEY_MISMATCH",
        message: `Idempotency key '${redactKey(idempotencyKey)}' was already used by tool '${sanitizeForLogOutput(existing.toolName)}'. ` +
          `Use a new idempotency key for a different operation.`,
        suggestedTools: [toolName],
      },
    };
  }
  if (existing.status === "completed") {
    if (existing.inputHash !== inputHash) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: `Idempotency key '${redactKey(idempotencyKey)}' was already used with different input. Use a new idempotency key for a different operation.`,
          suggestedTools: [toolName],
          context: { originalInputHash: existing.inputHash },
        },
      };
    }
    const data = existing.result;
    const isTruncated = isTruncationMarker(data);
    return {
      success: true,
      // Re-apply sensitive-field redaction on replay as defense-in-depth:
      // rows persisted before this fix may contain unredacted values, and a
      // record persisted by a code path that skipped redaction must never be
      // replayed to the agent verbatim. The audit log uses the same
      // redactSensitiveFields, so the two sinks stay consistent.
      data: redactSensitiveFieldValues(data) as Record<string, unknown> | undefined,
      replayed: true,
      nextActions: [
        `This is a replay of a previous '${toolName}' call. No action needed.`,
        ...(isTruncated ? ["Note: The original result was truncated for storage."] : []),
      ],
    };
  }

  if (existing.status === "pending") {
    if (existing.inputHash !== inputHash) {
      // Guard against null createdAt — the Prisma schema allows it, and a
      // null value would throw TypeError on .getTime(). Treat it as a stale
      // record so the caller gets KEY_MISMATCH and can retry with a new key.
      if (!existing.createdAt) {
        return {
          success: false,
          error: {
            code: "IDEMPOTENCY_KEY_MISMATCH",
            message: `Idempotency key '${redactKey(idempotencyKey)}' has a corrupted pending record (missing createdAt). Retry with a new idempotency key.`,
            suggestedTools: [toolName],
          },
        };
      }
      const pendingAge = Date.now() - existing.createdAt.getTime();
      if (pendingAge > IDEMPOTENCY_STALE_PENDING_THRESHOLD_MS) {
        return {
          success: false,
          error: {
            code: "STALE_PENDING_RECORD",
            message: `Idempotency key '${redactKey(idempotencyKey)}' has a stale pending record (${Math.round(pendingAge / 1000)}s old) with different input. The previous request likely crashed. Retry with a new idempotency key.`,
            suggestedTools: [toolName],
          },
        };
      }
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: `Idempotency key '${redactKey(idempotencyKey)}' is in use with different input. Use a new idempotency key.`,
          suggestedTools: [toolName],
        },
      };
    }
    return {
      success: false,
      error: {
        code: "REQUEST_IN_PROGRESS",
        message: `A request with idempotency key '${redactKey(idempotencyKey)}' is already in progress. Wait and retry.`,
        suggestedTools: [toolName],
      },
    };
  }

  if (existing.status === "failed") {
    if (existing.inputHash !== inputHash) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: `Idempotency key '${redactKey(idempotencyKey)}' was previously used with different input. Use a new idempotency key.`,
          suggestedTools: [toolName],
          context: { originalInputHash: existing.inputHash },
        },
      };
    }
    // Input matches a previously failed attempt. Under normal operation,
    // acquireIdempotencyRecord resets the record to "pending" (returning
    // created: true) so this branch is typically unreachable. However, a
    // narrow race window can cause the acquire to return the stale record
    // directly (e.g., concurrent cleanup between the findUnique and
    // update). Rather than returning INTERNAL_ERROR (which forces the
    // caller to use a new key), allow retry by returning
    // REQUEST_IN_PROGRESS — the caller can wait and retry, and the next
    // acquireIdempotencyRecord call will reset the record properly.
    return {
      success: false,
      error: {
        code: "REQUEST_IN_PROGRESS",
        message: `Idempotency key '${redactKey(idempotencyKey)}' has a failed record that is being reset. Wait and retry.`,
        suggestedTools: [toolName],
      },
    };
  }

  return {
    success: false,
    error: {
      code: "IDEMPOTENCY_UNKNOWN_STATUS",
      message: `Unexpected idempotency status '${existing.status}' for key '${redactKey(idempotencyKey)}'. Retry with a new idempotency key.`,
      suggestedTools: [toolName],
      context: { status: existing.status },
    },
  };
}

async function executeAndUpdate(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string,
  input: unknown, context: ToolContext,
  _definition: { name: string },
  next: (input: unknown, context: ToolContext) => Promise<ToolResult>,
): Promise<ToolResult> {
  let toolResult: ToolResult;
  try {
    toolResult = await next(input, context);
  } catch (error: unknown) {
    // Cap the message the same way the soft-failure path does
    // (updateIdempotencyRecordWithRetry → capString). Without this, a
    // verbose thrown error (Prisma dump, network stack trace) would store
    // a multi-KB string verbatim in idempotency_record.error.message and
    // bloat both the row and the 24h-TTL cleanup job's I/O.
    //
    // Sanitize FIRST: this throw path receives the raw error before the
    // errorHandlerMiddleware gets a chance to scrub it, so a driver/Prisma
    // message can embed a DB connection string or hostname. We strip those
    // (→ [DATABASE_URL], [HOST]) before persisting to the durable
    // idempotency_record table — mirroring the audit-log error path.
    const message = capString(
      sanitizeForLogOutput(error instanceof Error ? error.message : String(error)),
      MAX_SOFT_FAILURE_MESSAGE_SIZE,
    );
    const failedResult: ToolResult = {
      success: false,
      error: {
        // The soft-failure path (updateIdempotencyRecordWithRetry) already
        // caps + scrubs error.code; the hard-throw path must do the same so a
        // thrown custom error whose .code carries a long/secret-shaped value is
        // not persisted verbatim into the durable 24h-TTL idempotency_record.
        code: capString(
          sanitizeForLogOutput(getErrorCode(error) ?? "EXECUTION_ERROR"),
          MAX_SOFT_FAILURE_MESSAGE_SIZE,
        ),
        message,
      },
    };
    try {
      await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, tenantId, failedResult, true);
    } catch {
      // Belt-and-suspenders: if updating the idempotency record as "failed"
      // itself fails (e.g. P2034 or transient DB error), try a best-effort
      // reset so the pending record does not block future retries for up to
      // STALE_PENDING_THRESHOLD_MS (60s). Without this, a stuck "pending"
      // row would prevent the agent from retrying with the same key even
      // though the operation genuinely failed.
      try {
        await prisma.idempotencyRecord.update({
          where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
          data: { status: "failed", completedAt: new Date(), error: Prisma.DbNull },
        });
      } catch {
        logIdempotencyWarn(
          `Failed to persist error result for idempotency key '${redactKey(idempotencyKey)}' and could not reset state — original error will propagate`
        );
      }
    }
    throw error;
  }

  const isSoftFailure = toolResult.success !== true;
  try {
    await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, tenantId, toolResult, isSoftFailure);
  } catch {
    // Belt-and-suspenders: the idempotency record write failed (e.g. transient DB error).
    // Log the failure but still return the tool result — the operation already executed.
    // The agent may retry with the same key, which could re-execute the operation since
    // no completed/failed record exists. This is a known limitation of the acquire-then-update
    // pattern under transient failures between acquire and update.
    logIdempotencyWarn(
      `Failed to persist result for idempotency key '${redactKey(idempotencyKey)}' — result still returned but idempotency guarantee is weakened for this key`
    );
  }

  return toolResult;
}

async function updateIdempotencyRecordWithRetry(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string,
  toolResult: ToolResult, isSoftFailure: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_RETRIES; attempt++) {
    try {
      await prisma.idempotencyRecord.update({
        // Composite PK (idempotencyKey, tenantId) — select via the
        // compound unique selector.
        where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
        data: {
          status: isSoftFailure ? "failed" : "completed",
          // Redact sensitive-named fields (password, apiKey, token, …) from
          // the success/failure payload BEFORE truncation, mirroring the
          // audit-log middleware which already applies the same redaction to
          // its `toolOutput` row. The idempotency `result` column is a second
          // durable sink of tool outputs; without this, a tool that returns a
          // value under a sensitive-named key (e.g. a "create credential"
          // tool) would persist it unredacted and replay it to the agent
          // verbatim — an asymmetric secret-leak path. Truncation runs after
          // redaction so a "[REDACTED]" placeholder is never re-expanded.
          result: toolResult.data != null
            ? (truncateValue(redactSensitiveFieldValues(toolResult.data), MAX_STORED_PAYLOAD_SIZE) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          error: isSoftFailure
            ? {
                // The hard-fail throw path scrubs the message via
                // sanitizeForLogOutput; the soft-fail path MUST too. A tool that
                // returns `{ success: false, error: { message } }` (the normal
                // Zod-validation / business-rule path — which does NOT throw)
                // would otherwise persist its message verbatim into the durable
                // 24h-TTL idempotency_record, leaking any embedded
                // connection string / secret that the thrown-error path scrubs.
                message: capString(sanitizeForLogOutput(toolResult.error?.message ?? ""), MAX_SOFT_FAILURE_MESSAGE_SIZE),
                // error.code is typed as a free-form string and is not validated
                // against an allowlist (it comes from getErrorCode), so cap it to
                // the same bound as the message and sanitize embedded URLs/paths.
                // A tool returning a multi-KB `code` would otherwise be persisted
                // verbatim in idempotency_record.error.code.
                code: capString(sanitizeForLogOutput(toolResult.error?.code ?? ""), MAX_SOFT_FAILURE_MESSAGE_SIZE),
              }
            : Prisma.DbNull,
          completedAt: new Date(),
        },
      });
      return;
    } catch (updateErr) {
      const code = getErrorCode(updateErr);
      // P2025: the idempotency record was TTL-cleaned or manually deleted
      // between acquire and update — retrying is futile. The operation already
      // ran successfully, but the result cannot be persisted. A future retry
      // with the same key will re-execute (idempotency defeated for this key).
      // Both call sites wrap this in try/catch, so returning here avoids
      // IDEMPOTENCY_MAX_RETRIES wasted attempts + backoff latency.
      if (code === "P2025") {
        const p2025Detail = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logIdempotencyWarn(
          `Idempotency record '${redactKey(idempotencyKey)}' no longer exists (expired/cleaned up between acquire and update) — result will not be persisted for replay. Detail: ${sanitizeForLogOutput(p2025Detail)}`
        );
        return;
      }
      if (attempt < LAST_RETRY_ATTEMPT) {
        await delay(retryDelayMs(IDEMPOTENCY_RETRY_BASE_DELAY_MS, attempt));
        continue;
      }
      const detail = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logIdempotencyWarn(`Failed to update idempotency record '${redactKey(idempotencyKey)}' after ${IDEMPOTENCY_MAX_RETRIES} attempts — result still returned: ${sanitizeForLogOutput(detail)}`);
      return;
    }
  }
}
