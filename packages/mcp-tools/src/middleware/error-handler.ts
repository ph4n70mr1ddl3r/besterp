// Error Handler Middleware — Catches exceptions and formats rich errors for AI.
//
// Wraps tool execution in a try/catch. Any unhandled exception is
// converted to a rich, actionable error that an AI agent can reason about.
//
// This should be the OUTERMOST middleware (registered first as global)
// so it catches errors from all subsequent middlewares and the handler.

import {
  isDomainError,
  DomainError,
} from "@besterp/shared";
import { ToolMiddleware, ToolDefinition, ToolResult } from "../schema/tool-definition.js";

/**
 * Error handler middleware — catches all exceptions and returns rich errors.
 */
export const errorHandlerMiddleware: ToolMiddleware = async (input, context, definition, next) => {
  try {
    return await next(input, context);
  } catch (error: unknown) {
    // ─── Domain errors (our structured error classes) ──────────────
    if (isDomainError(error)) {
      return {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          suggestedTools: error.suggestedTools.length > 0
            ? error.suggestedTools
            : [definition.name, "list_available_tools"],
          context: error.context,
        },
      };
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const prismaCode = (error as Record<string, unknown>).code as string | undefined;
    const prismaMeta = (error as Record<string, unknown>).meta as
      | { target?: string | string[] }
      | undefined;

    // ─── Prisma unique constraint violation ────────────────────────
    if (prismaCode === "P2002") {
      // Prisma includes the conflicting field(s) in `meta.target` (e.g.,
      // "email" or ["party_id", "role_type_id"]). Surface them so the AI
      // can correct the input rather than re-trying the same operation
      // blindly. Falls back to the generic message when meta is missing
      // (e.g., non-Prisma throwables that just happen to carry P2002).
      const target = Array.isArray(prismaMeta?.target)
        ? prismaMeta?.target.join(", ")
        : prismaMeta?.target;
      const detail = target ? ` Conflicting field(s): ${target}.` : "";
      return {
        success: false,
        error: {
          code: "DUPLICATE_ENTITY",
          message: `A duplicate entity already exists.${detail} Use 'search_${definition.entity || "entities"}' to find existing records.`,
          suggestedTools: [`search_${definition.entity || "entities"}`, definition.name],
          context: target ? { conflictingFields: target } : undefined,
        },
      };
    }

    // ─── Prisma not found ─────────────────────────────────────────
    if (prismaCode === "P2025") {
      return {
        success: false,
        error: {
          code: "ENTITY_NOT_FOUND",
          message: `The referenced entity was not found. Use 'search_${definition.entity || "entities"}' to find valid records.`,
          suggestedTools: [`search_${definition.entity || "entities"}`, `get_${definition.entity || "entity"}`],
        },
      };
    }

    // ─── Prisma optimistic concurrency / version mismatch ─────────
    // P2034: Transaction failed due to a write conflict or a deadlock
    if (prismaCode === "P2034") {
      return {
        success: false,
        error: {
          code: "CONCURRENCY_CONFLICT",
          message: `The '${definition.name}' operation conflicted with a concurrent update. Re-fetch the entity and retry with a new idempotency key.`,
          suggestedTools: [`get_${definition.entity || "entity"}`, definition.name],
        },
      };
    }

    // ─── Generic fallback ─────────────────────────────────────────
    // Log unexpected errors server-side — they may indicate a bug.
    // Domain errors and known Prisma errors are expected, so they aren't logged.
    // Use stderr for server-side logging (avoid polluting MCP stdio transport).
    process.stderr.write(
      `[MCP] [${new Date().toISOString()}] Unexpected error in '${definition.name}' (tenant=${context.tenantId}, user=${context.userId}): ${message}\n` +
      (error instanceof Error ? `${error.stack}\n` : '')
    );
    // In production, do NOT echo the raw error message to the agent — it may
    // contain DB internals, stack frames, or SQL. Send a generic message and
    // keep the detailed message on the server side (logged above).
    const isProd = process.env.NODE_ENV === "production";
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: isProd
          ? `Unexpected error in '${definition.name}'. Try again with a new idempotency key if applicable.`
          : `Unexpected error in '${definition.name}': ${message}. Try again with a new idempotency key if applicable.`,
        suggestedTools: [definition.name, "list_available_tools"],
      },
    };
  }
};
