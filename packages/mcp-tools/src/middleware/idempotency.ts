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
import { hashInput, getErrorCode, sanitizeForLog, sanitizeLogOutput, InvalidTypeValueError, MAX_SOFT_FAILURE_MESSAGE_SIZE, IDEMPOTENCY_TTL_MS, MAX_IDEMPOTENCY_KEY_LENGTH, IDEMPOTENCY_MAX_RETRIES, IDEMPOTENCY_RETRY_BASE_DELAY_MS } from "@besterp/shared";
import { ToolMiddleware, ToolResult, ToolContext } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE, capString } from "./truncate.js";

/**
 * Create an idempotency middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, bypasses RLS for idempotency records)
 */
export function idempotencyMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    if (!prisma?.idempotencyRecord) {
      logIdempotencyWarn("Prisma client not available — skipping idempotency check");
      return next(input, context);
    }

    const { idempotencyKey, tenantId, userId, agentId, conversationId } = context;

    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return next(input, context);
    }

    // Parse the input through the tool's schema FIRST, then hash the
    // transformed/normalized data. This ensures semantically identical inputs
    // (e.g., "name" and " name  " after Zod's .trim() transform) produce
    // the same hash, preventing false IDEMPOTENCY_KEY_MISMATCH errors on
    // retries with normalized input.
    //
    // This means Zod validation runs twice (here and in the final handler),
    // but Zod is fast and the cost is negligible compared to the DB round-trips.
    // The parsed data is intentionally NOT cached between middleware layers to
    // keep the middleware interface simple (input + context).
    const parseResult = definition.inputSchema.safeParse(input);
    const hashedInput = parseResult.success ? parseResult.data : input;

    let inputHash: string;
    try {
      inputHash = hashInput(hashedInput);
    } catch {
      // Circular references or unserializable input — skip idempotency
      // rather than crashing the entire tool pipeline. Log a warning so
      // operators can identify tools that consistently produce unhashable input.
      logIdempotencyWarn(
        `Skipping idempotency for '${definition.name}': input cannot be hashed (circular reference or unserializable type)`
      );
      return next(input, context);
    }

    const { existingRecord, recordCreated } = await acquireIdempotencyRecord(prisma, idempotencyKey, tenantId, userId, agentId, conversationId, definition.name, inputHash);

    if (!recordCreated && !existingRecord) {
      // All retries exhausted due to serialization failures (P2034)
      const safeKey = sanitizeForLog(idempotencyKey.slice(0, 32));
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_CONTENTION",
          message: `Could not acquire idempotency record for '${safeKey}' after ${IDEMPOTENCY_MAX_RETRIES} attempts. Please retry with a new idempotency key.`,
          suggestedTools: [definition.name],
        },
      };
    }

    if (existingRecord) {
      return handleExistingRecord(existingRecord, inputHash, idempotencyKey, definition.name);
    }

    return executeAndUpdate(prisma, idempotencyKey, tenantId, input, context, definition, next);
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

function logIdempotencyWarn(message: string): void {
  process.stderr.write(`[Idempotency] ${JSON.stringify({ timestamp: new Date().toISOString(), message })}\n`);
}

async function acquireIdempotencyRecord(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string, userId: string,
  agentId: string | undefined, conversationId: string | undefined,
  toolName: string, inputHash: string,
): Promise<{ existingRecord: IdempotencyRecord | null; recordCreated: boolean }> {
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_RETRIES; attempt++) {
    try {
      const { existing, created } = await prisma.$transaction(async (tx) => {
        const record = await tx.idempotencyRecord.findFirst({ where: { idempotencyKey, tenantId } });

        if (!record) {
          await tx.idempotencyRecord.create({
            data: {
              idempotencyKey, toolName, tenantId, userId,
              agentId: agentId || null, conversationId: conversationId || null,
              status: "pending", inputHash,
              expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
            },
          });
          return { existing: null, created: true };
        }

        if (record.status === "failed") {
          if (record.inputHash !== inputHash) {
            return { existing: record, created: false };
          }
          await tx.idempotencyRecord.update({
            // Composite PK (idempotencyKey, tenantId) — select via the
            // compound unique selector.
            where: { idempotencyKey_tenantId: { idempotencyKey, tenantId } },
            data: { status: "pending", inputHash, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS), error: Prisma.DbNull },
          });
          return { existing: null, created: true };
        }

        return { existing: record, created: false };
      }, { isolationLevel: "Serializable" });

      return { existingRecord: existing, recordCreated: created };
    } catch (e) {
      const code = getErrorCode(e);
      if (code === "P2034" && attempt < IDEMPOTENCY_MAX_RETRIES - 1) {
        await delay(IDEMPOTENCY_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      // Non-P2034 errors (connection failures, auth errors, schema mismatches)
      // are fatal — log them so operators can distinguish infrastructure issues
      // from normal serialization contention.
      if (code !== "P2034") {
        logIdempotencyWarn(
          `Non-retryable error acquiring idempotency record '${sanitizeForLog(idempotencyKey.slice(0, 32))}' (code=${code ?? "none"}): ${e instanceof Error ? e.message : String(e)}`
        );
      }
      // Return contention failure instead of throwing so the middleware
      // can produce a structured error response for the AI agent.
      return { existingRecord: null, recordCreated: false };
    }
  }
  // Exhausted all retries — surface contention rather than a silent fallthrough.
  // The for-loop always returns via try/catch, but TS needs an unconditional
  // return after the loop for flow analysis (TS2366).
  return { existingRecord: null, recordCreated: false };
}

function handleExistingRecord(
  existing: IdempotencyRecord, inputHash: string,
  idempotencyKey: string, toolName: string,
): ToolResult {
  if (existing.status === "completed") {
    if (existing.inputHash !== inputHash) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: `Idempotency key '${sanitizeForLog(idempotencyKey.slice(0, 32))}' was already used with different input. Use a new idempotency key for a different operation.`,
          suggestedTools: [toolName],
          context: { originalInputHash: existing.inputHash },
        },
      };
    }
    const data = existing.result;
    const isTruncated = data != null && typeof data === "object" && "_truncated" in (data as Record<string, unknown>);
    return {
      success: true,
      data,
      replayed: true,
      nextActions: [
        `This is a replay of a previous '${toolName}' call. No action needed.`,
        ...(isTruncated ? ["Note: The original result was truncated for storage."] : []),
      ],
    };
  }

  if (existing.status === "pending") {
    if (existing.inputHash !== inputHash) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: `Idempotency key '${sanitizeForLog(idempotencyKey.slice(0, 32))}' is in use with different input. Use a new idempotency key.`,
          suggestedTools: [toolName],
        },
      };
    }
    return {
      success: false,
      error: {
        code: "REQUEST_IN_PROGRESS",
        message: `A request with idempotency key '${sanitizeForLog(idempotencyKey.slice(0, 32))}' is already in progress. Wait and retry.`,
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
          message: `Idempotency key '${sanitizeForLog(idempotencyKey.slice(0, 32))}' was previously used with different input. Use a new idempotency key.`,
          suggestedTools: [toolName],
          context: { originalInputHash: existing.inputHash },
        },
      };
    }
    // Input matches a previously failed attempt. Under normal operation,
    // acquireIdempotencyRecord resets the record to "pending" (returning
    // created: true) so this branch is unreachable. The fallback returns
    // INTERNAL_ERROR to surface the anomaly rather than silently dropping it.
    return { success: false, error: { code: "INTERNAL_ERROR", message: "Unexpected idempotency state: failed record with matching hash was not reset by acquireIdempotencyRecord." } };
  }

  return { success: false, error: { code: "INTERNAL_ERROR", message: "Unexpected idempotency state" } };
}

async function executeAndUpdate(
  prisma: PrismaClient, idempotencyKey: string, tenantId: string,
  input: unknown, context: ToolContext,
  definition: { name: string },
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
      sanitizeLogOutput(error instanceof Error ? error.message : String(error)),
      MAX_SOFT_FAILURE_MESSAGE_SIZE,
    );
    const failedResult: ToolResult = {
      success: false,
      error: { code: getErrorCode(error) ?? "EXECUTION_ERROR", message },
    };
    await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, tenantId, failedResult, true);
    throw error;
  }

  const isSoftFailure = toolResult.success === false;
  await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, tenantId, toolResult, isSoftFailure);

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
          result: toolResult.data != null
            ? (truncateValue(toolResult.data, MAX_STORED_PAYLOAD_SIZE) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          error: isSoftFailure
            ? { message: capString(toolResult.error?.message, MAX_SOFT_FAILURE_MESSAGE_SIZE), code: toolResult.error?.code }
            : Prisma.DbNull,
          completedAt: new Date(),
        },
      });
      return;
    } catch (updateErr) {
      if (attempt < IDEMPOTENCY_MAX_RETRIES - 1) {
        await delay(IDEMPOTENCY_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      const detail = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logIdempotencyWarn(`Failed to update idempotency record '${sanitizeForLog(idempotencyKey.slice(0, 32))}' after ${IDEMPOTENCY_MAX_RETRIES} attempts: ${detail}`);
      throw new InvalidTypeValueError(
        `Idempotency record could not be updated after ${IDEMPOTENCY_MAX_RETRIES} attempts. ` +
        `The operation may have succeeded but subsequent retries will receive REQUEST_IN_PROGRESS. ` +
        `Detail: ${sanitizeForLog(detail)}`,
        { cause: updateErr },
      );
    }
  }
}
