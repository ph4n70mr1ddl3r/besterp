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
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE, capString } from "./truncate.js";

/**
 * Create an idempotency middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, bypasses RLS for idempotency records)
 */
export function idempotencyMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    // Guard against misconfigured middleware (e.g., null prisma).
    if (!prisma?.idempotencyRecord) {
      process.stderr.write("[Idempotency] Prisma client not available — skipping idempotency check.\n");
      return next(input, context);
    }

    const { idempotencyKey, tenantId, userId, agentId, conversationId } = context;

    // No key = no idempotency — pass through
    if (!idempotencyKey) {
      return next(input, context);
    }

    // Defensive pre-check: the idempotency middleware runs BEFORE the Zod
    // input validator, so it sees the raw key the caller provided. If the
    // key is absurdly long (e.g., 5 KB of garbage from a buggy client), the
    // validator will reject it with INVALID_INPUT — but the middleware has
    // already created a `pending` record, the Zod layer marks it `failed`,
    // and the junk sits in the table for 24h. Bailing out here keeps the
    // table clean and matches the Zod schema's `min(1).max(500)` limit.
    if (typeof idempotencyKey !== "string" || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return next(input, context);
    }

    const toolInput = input as Record<string, unknown>;
    const inputHash = hashInput(toolInput);

    // ─── Race-free check-or-create via serializable transaction ───
    // Wrapping findUnique + create/update inside a single serializable
    // transaction prevents two concurrent requests from both seeing a
    // null result and both creating a pending record.
    //
    // Returns: { record, shouldReexecute }
    //   - record=null: no prior record, we created a pending one → proceed
    //   - record != null: existing record found → handle below
    //
    // Retry on serialization failure (P2034) — transient under concurrency.
    // If ALL retries are exhausted, we must NOT proceed without a pending
    // record (the final update would fail). Instead, return a retryable error.
    const MAX_RETRIES = IDEMPOTENCY_MAX_RETRIES;
    let existingRecord: IdempotencyRecord | null = null;
    let recordCreated = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { existing, created } = await prisma.$transaction(async (tx) => {
          // Use findFirst with tenantId for defense-in-depth tenant isolation.
          // The primary key (idempotencyKey) should be globally unique by design,
          // but adding tenantId prevents cross-tenant result leakage if callers
          // ever reuse keys across tenants.
          const record = await tx.idempotencyRecord.findFirst({
            where: { idempotencyKey, tenantId },
          });

          if (!record) {
            // No record exists — atomically create one inside the transaction
            await tx.idempotencyRecord.create({
              data: {
                idempotencyKey,
                toolName: definition.name,
                tenantId,
                userId,
                agentId: agentId || null,
                conversationId: conversationId || null,
                status: "pending",
                inputHash,
                expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
              },
            });
            return { existing: null, created: true };
          }

          // For failed records, atomically reset to pending inside the SAME
          // serializable transaction — eliminates the TOCTOU race where two
          // concurrent requests both see 'failed' and both re-execute.
          if (record.status === "failed") {
            // Reset to pending inside the SAME serializable transaction.
            // PK-only where clause is safe here because the enclosing serializable
            // transaction already verified tenant ownership via findFirst above.
            // The record cannot have been created by another tenant between the
            // findFirst and this update (serializable isolation prevents phantoms).
            await tx.idempotencyRecord.update({
              where: { idempotencyKey },
              data: { status: "pending", inputHash, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS), error: Prisma.DbNull },
            });
            return { existing: null, created: true };
          }

          return { existing: record, created: false };
        }, {
          isolationLevel: "Serializable",
        });
        existingRecord = existing;
        recordCreated = created;
        break;
      } catch (e) {
        const code = getErrorCode(e);
        if (code === "P2034" && attempt < MAX_RETRIES - 1) {
          // Serialization failure — back off and retry
          await new Promise<void>((r) => { const t = setTimeout(r, 50 * (attempt + 1)); t.unref?.(); });
          continue;
        }
        // On last attempt or non-P2034 error, break out of the loop.
        // The contention guard below will handle the case where no record
        // was created. Non-P2034 errors are re-thrown after the guard.
        if (code !== "P2034") {
          throw e;
        }
        // P2034 on last attempt — fall through to contention guard
      }
    }

    // If all retries were exhausted without creating/updating a record,
    // we cannot safely proceed — the final update would fail because no
    // pending row exists. Return a retryable error instead.
    if (!recordCreated && !existingRecord) {
      return {
        success: false,
        error: {
          code: "IDEMPOTENCY_CONTENTION",
          message: `Could not acquire idempotency record for '${idempotencyKey}' after ${MAX_RETRIES} attempts. Please retry with a new idempotency key.`,
          suggestedTools: [definition.name],
        },
      };
    }

    if (existingRecord) {
      const existing = existingRecord;
      if (existing.status === "completed") {
        if (existing.inputHash !== inputHash) {
          return {
            success: false,
            error: {
              code: "IDEMPOTENCY_KEY_MISMATCH",
              message: `Idempotency key '${idempotencyKey}' was already used with different input. Use a new idempotency key for a different operation.`,
              suggestedTools: [definition.name],
              context: { originalInputHash: existing.inputHash },
            },
          };
        }
        return {
          success: true,
          data: existing.result,
          replayed: true,
          nextActions: [`This is a replay of a previous '${definition.name}' call. No action needed.`],
        };
      }

      if (existing.status === "pending") {
        if (existing.inputHash !== inputHash) {
          return {
            success: false,
            error: {
              code: "IDEMPOTENCY_KEY_MISMATCH",
              message: `Idempotency key '${idempotencyKey}' is in use with different input. Use a new idempotency key.`,
              suggestedTools: [definition.name],
            },
          };
        }
        // Same input, still pending — another request is processing this key
        return {
          success: false,
          error: {
            code: "REQUEST_IN_PROGRESS",
            message: `A request with idempotency key '${idempotencyKey}' is already in progress. Wait and retry.`,
            suggestedTools: [definition.name],
          },
        };
      }

      // status === 'failed' case is handled atomically in the first
      // serializable transaction above. No second transaction needed.
    }

    // ─── Execute the tool ─────────────────────────────────────────
    let toolResult: ToolResult;
    try {
      toolResult = await next(input, context);
    } catch (error: unknown) {
      // Mark as failed. Verify tenant ownership first to prevent cross-tenant
      // updates if an idempotency key is ever reused across tenants.
      const record = await prisma.idempotencyRecord.findFirst({
        where: { idempotencyKey, tenantId },
        select: { idempotencyKey: true },
      }).catch(() => null);
      if (record) {
        await prisma.idempotencyRecord.update({
          where: { idempotencyKey },
          data: {
            status: "failed",
            error: { message: error instanceof Error ? error.message : String(error), code: getErrorCode(error) },
          },
        }).catch((updateErr) => {
          process.stderr.write(
            `[Idempotency] Failed to mark record '${idempotencyKey}' as failed: ` +
            `${updateErr instanceof Error ? updateErr.message : updateErr}\n`
          );
        });
      }

      throw error; // re-throw for error handler middleware
    }

    // A handler can return a soft failure `{ success: false, error: { code, message, ... } }`
    // (e.g., Zod validation failure, missing reference) without throwing.
    // Treat soft failures the same as thrown errors for idempotency purposes:
    // store the result in the record and mark it `failed` so retries can re-execute.
    const isSoftFailure = toolResult.success === false;

    // Retry the final update up to 3 times to avoid a stuck "pending" record.
    // If the update fails, retries see REQUEST_IN_PROGRESS and can never replay
    // the result until the 24h TTL cleanup. A short retry loop mitigates
    // transient DB/network errors that would otherwise break the idempotency
    // contract (caller sees success but retries get stuck).
    for (let updateAttempt = 0; updateAttempt < 3; updateAttempt++) {
      try {
        await prisma.idempotencyRecord.update({
          where: { idempotencyKey },
          data: {
            status: isSoftFailure ? "failed" : "completed",
            result: toolResult.data !== undefined
              ? (truncateValue(toolResult.data, MAX_STORED_PAYLOAD_SIZE) as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
            error: isSoftFailure
              ? {
                  message: capString(toolResult.error?.message, MAX_SOFT_FAILURE_MESSAGE_SIZE),
                  code: toolResult.error?.code,
                }
              : Prisma.DbNull,
            completedAt: new Date(),
          },
        });
        break;
      } catch (updateErr) {
        if (updateAttempt < 2) {
          await new Promise<void>((r) => { const t = setTimeout(r, 50 * (updateAttempt + 1)); t.unref?.(); });
          continue;
        }
        // All retries exhausted — log and accept stuck record.
        // The caller still receives the tool result (correct behavior).
        process.stderr.write(
          `[Idempotency] Failed to update record '${idempotencyKey}' after tool execution ` +
          `(3 attempts): ${updateErr instanceof Error ? updateErr.message : updateErr}\n`
        );
      }
    }

    return toolResult;
  };
}
