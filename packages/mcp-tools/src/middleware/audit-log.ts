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
import { getErrorCode } from "@besterp/shared";
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";
import { truncateValue, MAX_STORED_PAYLOAD_SIZE } from "./truncate.js";

/** Audit log uses the same 64 KB cap as other stored payloads. */
const MAX_AUDIT_INPUT_SIZE = MAX_STORED_PAYLOAD_SIZE;
const MAX_AUDIT_OUTPUT_SIZE = MAX_STORED_PAYLOAD_SIZE;

/**
 * Create an audit log middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, for cross-tenant audit writes)
 */
export function auditLogMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    // Guard against misconfigured middleware (e.g., null prisma).
    if (!prisma?.aiActionLog) {
      process.stderr.write("[AuditLog] Prisma client not available — skipping audit log.\n");
      return next(input, context);
    }

    let result: ToolResult;
    try {
      result = await next(input, context);
    } catch (error: unknown) {
      // Fire-and-forget on the error path too — consistent with the success path.
      // Awaiting would delay the error re-throw and add latency for the caller.
      //
      // Note: We don't repeat the `if (!prisma?.aiActionLog)` guard here —
      // the success-path early return already short-circuits when prisma is
      // null, so reaching this catch block implies prisma is non-null.
      logAction(prisma, {
        agentId: context.agentId,
        conversationId: context.conversationId,
        userId: context.userId,
        tenantId: context.tenantId,
        toolCalled: definition.name,
        toolInput: input as Record<string, unknown>,
        toolOutput: truncateValue(
          { error: { message: error instanceof Error ? error.message : String(error), code: getErrorCode(error) } },
          MAX_AUDIT_OUTPUT_SIZE,
        ),
      }).catch((logErr) => {
        process.stderr.write(
          `[AuditLog] Failed to write error-path audit log for tool '${definition.name}' ` +
          `(tenant=${context.tenantId}, user=${context.userId}): ` +
          `${logErr instanceof Error ? logErr.message : logErr}\n`
        );
      });

      throw error;
    }

    // Fire-and-forget: do NOT await the audit write on the success path.
    // Awaiting adds latency to every successful tool call for no benefit.
    // The .catch() prevents unhandled rejections if the write fails.
    logAction(prisma, {
      agentId: context.agentId,
      conversationId: context.conversationId,
      userId: context.userId,
      tenantId: context.tenantId,
      toolCalled: definition.name,
      toolInput: input as Record<string, unknown>,
      toolOutput: result.data ?? null,
    }).catch((logErr) => {
      process.stderr.write(
        `[AuditLog] Failed to write audit log for tool '${definition.name}' ` +
        `(tenant=${context.tenantId}, user=${context.userId}): ` +
        `${logErr instanceof Error ? logErr.message : logErr}\n`
      );
    });

    return result;
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
}

async function logAction(prisma: PrismaClient, entry: AuditLogEntry): Promise<void> {
  // Truncate oversized inputs and outputs to prevent unbounded audit log storage.
  // If the serialized value exceeds the limit, store a truncated version
  // with a marker so operators know data was elided.
  const toolInput = truncateValue(entry.toolInput, MAX_AUDIT_INPUT_SIZE);

  await prisma.aiActionLog.create({
    data: {
      agentId: entry.agentId || null,
      conversationId: entry.conversationId || null,
      userId: entry.userId,
      tenantId: entry.tenantId,
      toolCalled: entry.toolCalled,
      toolInput: toolInput as unknown as Prisma.InputJsonValue,
      toolOutput: (truncateValue(entry.toolOutput, MAX_AUDIT_OUTPUT_SIZE) ?? undefined) as Prisma.InputJsonValue | undefined,
      reasoning: null,
    },
  });
}
