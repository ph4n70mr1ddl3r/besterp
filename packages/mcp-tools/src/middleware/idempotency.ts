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
import { hashInput, getErrorCode, MAX_SOFT_FAILURE_MESSAGE_SIZE, IDEMPOTENCY_TTL_MS, MAX_IDEMPOTENCY_KEY_LENGTH, IDEMPOTENCY_MAX_RETRIES } from "@besterp/shared";
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

    if (!idempotencyKey) return next(input, context);

    if (typeof idempotencyKey !== "string" || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return next(input, context);
    }

    const inputHash = hashInput(input);

    const { existingRecord, recordCreated } = await acquireIdempotencyRecord(prisma, idempotencyKey, tenantId, userId, agentId, conversationId, definition.name, inputHash);

    if (!recordCreated && !existingRecord) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_CONTENTION",
          message: `Could not acquire idempotency record for '${idempotencyKey}' after ${IDEMPOTENCY_MAX_RETRIES} attempts. Please retry with a new idempotency key.`,
          suggestedTools: [definition.name],
        },
      };
    }

    if (existingRecord) {
      return handleExistingRecord(existingRecord, inputHash, idempotencyKey, definition.name);
    }

    return executeAndUpdate(prisma, idempotencyKey, input, context, definition, next);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
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
          await tx.idempotencyRecord.update({
            where: { idempotencyKey },
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
        await delay(50 * (attempt + 1));
        continue;
      }
      if (code !== "P2034") throw e;
    }
  }

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
          message: `Idempotency key '${idempotencyKey}' was already used with different input. Use a new idempotency key for a different operation.`,
          suggestedTools: [toolName],
          context: { originalInputHash: existing.inputHash },
        },
      };
    }
    return {
      success: true,
      data: existing.result,
      replayed: true,
      nextActions: [`This is a replay of a previous '${toolName}' call. No action needed.`],
    };
  }

  if (existing.status === "pending") {
    if (existing.inputHash !== inputHash) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: `Idempotency key '${idempotencyKey}' is in use with different input. Use a new idempotency key.`,
          suggestedTools: [toolName],
        },
      };
    }
    return {
      success: false,
      error: {
        code: "REQUEST_IN_PROGRESS",
        message: `A request with idempotency key '${idempotencyKey}' is already in progress. Wait and retry.`,
        suggestedTools: [toolName],
      },
    };
  }

  return { success: false, error: { code: "INTERNAL_ERROR", message: "Unexpected idempotency state" } };
}

async function executeAndUpdate(
  prisma: PrismaClient, idempotencyKey: string,
  input: unknown, context: ToolContext,
  definition: { name: string },
  next: (input: unknown, context: ToolContext) => Promise<ToolResult>,
): Promise<ToolResult> {
  let toolResult: ToolResult;
  try {
    toolResult = await next(input, context);
  } catch (error: unknown) {
    await prisma.idempotencyRecord.update({
      where: { idempotencyKey },
      data: {
        status: "failed",
        error: { message: error instanceof Error ? error.message : String(error), code: getErrorCode(error) },
      },
    }).catch((updateErr) => {
      logIdempotencyWarn(`Failed to mark idempotency record '${idempotencyKey}' as failed: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
    });
    throw error;
  }

  const isSoftFailure = toolResult.success === false;
  await updateIdempotencyRecordWithRetry(prisma, idempotencyKey, toolResult, isSoftFailure);

  return toolResult;
}

async function updateIdempotencyRecordWithRetry(
  prisma: PrismaClient, idempotencyKey: string,
  toolResult: ToolResult, isSoftFailure: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_RETRIES; attempt++) {
    try {
      await prisma.idempotencyRecord.update({
        where: { idempotencyKey },
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
        await delay(50 * (attempt + 1));
        continue;
      }
      logIdempotencyWarn(`Failed to update idempotency record '${idempotencyKey}' after ${IDEMPOTENCY_MAX_RETRIES} attempts: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
    }
  }
}
