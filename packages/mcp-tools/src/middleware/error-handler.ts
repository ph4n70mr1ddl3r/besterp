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
  sanitizeForLog,
  sanitizeLogOutput,
  pluralize,
} from "@besterp/shared";
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";

function extractPrismaError(error: unknown): { code: string | undefined; meta: { target?: string | string[] } | undefined } {
  if (error != null && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    const code = typeof raw.code === "string" ? raw.code : undefined;
    const rawMeta = raw.meta;
    if (rawMeta != null && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
      const metaObj = rawMeta as Record<string, unknown>;
      const target = metaObj.target;
      const validatedTarget = (typeof target === "string" || (Array.isArray(target) && target.every((t) => typeof t === "string")))
        ? target as string | string[]
        : undefined;
      return { code, meta: validatedTarget !== undefined ? { target: validatedTarget } : undefined };
    }
    return { code, meta: undefined };
  }
  return { code: undefined, meta: undefined };
}

/** Maximum length for a single error message in the error handler stderr log. */
const MAX_ERROR_LOG_LINE_LENGTH = 500;

function sanitizeErrorMessage(message: string): string {
  return sanitizeLogOutput(sanitizeForLog(message)).slice(0, MAX_ERROR_LOG_LINE_LENGTH);
}

function sanitizeContextValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeErrorMessage(value);
  if (Array.isArray(value)) return value.map(sanitizeContextValue);
  if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
    return "[ITERABLE]";
  }
  if (value != null && typeof value === "object" && !(value instanceof Date || value instanceof RegExp)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeContextValue(v);
    }
    return result;
  }
  if (value === undefined) return null;
  return value;
}

function sanitizeContextValueForToolResult(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeContextValue(value);
  if (sanitized === null || sanitized === undefined) return undefined;
  if (typeof sanitized === "object" && sanitized !== null) {
    return sanitized as Record<string, unknown>;
  }
  return undefined;
}

function handleDomainError(error: DomainError, definition: { name: string }): ToolResult {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      suggestedTools: error.suggestedTools.length > 0 ? error.suggestedTools : [definition.name, "list_available_tools"],
      context: sanitizeContextValueForToolResult(error.context),
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

  if (prismaCode === "P2003") {
    return {
      success: false,
      error: {
        code: "REFERENCE_ERROR",
        message: `A referenced entity was not found. Check foreign key values and ensure all referenced ${entityPlural} exist.`,
        suggestedTools: [`search_${entityPlural}`, definition.name],
      },
    };
  }

  if (prismaCode === "P2000") {
    return {
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: `A field value is too long for the column. Check field length limits and retry with shorter values.`,
        suggestedTools: [definition.name],
      },
    };
  }

  if (prismaCode === "P2014") {
    return {
      success: false,
      error: {
        code: "REFERENCE_ERROR",
        message: `A required relation is missing or violates a constraint. Check that all required related ${entityPlural} exist and are properly linked.`,
        suggestedTools: [`search_${entityPlural}`, definition.name],
      },
    };
  }

  if (prismaCode === "P2021") {
    return {
      success: false,
      error: {
        code: "DATABASE_ERROR",
        message: `A database table is missing. The schema may need to be migrated. Try again after running migrations.`,
        suggestedTools: ["list_available_tools"],
      },
    };
  }

  if (prismaCode === "P1001" || prismaCode === "P1000") {
    return {
      success: false,
      error: {
        code: "DATABASE_CONNECTION_ERROR",
        message: "The database connection failed. The service may be temporarily unavailable. Try again with a new idempotency key.",
        suggestedTools: ["list_available_tools"],
      },
    };
  }

  return null;
}

function handleGenericError(error: unknown, definition: { name: string }, tenantId: string, userId: string): ToolResult {
  const message = error instanceof Error ? error.message : "Unknown error";
  const safeMessage = sanitizeErrorMessage(message);
  // Log sanitized details to stderr to prevent leaking sensitive info
  // (DB hostnames, connection strings, stack frames)
  process.stderr.write(
    `[MCP] [${new Date().toISOString()}] Unexpected error in '${sanitizeForLog(definition.name)}' (tenant=${tenantId}, user=${userId}): ${safeMessage}\n`
  );
  // Always return a generic message to the AI agent to prevent leaking internals
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `Unexpected error in '${definition.name}'. Check server logs for details. Try again with a new idempotency key if applicable.`,
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
    const entityName = definition.entity ?? "entity";
    const entityPlural = pluralize(entityName);

    if (prismaCode) {
      const result = handlePrismaError(prismaCode, prismaMeta, entityName, entityPlural, definition);
      if (result) return result;
    }

    return handleGenericError(error, definition, context.tenantId, context.userId);
  }
};
