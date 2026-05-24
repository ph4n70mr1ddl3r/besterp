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

    // ─── Prisma unique constraint violation ────────────────────────
    if (prismaCode === "P2002") {
      return {
        success: false,
        error: {
          code: "DUPLICATE_ENTITY",
          message: `A duplicate entity already exists. Use 'search_${definition.entity || "entities"}' to find existing records.`,
          suggestedTools: [`search_${definition.entity || "entities"}`, definition.name],
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

    // ─── Legacy string-pattern errors (backward compat) ───────────
    // Some services still throw `new Error("CODE: message")`
    const colonIndex = message.indexOf(": ");
    if (colonIndex > 0 && message.slice(0, colonIndex).includes("_")) {
      const code = message.slice(0, colonIndex);
      const detail = message.slice(colonIndex + 2);
      return {
        success: false,
        error: {
          code,
          message: detail,
          suggestedTools: [definition.name, "list_available_tools"],
        },
      };
    }

    // ─── Generic fallback ─────────────────────────────────────────
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Unexpected error in '${definition.name}': ${message}. Try again with a new idempotency key if applicable.`,
        suggestedTools: [definition.name, "list_available_tools"],
      },
    };
  }
};
