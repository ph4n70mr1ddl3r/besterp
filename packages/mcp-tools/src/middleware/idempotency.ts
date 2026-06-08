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

import { PrismaClient } from "@prisma/client";
import { hashInput, MAX_SOFT_FAILURE_MESSAGE_SIZE } from "@besterp/shared";
import { ToolMiddleware, ToolDefinition, ToolResult, ToolContext } from "../schema/tool-definition.js";
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
    if (typeof idempotencyKey !== "string" || idempotencyKey.length > 500) {
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
    const MAX_RETRIES = 3;
    let existingRecord: any = null;
    let recordCreated = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { existing, created } = await prisma.$transaction(async (tx) => {
          const record = await tx.idempotencyRecord.findUnique({
            where: { idempotencyKey },
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
                expiresAt: new Date(Date.now() + 86400000), // 24h TTL
              },
            });
            return { existing: null, created: true };
          }

          // For failed records, atomically reset to pending inside the SAME
          // serializable transaction — eliminates the TOCTOU race where two
          // concurrent requests both see 'failed' and both re-execute.
          if (record.status === "failed") {
            await tx.idempotencyRecord.update({
              where: { idempotencyKey },
              data: { status: "pending", inputHash, expiresAt: new Date(Date.now() + 86400000) },
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
        if ((e as Record<string, unknown>).code === "P2034" && attempt < MAX_RETRIES - 1) {
          // Serialization failure — back off and retry
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        // On last attempt or non-P2034 error, break out of the loop.
        // The contention guard below will handle the case where no record
        // was created. Non-P2034 errors are re-thrown after the guard.
        if ((e as Record<string, unknown>).code !== "P2034") {
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
    try {
      const result = await next(input, context);

      // A handler can return a soft failure `{ success: false, error: { code, message, ... } }`
      // (e.g., Zod validation failure, missing reference) without throwing.
      // Treat soft failures the same as thrown errors for idempotency purposes:
      // store the result in the record and mark it `failed` so retries can re-execute
      // (or in the case of validation errors, the caller gets a consistent answer
      // on replay rather than a stale `success: true`).
      const isSoftFailure = result.success === false;

      await prisma.idempotencyRecord.update({
        where: { idempotencyKey },
        data: {
          status: isSoftFailure ? "failed" : "completed",
          // Truncate stored result to 64 KB to match the audit log cap.
          // A single tool response with a 100 MB payload would otherwise
          // produce a 100 MB row in `idempotency_record.result` that the
          // 24h-TTL cleanup job cannot control in width.
          result: result.data !== undefined
            ? (truncateValue(result.data, MAX_STORED_PAYLOAD_SIZE) as any)
            : null,
          // Cap the soft-failure message at 4 KB. A Zod validation error
          // with many issues (or a deeply nested input) can produce a
          // multi-KB message; storing it verbatim would create very wide
          // rows and bloat the cleanup-job I/O. The cap is generous enough
          // to capture every issue path Zod produces in practice.
          error: isSoftFailure
            ? {
                message: capString(result.error?.message, MAX_SOFT_FAILURE_MESSAGE_SIZE),
                code: result.error?.code,
              }
            : undefined,
          completedAt: new Date(),
        },
      });

      return result;
    } catch (error: unknown) {
      // Mark as failed
      await prisma.idempotencyRecord.update({
        where: { idempotencyKey },
        data: {
          status: "failed",
          error: { message: error instanceof Error ? error.message : String(error), code: (error as Record<string, unknown>).code as string | undefined },
        },
      }).catch((updateErr) => {
        // Log to stderr at minimum — silently swallowing means a stuck `pending`
        // record would block all future retries for this key.
        process.stderr.write(
          `[Idempotency] Failed to mark record '${idempotencyKey}' as failed: ` +
          `${updateErr instanceof Error ? updateErr.message : updateErr}\n`
        );
      });

      throw error; // re-throw for error handler middleware
    }
  };
}
