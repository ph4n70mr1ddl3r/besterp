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
// Uses UPSERT to avoid the check-then-insert race condition — two concurrent
// requests with the same key will not both create a pending record.
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

    // Check for an existing record first
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
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

      // status === 'failed' — re-execute by updating to pending
      await prisma.idempotencyRecord.update({
        where: { idempotencyKey },
        data: { status: "pending", inputHash },
      });
    } else {
      // No existing record — create a new pending record
      await prisma.idempotencyRecord.create({
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
    } catch (error: any) {
      // Mark as failed
      await prisma.idempotencyRecord.update({
        where: { idempotencyKey },
        data: {
          status: "failed",
          error: { message: error.message, code: error.code },
        },
      }).catch(() => {}); // ignore update errors

      throw error; // re-throw for error handler middleware
    }
  };
}
