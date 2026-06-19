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
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";

/**
 * Error handler middleware — catches all exceptions and returns rich errors.
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  person: "people",
  child: "children",
  mouse: "mice",
  goose: "geese",
  man: "men",
  woman: "women",
  tooth: "teeth",
  foot: "feet",
  ox: "oxen",
  datum: "data",
  analysis: "analyses",
  crisis: "crises",
  index: "indices",
};

function pluralize(entity: string): string {
  const lower = entity.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (lower.endsWith("y") && !lower.endsWith("ay") && !lower.endsWith("ey") && !lower.endsWith("oy") && !lower.endsWith("uy")) {
    return entity.slice(0, -1) + "ies";
  }
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("ch") || lower.endsWith("sh")) {
    return entity + "es";
  }
  return entity + "s";
}

function extractPrismaError(error: unknown): { code: string | undefined; meta: { target?: string | string[] } | undefined } {
  if (error != null && typeof error === "object") {
    return {
      code: (error as Record<string, unknown>).code as string | undefined,
      meta: (error as Record<string, unknown>).meta as { target?: string | string[] } | undefined,
    };
  }
  return { code: undefined, meta: undefined };
}

function handleDomainError(error: DomainError, definition: { name: string }): ToolResult {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      suggestedTools: error.suggestedTools.length > 0 ? error.suggestedTools : [definition.name, "list_available_tools"],
      context: error.context,
    },
  };
}

function handlePrismaError(prismaCode: string, prismaMeta: { target?: string | string[] } | undefined, entityName: string, entityPlural: string, definition: { name: string }) {
  if (prismaCode === "P2002") {
    const target = Array.isArray(prismaMeta?.target) ? prismaMeta.target.join(", ") : prismaMeta?.target;
    return {
      success: false,
      error: {
        code: "DUPLICATE_ENTITY",
        message: `A duplicate entity already exists.${target ? ` Conflicting field(s): ${target}.` : ""} Use 'search_${entityPlural}' to find existing records.`,
        suggestedTools: [`search_${entityPlural}`, definition.name],
        context: target ? { conflictingFields: target } : undefined,
      },
    };
  }

  if (prismaCode === "P2025") {
    return {
      success: false,
      error: {
        code: "ENTITY_NOT_FOUND",
        message: `The referenced entity was not found. Use 'search_${entityPlural}' to find valid records.`,
        suggestedTools: [`search_${entityPlural}`, `get_${entityName}`],
      },
    };
  }

  if (prismaCode === "P2034") {
    return {
      success: false,
      error: {
        code: "CONCURRENCY_CONFLICT",
        message: `The '${definition.name}' operation conflicted with a concurrent update. Re-fetch the entity and retry with a new idempotency key.`,
        suggestedTools: [`get_${entityName}`, definition.name],
      },
    };
  }

  return null;
}

function handleGenericError(error: unknown, definition: { name: string }, tenantId: string, userId: string): ToolResult {
  const message = error instanceof Error ? error.message : "Unknown error";
  const isDev = process.env.NODE_ENV === "development";
  // Only log stack traces in non-production to avoid leaking internals via log aggregators
  if (isDev) {
    process.stderr.write(
      `[MCP] [${new Date().toISOString()}] Unexpected error in '${definition.name}' (tenant=${tenantId}, user=${userId}): ${message}\n` +
      (error instanceof Error ? `${error.stack}\n` : "")
    );
  }
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: isDev
        ? `Unexpected error in '${definition.name}': ${message}. Try again with a new idempotency key if applicable.`
        : `Unexpected error in '${definition.name}'. Try again with a new idempotency key if applicable.`,
      suggestedTools: [definition.name, "list_available_tools"],
    },
  };
}

export const errorHandlerMiddleware: ToolMiddleware = async (input, context, definition, next) => {
  try {
    return await next(input, context);
  } catch (error: unknown) {
    if (isDomainError(error)) {
      return handleDomainError(error, definition);
    }

    const { code: prismaCode, meta: prismaMeta } = extractPrismaError(error);
    const entityName = definition.entity || "entity";
    const entityPlural = pluralize(entityName);

    if (prismaCode) {
      const result = handlePrismaError(prismaCode, prismaMeta, entityName, entityPlural, definition);
      if (result) return result;
    }

    return handleGenericError(error, definition, context.tenantId, context.userId);
  }
};
