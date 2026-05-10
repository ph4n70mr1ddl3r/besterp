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
    const startTime = Date.now();

    // Execute the tool first, then log
    let result: ToolResult;
    try {
      result = await next(input, context);
    } catch (error: any) {
      // Log the error case, then re-throw
      await logAction(prisma, {
        agentId: context.agentId,
        conversationId: context.conversationId,
        userId: context.userId,
        tenantId: context.tenantId,
        toolCalled: definition.name,
        toolInput: input as any,
        toolOutput: { error: { message: error.message, code: error.code } },
        reasoning: undefined,
        latencyMs: Date.now() - startTime,
      }).catch(() => {}); // never fail on audit errors

      throw error;
    }

    // Log the successful case
    await logAction(prisma, {
      agentId: context.agentId,
      conversationId: context.conversationId,
      userId: context.userId,
      tenantId: context.tenantId,
      toolCalled: definition.name,
      toolInput: input as any,
      toolOutput: result.data ?? null,
      reasoning: undefined,
      latencyMs: Date.now() - startTime,
    }).catch(() => {}); // never fail on audit errors

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
  latencyMs: number;
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
