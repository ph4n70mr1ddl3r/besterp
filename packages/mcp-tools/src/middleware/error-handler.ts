// Error Handler Middleware — Catches exceptions and formats rich errors for AI.
//
// Wraps tool execution in a try/catch. Any unhandled exception is
// converted to a rich, actionable error that an AI agent can reason about.
//
// This should be the OUTERMOST middleware (registered first as global)
// so it catches errors from all subsequent middlewares and the handler.

import {
  isDomainError,
  sanitizeLogMessage,
  sanitizeForLogOutput,
  pluralize,
  redactSensitiveFieldValues,
  type DomainError,
} from "@besterp/shared";
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";

// All redaction in this file (sensitive-named keys, string-leaf sanitization,
// and recursion-depth bounding) is delegated entirely to the shared
// `redactSensitiveFieldValues` (imported below), which owns MAX_REDACTION_DEPTH.
// There is no local depth guard — the shared redactor is the single source of
// truth so this agent-facing surface cannot diverge from the audit-log surface.

function extractPrismaError(error: unknown): { code: string | undefined; meta: { target?: string | string[] } | undefined } {
  if (error != null && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    const code = typeof raw.code === "string" ? raw.code : undefined;
    const rawMeta = raw.meta;
    if (rawMeta != null && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
      const metaObj = rawMeta as Record<string, unknown>;
      const target = metaObj.target;
      // Non-empty array of strings, or a single string. Empty arrays pass
      // .every() vacuously but carry no semantic meaning for error context.
      const validatedTarget = (typeof target === "string")
        ? target
        : (Array.isArray(target) && target.length > 0 && target.every((t) => typeof t === "string"))
          ? target
          : undefined;
      return { code, meta: validatedTarget !== undefined ? { target: validatedTarget } : undefined };
    }
    return { code, meta: undefined };
  }
  return { code: undefined, meta: undefined };
}

/** Maximum length for a single error message in the error handler stderr log. */
const MAX_ERROR_LOG_LINE_LENGTH = 500;

function sanitizeContextValueForToolResult(value: unknown): unknown {
  const sanitized = redactSensitiveFieldValues(value);
  if (sanitized === null || sanitized === undefined) return undefined;
  // Preserve arrays so structured data (e.g. { issues: [...] }) is reflected
  // to the agent instead of being silently dropped. Element-level redaction
  // (URLs/paths/secrets) is handled by redactSensitiveFieldValues below.
  if (Array.isArray(sanitized)) return sanitized;
  // Preserve empty objects so the agent sees that context was provided even
  // when it carries no keys — dropping them silently made it impossible to
  // distinguish "no context" from "empty context", and the audit-log path
  // preserves empty objects so the two surfaces were inconsistent.
  if (typeof sanitized === "object") {
    return sanitized as Record<string, unknown>;
  }
  return sanitized;
}

function handleDomainError(error: DomainError, definition: { name: string }): ToolResult {
  return {
    success: false,
    error: {
      // error.code is a free-form string that a custom DomainError subclass
      // could set to a sensitive value. Sanitize it consistently with every
      // other agent-facing field so a crafted code is not reflected verbatim.
      code: sanitizeForLogOutput(error.code),
      message: sanitizeForLogOutput(error.message),
      // suggestedTools strings come from DomainError constructor values (a
      // custom subclass could interpolate user input), so sanitize each one
      // like every other agent-facing field — the fallback list is static and
      // unaffected.
      suggestedTools: (error.suggestedTools?.length ?? 0) > 0
        ? [...error.suggestedTools].map((t) => sanitizeForLogOutput(t))
        : [definition.name, "list_available_tools"],
      context: sanitizeContextValueForToolResult(error.context) as Record<string, unknown> | undefined,
    },
  };
}

interface PrismaErrorResult {
  success: false;
  error: {
    code: string;
    message: string;
    suggestedTools: string[];
    context?: Record<string, unknown>;
  };
}
type ErrorFactory = (entityName: string, entityPlural: string, definition: { name: string }, prismaMeta: { target?: string | string[] } | undefined) => PrismaErrorResult | null;

const PRISMA_ERROR_HANDLERS: Record<string, ErrorFactory> = {
  P2002(_entityName, entityPlural, definition, prismaMeta) {
    // meta.target is a schema-derived field/column name, but it is
    // user-influenced in compound-constraint scenarios and is echoed to the
    // agent (and into context.conflictingFields). Sanitize it like every
    // other externally-derived string in this file so a crafted/garbage
    // target cannot inject ANSI/CRLF into the agent-facing message.
    const rawTarget = Array.isArray(prismaMeta?.target) ? prismaMeta.target.join(", ") : prismaMeta?.target;
    const target = rawTarget ? sanitizeForLogOutput(rawTarget) : undefined;
    return {
      success: false,
      error: {
        code: "DUPLICATE_ENTITY",
        message: `A duplicate entity already exists.${target ? ` Conflicting field(s): ${target}.` : ""} Use 'search_${entityPlural}' to find existing records.`,
        suggestedTools: [`search_${entityPlural}`, definition.name],
        context: target ? { conflictingFields: target } : undefined,
      },
    };
  },
  P2025(entityName, entityPlural) {
    return {
      success: false,
      error: {
        code: "ENTITY_NOT_FOUND",
        message: `The '${entityName}' entity was not found. Use 'search_${entityPlural}' to find valid records.`,
        suggestedTools: [`search_${entityPlural}`, `get_${entityName}`],
      },
    };
  },
  P2034(entityName, _entityPlural, definition) {
    return {
      success: false,
      error: {
        code: "CONCURRENCY_CONFLICT",
        message: `The '${definition.name}' operation conflicted with a concurrent update. Re-fetch the entity and retry with the same idempotency key (do not use a new key).`,
        suggestedTools: [`get_${entityName}`, definition.name],
      },
    };
  },
  P2003(_entityName, entityPlural, definition) {
    return {
      success: false,
      error: {
        code: "REFERENCE_ERROR",
        message: `A referenced entity was not found. Check foreign key values and ensure all referenced ${entityPlural} exist.`,
        suggestedTools: [`search_${entityPlural}`, definition.name],
      },
    };
  },
  P2000(_entityName, _entityPlural, definition) {
    return {
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: `A field value is too long for the column. Check field length limits and retry with shorter values.`,
        suggestedTools: [definition.name],
      },
    };
  },
  P2014(_entityName, entityPlural, definition) {
    return {
      success: false,
      error: {
        code: "REFERENCE_ERROR",
        message: `A required relation is missing or violates a constraint. Check that all required related ${entityPlural} exist and are properly linked.`,
        suggestedTools: [`search_${entityPlural}`, definition.name],
      },
    };
  },
  P2021() {
    return {
      success: false,
      error: {
        code: "DATABASE_ERROR",
        message: `A database table is missing. The schema may need to be migrated. Try again after running migrations.`,
        suggestedTools: ["list_available_tools"],
      },
    };
  },
  P2028(entityName, _entityPlural, definition) {
    return {
      success: false,
      error: {
        code: "CONCURRENCY_CONFLICT",
        message: `The '${definition.name}' operation on ${entityName} timed out. Re-fetch the entity and retry with the same idempotency key (do not use a new key).`,
        suggestedTools: [`get_${entityName}`, definition.name],
      },
    };
  },
  P2024(_entityName, _entityPlural, definition) {
    return {
      success: false,
      error: {
        code: "DATABASE_CONNECTION_ERROR",
        message: `The '${definition.name}' operation timed out waiting for a database connection from the pool. The service may be under heavy load. Retry the same request with the same idempotency key (do not use a new key — the first attempt's outcome is unknown).`,
        suggestedTools: [definition.name, "list_available_tools"],
      },
    };
  },
};

const CONNECTION_ERROR_CODES = new Set(["P1000", "P1001", "P1002", "P1003", "P1017"]);

function handlePrismaError(prismaCode: string, prismaMeta: { target?: string | string[] } | undefined, entityName: string, entityPlural: string, definition: { name: string }): PrismaErrorResult | null {
  if (CONNECTION_ERROR_CODES.has(prismaCode)) {
    return {
      success: false,
      error: {
        code: "DATABASE_CONNECTION_ERROR",
        // Same-key guidance: P1017 (connection dropped mid-flight) is the
        // ambiguous-outcome case where a new key defeats idempotency — the
        // original write may have committed, and the first attempt's
        // idempotency record is exactly what a same-key retry needs to
        // replay or deduplicate. Minting a new key can double-execute and
        // contradicts the key-hopping rationale documented in
        // idempotency.ts. The unreachable-server codes (P1001-P1003) never
        // started the operation, where same-key is equally safe.
        message: "The database connection failed. The service may be temporarily unavailable. Retry the same request with the same idempotency key (do not use a new key).",
        suggestedTools: ["list_available_tools"],
      },
    };
  }

  const factory = PRISMA_ERROR_HANDLERS[prismaCode];
  return factory ? factory(entityName, entityPlural, definition, prismaMeta) : null;
}

function handleGenericError(error: unknown, definition: { name: string }, tenantId: string, userId: string): ToolResult {
  const safeMessage = sanitizeForLogOutput(error instanceof Error ? error.message : "Unknown error").slice(0, MAX_ERROR_LOG_LINE_LENGTH);
  // Log sanitized details to stderr to prevent leaking sensitive info
  // (DB hostnames, connection strings, stack frames). tenantId and userId
  // are sanitized to prevent JSON corruption if they contain `]` or `"` chars.
  try {
    process.stderr.write(
      `[MCP] [${new Date().toISOString()}] Unexpected error in '${sanitizeLogMessage(definition.name)}' (tenant=${sanitizeForLogOutput(tenantId)}, user=${sanitizeForLogOutput(userId)}): ${safeMessage}\n`
    );
  } catch {
    // stderr may be closed (e.g., container redirect during shutdown) —
    // suppress to prevent the log itself from surfacing as an uncaught
    // exception, matching the pattern used by audit-log.ts and idempotency.ts.
  }
  // Always return a generic message to the AI agent to prevent leaking internals
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `Unexpected error in '${definition.name}'. Check server logs for details. If this was a write, retry the same request with the same idempotency key (do not use a new key).`,
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

    if (prismaCode) {
      const entityName = definition.entity ?? "entity";
      const entityPlural = pluralize(entityName);
      const result = handlePrismaError(prismaCode, prismaMeta, entityName, entityPlural, definition);
      if (result) return result;
    }

    return handleGenericError(error, definition, context.tenantId, context.userId);
  }
};
