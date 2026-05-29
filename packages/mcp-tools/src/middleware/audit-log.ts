// Audit Log Middleware — Logs all AI agent actions for traceability.
//
// Implements Principle 8 from AGENTIC_AI_DESIGN.md: Every action is auditable
// for AI traceability. Captures who (human), what (agent), why (reasoning),
// and how (tools called).
//
// This is a "fire-and-forget" middleware — it logs asynchronously and never
// blocks tool execution. Log failures are silently ignored (audit should
// never break the tool).

import { PrismaClient } from "@prisma/client";
import { ToolMiddleware, ToolDefinition, ToolResult } from "../schema/tool-definition.js";

/**
 * Create an audit log middleware backed by PostgreSQL.
 *
 * @param prisma - Admin PrismaClient (superuser, for cross-tenant audit writes)
 */
export function auditLogMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    // Guard against misconfigured middleware (e.g., null prisma).
    if (!prisma?.aiActionLog) {
      console.warn("[AuditLog] Prisma client not available — skipping audit log.");
      return next(input, context);
    }

    let result: ToolResult;
    try {
      result = await next(input, context);
    } catch (error: unknown) {
      await logAction(prisma, {
        agentId: context.agentId,
        conversationId: context.conversationId,
        userId: context.userId,
        tenantId: context.tenantId,
        toolCalled: definition.name,
        toolInput: input as any,
        toolOutput: { error: { message: error instanceof Error ? error.message : String(error), code: (error as Record<string, unknown>).code as string | undefined } },
        reasoning: undefined,
      }).catch((logErr) => {
        console.warn(`[AuditLog] Failed to write audit log: ${logErr instanceof Error ? logErr.message : logErr}`);
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
      toolInput: input as any,
      toolOutput: result.data ?? null,
      reasoning: undefined,
    }).catch((logErr) => {
      console.warn(`[AuditLog] Failed to write audit log: ${logErr instanceof Error ? logErr.message : logErr}`);
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
  reasoning?: string;
}

async function logAction(prisma: PrismaClient, entry: AuditLogEntry): Promise<void> {
  await prisma.aiActionLog.create({
    data: {
      agentId: entry.agentId || null,
      conversationId: entry.conversationId || null,
      userId: entry.userId,
      tenantId: entry.tenantId,
      toolCalled: entry.toolCalled,
      toolInput: entry.toolInput as any,
      toolOutput: entry.toolOutput as any,
      reasoning: entry.reasoning || null,
    },
  });
}
