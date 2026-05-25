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
import { hashInput } from "@besterp/shared";
import { ToolMiddleware, ToolDefinition, ToolResult, ToolContext } from "../schema/tool-definition.js";

/**
 * Create an idempotency middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, bypasses RLS for idempotency records)
 */
export function idempotencyMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    const { idempotencyKey, tenantId, userId, agentId, conversationId } = context;

    // No key = no idempotency — pass through
    if (!idempotencyKey) {
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
    const { existing: existingRecord } = await prisma.$transaction(async (tx) => {
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
        return { existing: null, reexecuteNeeded: false };
      }

      // For failed records, atomically reset to pending inside the SAME
      // serializable transaction — eliminates the TOCTOU race where two
      // concurrent requests both see 'failed' and both re-execute.
      if (record.status === "failed") {
        await tx.idempotencyRecord.update({
          where: { idempotencyKey },
          data: { status: "pending", inputHash, expiresAt: new Date(Date.now() + 86400000) },
        });
        return { existing: null, reexecuteNeeded: false };
      }

      return { existing: record, reexecuteNeeded: false };
    }, {
      isolationLevel: "Serializable",
    });

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

      // Store result in idempotency record
      await prisma.idempotencyRecord.update({
        where: { idempotencyKey },
        data: {
          status: "completed",
          result: result.data as any ?? null,
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
      }).catch(() => {}); // ignore update errors

      throw error; // re-throw for error handler middleware
    }
  };
}
