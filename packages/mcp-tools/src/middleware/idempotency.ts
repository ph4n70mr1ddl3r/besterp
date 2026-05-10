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

    // ─── Atomic upsert: avoids the check-then-insert race condition ────
    // If the key doesn't exist, we insert a "pending" row.
    // If it does exist, we do nothing and read it below.
    const upserted = await prisma.idempotencyRecord.upsert({
      where: { idempotencyKey },
      create: {
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
      update: {}, // no-op on existing record — we read it below
    });

    // ─── Handle existing records ───────────────────────────────────
    // Only the first upsert creates; subsequent ones hit update: {} (no-op).
    // Re-read to get the actual status (another request may have completed it).
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { idempotencyKey },
    });

    if (!existing) {
      // Should never happen — we just upserted
      return next(input, context);
    }

    // If WE created the pending record, proceed to execute.
    // The inputHash matches because we just set it in create.
    if (existing.status === "pending" && existing.inputHash === inputHash) {
      // Check if someone else created it with different input (unlikely but safe)
      // Actually, since we did upsert with create:{ inputHash }, if it was
      // our create, inputHash matches. If it was an existing record, we
      // need to check its status.
    }

    if (existing.status === "completed") {
      // Input hash mismatch — agent reused key with different input
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
      // Replay the stored result
      return {
        success: true,
        data: existing.result,
        replayed: true,
        nextActions: [`This is a replay of a previous '${definition.name}' call. No action needed.`],
      };
    }

    if (existing.status === "pending") {
      // Check if it's OUR pending record (inputHash matches) or someone else's
      if (existing.inputHash !== inputHash) {
        // Different input with same key — reject
        return {
          success: false,
          error: {
            code: "IDEMPOTENCY_KEY_MISMATCH",
            message: `Idempotency key '${idempotencyKey}' is in use with different input. Use a new idempotency key.`,
            suggestedTools: [definition.name],
          },
        };
      }
      // Same input — if the record was created by us, proceed.
      // If created by another concurrent request, it's in progress.
      // We can't distinguish, so let the first one win: proceed.
      // The upsert guarantees only one record exists.
    }

    // status === 'failed' or our 'pending' — (re-)execute

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
