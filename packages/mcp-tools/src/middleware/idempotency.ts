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
import { hashInput, getErrorCode, sanitizeForLogOutput, redactSensitiveFieldValues, normalizeUnpairedSurrogates, MAX_SOFT_FAILURE_MESSAGE_SIZE, IDEMPOTENCY_TTL_MS, MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, IDEMPOTENCY_MAX_RETRIES, IDEMPOTENCY_RETRY_BASE_DELAY_MS, IDEMPOTENCY_STALE_PENDING_THRESHOLD_MS, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH } from "@besterp/shared";
import { ToolMiddleware, ToolResult, ToolContext, ZodSchemaLike } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE, capString, isTruncationMarker } from "./truncate.js";
import { IDEMPOTENCY_CONTENTION, IDEMPOTENCY_KEY_MISMATCH, IDEMPOTENCY_UNAVAILABLE, IDEMPOTENCY_UNKNOWN_STATUS, INVALID_IDEMPOTENCY_KEY, REQUEST_IN_PROGRESS, SERVICE_UNAVAILABLE, STALE_PENDING_RECORD } from "../error-codes.js";
import { sanitizeDurableIdentity } from "../identity.js";

const MAX_RETRY_ATTEMPT = IDEMPOTENCY_MAX_RETRIES - 1;

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
          code: INVALID_IDEMPOTENCY_KEY,
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
          code: INVALID_IDEMPOTENCY_KEY,
          message: "The idempotency key contains invalid characters. Keys must be printable ASCII (no control characters, newlines, or non-ASCII bytes).",
          suggestedTools: [toolName],
          context: { keyPrefix: safeKey },
        },
      },
    };
  }
  return { valid: true, key };
}

/**
 * Outcome of computing the idempotency hash for a tool input.
 *
 * - `invalid-input`: the input does not satisfy the tool's schema, so the
 *   handler will reject it and NO side effect will occur. Deduplication is
 *   unnecessary, and the request proceeds.
 * - `unhashable`: the input IS schema-valid but cannot be hashed (a
 *   DoS-guard rejection or an unserializable value). The handler WILL run
 *   and WILL perform its side effect, so the request must NOT proceed
 *   without deduplication — that is a fail-CLOSED outcome.
 * - `ok`: the hash was computed.
 */
type HashOutcome =
  | { status: "ok"; hash: string }
  | { status: "invalid-input" }
  | { status: "unhashable"; reason: string };

function computeInputHash(input: unknown, definition: { name: string; inputSchema: ZodSchemaLike }): HashOutcome {
  const parseResult = definition.inputSchema.safeParse(input);
  if (!parseResult.success) {
    // Zod parse failure means the input is malformed — no side effect will be
    // produced, so idempotency dedup is unnecessary. Log so operators can
    // detect pathological inputs (e.g. circular refs that pass Zod but break
    // the serializer, or schema drift that silently drops fields). Previously
    // this path was completely silent while the serialization-failure path
    // below emitted a warning, making the two skip reasons inconsistently
    // observable.
    logIdempotencyWarn(
      `Skipping idempotency for '${definition.name}': input failed Zod validation (${parseResult.error.issues.length} issue(s))`
    );
    return { status: "invalid-input" };
  }
  try {
    return { status: "ok", hash: hashInput(parseResult.data) };
  } catch (error) {
    // The DoS guards in `hashInput` (key-count and CPU-time budgets) reject
    // an input that is too large to canonicalise. That is NOT the same
    // failure as a circular reference, and the distinction matters: the
    // former means the handler WILL run a write, the latter means it might.
    // The previous log message claimed "circular reference or unserializable
    // type" for both.
    const reason = error instanceof Error ? error.message : "unknown hashing failure";
    logIdempotencyWarn(
      `Idempotency for '${definition.name}' cannot be applied: the input cannot be hashed (${sanitizeForLogOutput(reason)})`
    );
    return { status: "unhashable", reason: sanitizeForLogOutput(reason) };
  }
}

function handleUnhashableInput(toolName: string): ToolResult {
  return {
    success: false,
    error: {
      code: IDEMPOTENCY_UNAVAILABLE,
      // Fail CLOSED. The previous behaviour passed the request through
      // WITHOUT creating an idempotency record, so the write executed with
      // deduplication silently disabled and the agent was never told — a
      // retry of the same request (with the same key) would execute the
      // side effect a second time. Refusing the request is the only safe
      // option for a write whose input cannot be deduplicated.
      message: "The request is too large to deduplicate safely. Reduce the size of the request and retry with a new idempotency key.",
      suggestedTools: [toolName],
    },
  };
}

function handleRecordUnavailable(toolName: string): ToolResult {
  return {
    success: false,
    error: {
      code: SERVICE_UNAVAILABLE,
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
      code: IDEMPOTENCY_CONTENTION,
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
    const { idempotencyKey, tenantId, userId, agentId, conversationId } = context;

    const keyResult = validateIdempotencyKey(idempotencyKey, definition.name);
    if (!keyResult.valid) return keyResult.error;
    // No key → there is nothing to deduplicate, so the call is a no-op
    // pass-through whether or not the store is reachable.
    if (!keyResult.key) return next(input, context);

    // A KEY was supplied, so deduplication is part of the caller's contract.
    // The store being unreachable must therefore FAIL CLOSED.
    //
    // The middleware used to pass the call through ("Prisma client not
    // available — skipping idempotency check"), so the write executed with
    // deduplication silently DISABLED and the agent was never told — a retry
    // of the same request executed the side effect a second time. That is
    // the exact failure the sibling `handleUnhashableInput` path refuses to
    // accept, and the sibling guards in the same pipeline (agent policy,
    // confirmation gate) are explicitly fail-closed for the same "we could
    // not check" situation.
    if (!prisma?.idempotencyRecord) {
      logIdempotencyWarn("Prisma client not available — refusing the call because idempotency cannot be applied");
      return handleRecordUnavailable(definition.name);
    }

    const hashOutcome = computeInputHash(input, definition);
    if (hashOutcome.status === "invalid-input") return next(input, context);
    if (hashOutcome.status === "unhashable") return handleUnhashableInput(definition.name);
    const inputHash = hashOutcome.hash;

    // The SANITIZED identity is what the durable record stores, so it is
    // also what the caller-identity comparison must use.
    const { safeUserId, safeAgentId, safeConversationId } = sanitizeIdentityFields(userId, agentId, conversationId);

    const { existingRecord, recordCreated, unavailable } = await acquireIdempotencyRecord(
      prisma, keyResult.key, tenantId, safeUserId, safeAgentId, safeConversationId, definition.name, inputHash,
    );

    if (!recordCreated && !existingRecord) {
      return unavailable
        ? handleRecordUnavailable(definition.name)
        : handleRecordContention(keyResult.key, definition.name);
    }

    if (existingRecord) {
      return handleExistingRecord(existingRecord, inputHash, keyResult.key, definition.name, safeUserId, safeAgentId);
    }

    return executeAndUpdate(prisma, keyResult.key, tenantId, input, context, next);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // The timer is deliberately NOT unref'd. An unref'd backoff timer does
    // not keep the event loop alive, so a process whose only pending work is
    // the retry backoff could EXIT in the middle of the retry — leaving the
    // idempotency record stuck in "pending" and the retry never performed.
    // The backoff is bounded (a handful of short sleeps), so holding the
    // loop open for it is harmless.
    setTimeout(resolve, ms);
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

/**
 * Read the idempotency record for (key, tenant) outside the failed
 * transaction. Returns null when the row does not exist or the read itself
 * fails — the caller then treats the situation as an infrastructure outage.
 */
async function readIdempotencyRecord(
  prisma: PrismaClient,
  idempotencyKey: string,
  tenantId: string,
): Promise<IdempotencyRecord | null> {
  try {
    const record = await prisma.idempotencyRecord.findUnique({
      where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
    });
    // An EXPIRED record is not a deduplication record any more: the TTL is
    // the contract that says "after this point the key may be reused". See
    // `isExpiredRecord` for why the TTL has to be enforced HERE and not only
    // by the out-of-band cleanup job.
    return record && isExpiredRecord(record) ? null : record;
  } catch {
    return null;
  }
}

/**
 * True when the record's TTL has elapsed.
 *
 * The 24-hour TTL used to be enforced ONLY by the out-of-band cleanup script
 * (`npm run db:cleanup`), which nothing schedules: there is no cron, no
 * `@nestjs/schedule`, no job in this repository. A `completed` record from
 * months ago was therefore still found by the primary-key lookup and
 * REPLAYED FOREVER, and a `failed` record from months ago was reset to
 * `pending` and the side effect RE-EXECUTED — the TTL contract was not
 * enforced by the component that owns it.
 *
 * The middleware now honours the TTL itself, so the guarantee does not
 * depend on an out-of-band job ever being run.
 */
function isExpiredRecord(record: IdempotencyRecord): boolean {
  const expiresAt = record.expiresAt;
  if (!expiresAt) return false;
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return false;
  return expiry <= Date.now();
}

async function acquireIdempotencyRecord(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string,
  safeUserId: string, safeAgentId: string | undefined, safeConversationId: string | undefined,
  toolName: string, inputHash: string,
): Promise<{ existingRecord: IdempotencyRecord | null; recordCreated: boolean; unavailable?: boolean }> {
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_RETRIES; attempt++) {
    try {
      const { existing, created } = await prisma.$transaction(async (tx) => {
        const record = await tx.idempotencyRecord.findUnique({ where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } } });

        if (record && isExpiredRecord(record)) {
          // The TTL has elapsed: the key is free again. The expired row is
          // removed and a fresh one is created, so the key is reusable by
          // ANY caller (not just the one that owned the expired record).
          await tx.idempotencyRecord.delete({
            where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
          });
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

        if (!record) {
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
          if (!canClaimRecord(record, inputHash, toolName, safeUserId, safeAgentId)) {
            // Different input, a different tool reusing the key, or a
            // DIFFERENT CALLER: do NOT reset-and-re-execute — the caller must
            // use a new key. Routing the existing record back surfaces the
            // mismatch error via handleExistingRecord (which now also checks
            // toolName and the caller identity).
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
            // The same guard as the other reset branches: only claim the
            // record when it belongs to this caller, this tool and this input.
            if (!canClaimRecord(record, inputHash, toolName, safeUserId, safeAgentId)) {
              return { existing: record, created: false };
            }
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
            // operation or a different tool reusing the key. The caller
            // identity must match too, for the same reason.
            if (!canClaimRecord(record, inputHash, toolName, safeUserId, safeAgentId)) {
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
      if (code === "P2034" && attempt < MAX_RETRY_ATTEMPT) {
        await delay(retryDelayMs(IDEMPOTENCY_RETRY_BASE_DELAY_MS, attempt));
        continue;
      }
      // P2002 (unique violation on the composite key) means a CONCURRENT
      // request inserted the same (idempotencyKey, tenantId) row between our
      // findUnique and our create. That is CONTENTION, not an infrastructure
      // outage: the other request holds the record. Re-read the row and route
      // it through handleExistingRecord so the agent gets the actionable
      // REQUEST_IN_PROGRESS / replay semantics instead of a misleading
      // SERVICE_UNAVAILABLE ("the operation cannot be retried at this time").
      if (code === "P2002") {
        const record = await readIdempotencyRecord(prisma, idempotencyKey, tenantId);
        if (record) return { existingRecord: record, recordCreated: false };
        // The concurrent row is GONE — the other transaction rolled back, or
        // the row expired (the TTL is honoured by the middleware itself, so
        // an expired record is deleted and re-created). That is not an
        // infrastructure outage: retry the acquire loop, which will create
        // the record. Reporting SERVICE_UNAVAILABLE here was misleading
        // ("the idempotency store is temporarily unavailable") for a
        // situation that resolves on the next attempt.
        if (attempt < MAX_RETRY_ATTEMPT) {
          await delay(retryDelayMs(IDEMPOTENCY_RETRY_BASE_DELAY_MS, attempt));
          continue;
        }
        return { existingRecord: null, recordCreated: false, unavailable: true };
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

/**
 * Sanitize the identity fields before they are persisted to (and compared
 * against) the durable `idempotency_record` table.
 *
 * `userId`/`agentId`/`conversationId` are caller-supplied and may embed
 * secrets (connection strings, `?api_key=…`); the raw values were already
 * format-validated by `buildContext` and `validateContextIdentity`, but
 * sanitization is still required so the durable sink never stores a raw
 * secret.
 *
 * `keepOpaqueTokens: true` matches the AUDIT sink exactly (see
 * audit-log.ts's `sanitizeIdentityField`). Without it the generic
 * long-token rule rewrote every 20-128 character id that mixed letters and
 * digits to "[REDACTED_TOKEN]" — so the SAME conversationId was stored
 * verbatim in `ai_action_log` and destroyed in `idempotency_record`. The
 * two durable sinks disagreed about who performed the operation, and the
 * idempotency row could no longer be correlated to the audit row, to the
 * user or to the agent. The recognised-secret rules still apply, so a
 * secret embedded in an identity field is still scrubbed.
 *
 * The SANITIZED values are what gets stored, so they are also what the
 * caller-identity comparison must use — comparing the raw context value
 * against the stored sanitized value would report a mismatch for the very
 * caller that created the record.
 */
function sanitizeIdentityFields(
  userId: string, agentId: string | undefined, conversationId: string | undefined,
): { safeUserId: string; safeAgentId: string | undefined; safeConversationId: string | undefined } {
  // The shared sanitizer is the canonical implementation for the durable
  // identity fields — the audit sink uses the SAME one, so the two sinks can
  // never disagree about who performed an operation.
  //
  // It returns null for an identity that is not stable under the sanitizer
  // (a secret-shaped value, whose sanitized form is the SAME placeholder for
  // every such value — which would make two DIFFERENT callers
  // indistinguishable and let the second one replay the first one's stored
  // result). The registry rejects such an identity before the pipeline runs,
  // so the fallback here is unreachable in practice; the empty string keeps
  // the NOT NULL column satisfiable if it ever is reached.
  const stableUserId = sanitizeDurableIdentity(userId, MAX_USER_ID_LENGTH) ?? "";
  const stableAgentId = agentId !== undefined
    ? sanitizeDurableIdentity(agentId, MAX_AGENT_ID_LENGTH) ?? ""
    : undefined;
  const stableConversationId = conversationId !== undefined
    ? sanitizeDurableIdentity(conversationId, MAX_CONVERSATION_ID_LENGTH) ?? ""
    : undefined;
  return {
    safeUserId: stableUserId,
    safeAgentId: stableAgentId,
    safeConversationId: stableConversationId,
  };
}

/**
 * True when the stored record belongs to the same CALLER as the current
 * request.
 *
 * The idempotency record's primary key is `(idempotencyKey, tenantId)` —
 * the key is tenant-scoped, not user-scoped. Two different users in the
 * same tenant can therefore collide on the same key, and the stored
 * `userId`/`agentId` were never compared. The second user received the
 * FIRST user's stored result as a `success: true` replay — a cross-user
 * disclosure of another user's entity payload, and the second user's own
 * operation never ran.
 *
 * The caller identity is part of the deduplication identity: a key is one
 * operation by one caller, so a collision across callers is a mismatch
 * (use a new key), not a replay.
 */
function isSameCaller(existing: IdempotencyRecord, userId: string, agentId: string | undefined): boolean {
  if (existing.userId !== userId) return false;
  const storedAgent = existing.agentId ?? null;
  const currentAgent = agentId ?? null;
  return storedAgent === currentAgent;
}

/**
 * True when this request may CLAIM the stored record — that is, when it
 * belongs to the same caller, the same tool and the same input.
 *
 * Every reset branch (failed → pending, stale pending → pending, and the
 * null-createdAt recovery) uses this single predicate, so a record can never
 * be reclaimed for a different operation, a different tool, or a different
 * CALLER.
 */
function canClaimRecord(
  record: IdempotencyRecord, inputHash: string, toolName: string,
  safeUserId: string, safeAgentId: string | undefined,
): boolean {
  return record.inputHash === inputHash
    && record.toolName === toolName
    && isSameCaller(record, safeUserId, safeAgentId);
}

/**
 * The error returned when a key is already owned by a different caller.
 */
function callerMismatchError(
  idempotencyKey: string, toolName: string,
): ToolResult {
  return {
    success: false,
    error: {
      code: IDEMPOTENCY_KEY_MISMATCH,
      message: `Idempotency key '${redactKey(idempotencyKey)}' was already used by another caller in this tenant. ` +
        `Idempotency keys are scoped to a single caller — use a new idempotency key for a different operation.`,
      suggestedTools: [toolName],
    },
  };
}

function handleExistingRecord(
  existing: IdempotencyRecord, inputHash: string,
  idempotencyKey: string, toolName: string,
  userId: string, agentId: string | undefined,
): ToolResult {
  // An idempotency key identifies ONE operation by ONE caller. The record's
  // PK is (idempotencyKey, tenantId) and the input hash is computed over the
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
        code: IDEMPOTENCY_KEY_MISMATCH,
        message: `Idempotency key '${redactKey(idempotencyKey)}' was already used by tool '${sanitizeForLogOutput(existing.toolName)}'. ` +
          `Use a new idempotency key for a different operation.`,
        suggestedTools: [toolName],
      },
    };
  }
  // The key belongs to a DIFFERENT caller. Replaying their result would
  // disclose their entity payload and silently skip this caller's own
  // operation, so it is a mismatch — the caller must use a fresh key.
  if (!isSameCaller(existing, userId, agentId)) {
    return callerMismatchError(idempotencyKey, toolName);
  }
  if (existing.status === "completed") {
    if (existing.inputHash !== inputHash) {
      return {
        success: false,
        error: {
          code: IDEMPOTENCY_KEY_MISMATCH,
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
      // redactSensitiveFieldValues, so the two sinks stay consistent.
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
            code: IDEMPOTENCY_KEY_MISMATCH,
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
            code: STALE_PENDING_RECORD,
            message: `Idempotency key '${redactKey(idempotencyKey)}' has a stale pending record (${Math.round(pendingAge / 1000)}s old) with different input. The previous request likely crashed. Retry with a new idempotency key.`,
            suggestedTools: [toolName],
          },
        };
      }
      return {
        success: false,
        error: {
          code: IDEMPOTENCY_KEY_MISMATCH,
          message: `Idempotency key '${redactKey(idempotencyKey)}' is in use with different input. Use a new idempotency key.`,
          suggestedTools: [toolName],
        },
      };
    }
    return {
      success: false,
      error: {
        code: REQUEST_IN_PROGRESS,
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
          code: IDEMPOTENCY_KEY_MISMATCH,
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
        code: REQUEST_IN_PROGRESS,
        message: `Idempotency key '${redactKey(idempotencyKey)}' has a failed record that is being reset. Wait and retry.`,
        suggestedTools: [toolName],
      },
    };
  }

  return {
    success: false,
    error: {
      code: IDEMPOTENCY_UNKNOWN_STATUS,
      message: `Unexpected idempotency status '${existing.status}' for key '${redactKey(idempotencyKey)}'. Retry with a new idempotency key.`,
      suggestedTools: [toolName],
      context: { status: existing.status },
    },
  };
}

async function executeAndUpdate(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string,
  input: unknown, context: ToolContext,
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
      normalizeUnpairedSurrogates(sanitizeForLogOutput(error instanceof Error ? error.message : String(error))),
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
          normalizeUnpairedSurrogates(sanitizeForLogOutput(getErrorCode(error) ?? "EXECUTION_ERROR")),
          MAX_SOFT_FAILURE_MESSAGE_SIZE,
        ),
        message,
      },
    };
    try {
      // `updateIdempotencyRecordWithRetry` NEVER throws — it reports whether
      // the update was persisted. The previous implementation wrapped the call
      // in a try/catch whose catch block was therefore UNREACHABLE, so the
      // best-effort "reset the record to failed" fallback never ran: a write
      // whose result could not be persisted left the record in "pending",
      // which blocked the agent's retries with the same key for the whole
      // stale-pending window (60 s) even though the operation genuinely
      // failed.
      const persisted = await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, tenantId, failedResult, true);
      if (!persisted) {
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
    } catch {
      // Defensive: the helper is documented not to throw, but a future change
      // must never leave the record stuck in "pending" — fall back to the
      // best-effort reset.
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
    const persisted = await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, tenantId, toolResult, isSoftFailure);
    if (!persisted) {
      // The idempotency record write failed (e.g. transient DB error).
      // Log the failure but still return the tool result — the operation
      // already executed. The agent may retry with the same key, which could
      // re-execute the operation since no completed/failed record exists.
      // This is a known limitation of the acquire-then-update pattern under
      // transient failures between acquire and update.
      logIdempotencyWarn(
        `Failed to persist result for idempotency key '${redactKey(idempotencyKey)}' — result still returned but idempotency guarantee is weakened for this key`
      );
    }
  } catch {
    // Belt-and-suspenders: the idempotency record write failed (e.g. transient DB error).
    // Log the failure but still return the tool result — the operation already executed.
    logIdempotencyWarn(
      `Failed to persist result for idempotency key '${redactKey(idempotencyKey)}' — result still returned but idempotency guarantee is weakened for this key`
    );
  }

  return toolResult;
}

/**
 * Persist the outcome of an executed tool call onto the idempotency record.
 *
 * Returns `true` when the record was updated, `false` when it could NOT be
 * (the record no longer exists, or every retry attempt failed). It NEVER
 * throws — the callers use the return value to decide whether the
 * best-effort "reset to failed" fallback is required.
 */
async function updateIdempotencyRecordWithRetry(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string,
  toolResult: ToolResult, isSoftFailure: boolean,
): Promise<boolean> {
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
                message: capString(normalizeUnpairedSurrogates(sanitizeForLogOutput(toolResult.error?.message ?? "")), MAX_SOFT_FAILURE_MESSAGE_SIZE),
                // error.code is typed as a free-form string and is not validated
                // against an allowlist (it comes from getErrorCode), so cap it to
                // the same bound as the message and sanitize embedded URLs/paths.
                // A tool returning a multi-KB `code` would otherwise be persisted
                // verbatim in idempotency_record.error.code.
                code: capString(normalizeUnpairedSurrogates(sanitizeForLogOutput(toolResult.error?.code ?? "")), MAX_SOFT_FAILURE_MESSAGE_SIZE),
              }
            : Prisma.DbNull,
          completedAt: new Date(),
        },
      });
      return true;
    } catch (updateErr) {
      const code = getErrorCode(updateErr);
      // P2025: the idempotency record was TTL-cleaned or manually deleted
      // between acquire and update — retrying is futile. The operation already
      // ran successfully, but the result cannot be persisted. A future retry
      // with the same key will re-execute (idempotency defeated for this key).
      // The callers inspect the return value to decide whether the
      // best-effort "reset to failed" fallback is required, so returning
      // here avoids IDEMPOTENCY_MAX_RETRIES wasted attempts + backoff latency.
      if (code === "P2025") {
        const p2025Detail = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logIdempotencyWarn(
          `Idempotency record '${redactKey(idempotencyKey)}' no longer exists (expired/cleaned up between acquire and update) — result will not be persisted for replay. Detail: ${sanitizeForLogOutput(p2025Detail)}`
        );
        return false;
      }
      if (attempt < MAX_RETRY_ATTEMPT) {
        await delay(retryDelayMs(IDEMPOTENCY_RETRY_BASE_DELAY_MS, attempt));
        continue;
      }
      const detail = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logIdempotencyWarn(`Failed to update idempotency record '${redactKey(idempotencyKey)}' after ${IDEMPOTENCY_MAX_RETRIES} attempts — result still returned: ${sanitizeForLogOutput(detail)}`);
      return false;
    }
  }
  // The loop always returns from inside the try/catch (success → true,
  // P2025 → false, retries exhausted → false); this is unreachable but keeps
  // the function total for the type checker.
  return false;
}
