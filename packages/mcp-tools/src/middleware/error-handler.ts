// Error Handler Middleware — Catches exceptions and formats rich errors for AI.
//
// Wraps tool execution in a try/catch. Any unhandled exception is
// converted to a rich, actionable error that an AI agent can reason about.
//
// This should be the OUTERMOST middleware (registered first as global)
// so it catches errors from all subsequent middlewares and the handler.

import {
  isDomainError,
  getErrorCode,
  sanitizeLogMessage,
  sanitizeForLogOutput,
  pluralize,
  MAX_ERROR_LOG_LINE_LENGTH,
  type DomainError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyConflictError,
} from "@besterp/shared";
import { ToolMiddleware, ToolResult } from "../schema/tool-definition.js";
import { sanitizeAgentFacingResult } from "../agent-result.js";
import {
  REFERENCE_ERROR,
  INVALID_INPUT,
  DATABASE_ERROR,
  DATABASE_CONNECTION_ERROR,
  INTERNAL_ERROR,
} from "../error-codes.js";

// All redaction in this file (sensitive-named keys, string-leaf sanitization,
// and recursion-depth bounding) is delegated entirely to the shared
// `redactSensitiveFieldValues` (imported below), which owns MAX_REDACTION_DEPTH.
// There is no local depth guard — the shared redactor is the single source of
// truth so this agent-facing surface cannot diverge from the audit-log surface.

function extractPrismaError(error: unknown): { code: string | undefined; meta: { target?: string | string[] } | undefined } {
  // The code extraction is delegated to the shared `getErrorCode` helper, so
  // there is exactly ONE implementation of "read a machine-readable error
  // code" in the codebase. This function used to re-implement the same
  // `typeof raw.code === "string"` check that `audit-log.ts` and
  // `idempotency.ts` both import — three call sites, one canonical helper.
  const code = getErrorCode(error);
  if (error != null && typeof error === "object") {
    const rawMeta = (error as Record<string, unknown>).meta;
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
  }
  return { code, meta: undefined };
}

function handleDomainError(error: DomainError, definition: { name: string }): ToolResult {
  // The values are returned RAW here and sanitized by
  // `sanitizeAgentFacingResult` (the shared agent-facing boundary) right
  // after. Doing the sanitizing in ONE place is what keeps the REST filter,
  // the MCP error path, the audit row and the idempotency record in
  // agreement — the previous version sanitized here AND in the audit
  // middleware, with the two implementations drifting apart.
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      suggestedTools: (error.suggestedTools?.length ?? 0) > 0
        ? [...error.suggestedTools]
        : [definition.name, "list_available_tools"],
      context: error.context as Record<string, unknown> | undefined,
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

/**
 * The follow-up tools the agent may call for the failing entity.
 *
 * Both names come from the tool definition's `relatedTools` declaration —
 * they are guaranteed to be REGISTERED tool names. The previous
 * implementation derived them from the entity string
 * (`search_${pluralize(entity)}` / `get_${entity}`), which produced names
 * that do not exist ("search_agent_registryies", "get_type_table"), so an
 * agent that followed the suggestion received UNKNOWN_TOOL. When a tool
 * declares no mapping, only the failing tool and `list_available_tools` are
 * suggested — every suggestion must be callable.
 */
interface RelatedTools {
  get?: string;
  search?: string;
}

function resolveRelatedTools(definition: { name: string; relatedTools?: RelatedTools }): RelatedTools {
  return definition.relatedTools ?? {};
}

type ErrorFactory = (entityName: string, entityPlural: string, definition: { name: string; relatedTools?: RelatedTools }, prismaMeta: { target?: string | string[] } | undefined) => PrismaErrorResult | null;

/**
 * The Prisma code → error factory table.
 *
 * It is a PLAIN OBJECT LITERAL, so `PRISMA_ERROR_HANDLERS[prismaCode]` walks
 * the prototype chain: a thrown error carrying `code: "__proto__"` resolved to
 * `Object.prototype` (truthy!) and was then CALLED as a factory, throwing a
 * `TypeError` from inside this function — i.e. from inside the `catch` block
 * of the error handler, which is the last line of defence. The exception
 * escaped `registry.execute()` entirely and the agent received an
 * unstructured HTTP 500 instead of the structured `INTERNAL_ERROR` every
 * other failure produces. `code: "constructor"` was worse: it resolved to
 * `Object`, was called, and returned a STRING — so `execute()` resolved with
 * `"entity"` and the MCP controller answered 200 with the JSON string
 * `"entity"` as the whole response body.
 *
 * The lookup therefore uses `Object.hasOwn` (see `handlePrismaError`).
 */
const PRISMA_ERROR_HANDLERS: Record<string, ErrorFactory> = {
  P2002(_entityName, _entityPlural, definition, prismaMeta) {
    // meta.target is a schema-derived field/column name, but it is
    // user-influenced in compound-constraint scenarios and is echoed to the
    // agent (and into context.conflictingFields). Sanitize it like every
    // other externally-derived string in this file so a crafted/garbage
    // target cannot inject ANSI/CRLF into the agent-facing message.
    const rawTarget = Array.isArray(prismaMeta?.target) ? prismaMeta.target.join(", ") : prismaMeta?.target;
    const target = rawTarget ? sanitizeForLogOutput(rawTarget) : undefined;
    const related = resolveRelatedTools(definition);
    const searchHint = related.search ? ` Use '${related.search}' to find existing records.` : "";
    return {
      success: false,
      error: {
        code: DuplicateEntityError.CODE,
        message: `A duplicate entity already exists.${target ? ` Conflicting field(s): ${target}.` : ""}${searchHint}`,
        suggestedTools: [related.search, definition.name].filter((t): t is string => t !== undefined),
        context: target ? { conflictingFields: target } : undefined,
      },
    };
  },
  P2025(entityName, _entityPlural, definition) {
    const related = resolveRelatedTools(definition);
    const searchHint = related.search ? ` Use '${related.search}' to find valid records.` : "";
    return {
      success: false,
      error: {
        code: EntityNotFoundError.CODE,
        message: `The '${entityName}' entity was not found.${searchHint}`,
        suggestedTools: [related.search, related.get, definition.name].filter((t): t is string => t !== undefined),
      },
    };
  },
  P2034(_entityName, _entityPlural, definition) {
    const related = resolveRelatedTools(definition);
    return {
      success: false,
      error: {
        code: ConcurrencyConflictError.CODE,
        message: `The '${definition.name}' operation conflicted with a concurrent update. Re-fetch the entity and retry with the same idempotency key (do not use a new key).`,
        suggestedTools: [related.get, definition.name].filter((t): t is string => t !== undefined),
      },
    };
  },
  P2003(_entityName, entityPlural, definition) {
    const related = resolveRelatedTools(definition);
    return {
      success: false,
      error: {
        code: REFERENCE_ERROR,
        message: `A referenced entity was not found. Check foreign key values and ensure all referenced ${entityPlural} exist.`,
        suggestedTools: [related.search, definition.name].filter((t): t is string => t !== undefined),
      },
    };
  },
  P2000(_entityName, _entityPlural, definition) {
    return {
      success: false,
      error: {
        code: INVALID_INPUT,
        message: `A field value is too long for the column. Check field length limits and retry with shorter values.`,
        suggestedTools: [definition.name],
      },
    };
  },
  P2014(_entityName, entityPlural, definition) {
    const related = resolveRelatedTools(definition);
    return {
      success: false,
      error: {
        code: REFERENCE_ERROR,
        message: `A required relation is missing or violates a constraint. Check that all required related ${entityPlural} exist and are properly linked.`,
        suggestedTools: [related.search, definition.name].filter((t): t is string => t !== undefined),
      },
    };
  },
  P2021() {
    return {
      success: false,
      error: {
        code: DATABASE_ERROR,
        message: `A database table is missing. The schema may need to be migrated. Try again after running migrations.`,
        suggestedTools: ["list_available_tools"],
      },
    };
  },
  P2028(entityName, _entityPlural, definition) {
    const related = resolveRelatedTools(definition);
    return {
      success: false,
      error: {
        code: ConcurrencyConflictError.CODE,
        message: `The '${definition.name}' operation on ${entityName} timed out. Re-fetch the entity and retry with the same idempotency key (do not use a new key).`,
        suggestedTools: [related.get, definition.name].filter((t): t is string => t !== undefined),
      },
    };
  },
  P2024(_entityName, _entityPlural, definition) {
    return {
      success: false,
      error: {
        code: DATABASE_CONNECTION_ERROR,
        message: `The '${definition.name}' operation timed out waiting for a database connection from the pool. The service may be under heavy load. Retry the same request with the same idempotency key (do not use a new key — the first attempt's outcome is unknown).`,
        suggestedTools: [definition.name, "list_available_tools"],
      },
    };
  },
};

const CONNECTION_ERROR_CODES = new Set(["P1000", "P1001", "P1002", "P1003", "P1008", "P1017"]);

function handlePrismaError(prismaCode: string, prismaMeta: { target?: string | string[] } | undefined, entityName: string, entityPlural: string, definition: { name: string; relatedTools?: RelatedTools }): PrismaErrorResult | null {
  if (CONNECTION_ERROR_CODES.has(prismaCode)) {
    return {
      success: false,
      error: {
        code: DATABASE_CONNECTION_ERROR,
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

  const factory = Object.hasOwn(PRISMA_ERROR_HANDLERS, prismaCode)
    ? PRISMA_ERROR_HANDLERS[prismaCode]
    : undefined;
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
      code: INTERNAL_ERROR,
      message: `Unexpected error in '${definition.name}'. Check server logs for details. If this was a write, retry the same request with the same idempotency key (do not use a new key).`,
      suggestedTools: [definition.name, "list_available_tools"],
    },
  };
}

export const errorHandlerMiddleware: ToolMiddleware = async (input, context, definition, next) => {
  try {
    return await next(input, context);
  } catch (error: unknown) {
    try {
      if (isDomainError(error)) {
        return sanitizeAgentFacingResult(handleDomainError(error, definition));
      }

      const { code: prismaCode, meta: prismaMeta } = extractPrismaError(error);

      if (prismaCode) {
        const entityName = definition.entity ?? "entity";
        const entityPlural = pluralize(entityName);
        const result = handlePrismaError(prismaCode, prismaMeta, entityName, entityPlural, definition);
        if (result) return sanitizeAgentFacingResult(result);
      }

      return sanitizeAgentFacingResult(handleGenericError(error, definition, context.tenantId, context.userId));
    } catch (mapperError: unknown) {
      // The error mapper is the LAST line of defence. If it throws (a bug in
      // the mapper, a malformed `meta`, a pathological entity name), the
      // exception must NOT escape `execute()` — the agent would get an
      // unstructured HTTP 500 instead of a structured error. Fall back to the
      // generic handler, which cannot fail on the shape of the input.
      return sanitizeAgentFacingResult(
        handleGenericError(mapperError, definition, context.tenantId, context.userId),
      );
    }
  }
};
