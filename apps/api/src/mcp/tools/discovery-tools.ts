// Discovery MCP Tools — Tools for AI self-service and system introspection.
//
// These tools let AI agents discover what they can do, what entities
// exist, and what valid values are available. This is the "Schema-as-Prompt"
// principle from AGENTIC_AI_DESIGN.md.

import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
} from "@besterp/mcp-tools";
import {
  InvalidTypeValueError,
  sanitizeForLogOutput,
  stripHtmlTags,
  MAX_ENTITY_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
} from "@besterp/shared";

// Mapping from type table names to Prisma model delegate keys and ID fields.
const TYPE_TABLE_MAP = {
  PARTY_TYPE: { delegateKey: "partyType", idField: "partyTypeId" },
  ROLE_TYPE: { delegateKey: "roleType", idField: "roleTypeId" },
  CONTACT_MECHANISM_TYPE: { delegateKey: "contactMechanismType", idField: "contactMechanismTypeId" },
} as const;

type TypeName = keyof typeof TYPE_TABLE_MAP;

/**
 * Minimal interface for a Prisma model delegate with findMany.
 *
 * Intentionally narrow: the dynamic property access on line 96 bypasses
 * Prisma's strict typing because TYPE_TABLE_MAP keys (PARTY_TYPE, ROLE_TYPE,
 * CONTACT_MECHANISM_TYPE) are validated at the Zod schema level but the
 * runtime cast through `prisma as unknown as Record<string, unknown>` is
 * unavoidable for the dynamic lookup. Only `findMany` + the expected shape
 * matters here — the registry's registration-time `.safeParse` guard and
 * the explicit null checks on lines 97–103 catch shape mismatches.
 */
interface PrismaModelDelegate {
  findMany(options: { select: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> }): Promise<Record<string, unknown>[]>;
}

// ─── Tool: list_available_tools ───────────────────────────────────

function createListAvailableTools(registry: ToolRegistry): ToolDefinition {
  return {
    name: "list_available_tools",
    description: `Returns a list of all available MCP tools with descriptions.

Use this to discover what operations you can perform in the ERP system.
Each tool listing includes its risk level and confirmation requirements.`,

    inputSchema: z.strictObject({
      // Trim, and normalize whitespace-only input to no filter — the same
      // convention as optionalFilteredString (round 107): a whitespace-only
      // optional filter means "no filter", never a match-nothing empty string
      // (which would silently return zero tools). Length is capped on the
      // TRIMMED value for consistency with every other MCP string input.
      entity: z.string()
        .optional()
        .transform((s) => {
          if (s === undefined) return undefined;
          const trimmed = s.trim();
          return trimmed.length === 0 ? undefined : trimmed;
        })
        .pipe(z.string().max(MAX_ENTITY_LENGTH).optional())
        .describe("Filter tools by entity (e.g., 'party', 'order')"),
    }),

    riskLevel: "none",
    entity: "tool",
    tags: ["discovery", "meta"],

    handler: async (inputRaw: unknown, _context: ToolContext) => {
      // inputRaw is pre-validated by the registry's Zod schema before the
      // handler runs, so this cast is safe at runtime.
      const input = inputRaw as { entity?: string };
      let tools = registry.getDiscoveryInfo();
      if (input.entity) {
        const filter = input.entity.toLowerCase();
        tools = tools.filter((t) => (t.entity ?? "").toLowerCase() === filter);
      }
      return {
        success: true,
        data: {
          tools,
          totalAvailable: tools.length,
          note: "Use 'get_type_table_values' with a typeName to see valid values for type tables.",
        },
      };
    },
  };
}

// ─── Tool: get_type_table_values ──────────────────────────────────

type TypeTableRow = { id: string | null; name: string | null; description: string | null; aiPromptHint: string | null };

async function queryTypeTable(
  prisma: PrismaClient,
  delegateKey: string,
  idField: string,
): Promise<TypeTableRow[]> {
  // Access Prisma model delegates via dynamic property access. The Zod
  // inputSchema on the tool already restricts typeName to known values
  // (compile-time safety). This runtime check is a belt-and-braces guard
  // against schema drift — if TYPE_TABLE_MAP references a model that no
  // longer exists in the Prisma client, we fail fast with a clear message.
  const raw = (prisma as unknown as Record<string, unknown>)[delegateKey];
  if (!raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).findMany !== "function") {
    throw new InvalidTypeValueError(
      `Prisma delegate '${delegateKey}' not found. Ensure the model exists in the schema.`,
      { context: { field: "delegateKey", received: delegateKey } }
    );
  }
  const delegate = raw as unknown as PrismaModelDelegate;
  // Intentionally uses the admin PrismaClient (bypasses RLS) because type
  // tables (PARTY_TYPE, ROLE_TYPE, etc.) are global reference data, not
  // tenant-scoped. All tenants share the same vocabulary.
  //
  // Deterministic ordering: without an ORDER BY, Postgres returns the rows in
  // unspecified (typically heap/insertion) order, so the same tool call could
  // present the vocabulary in a different order per call — surprising for an
  // agent-facing "valid values" reference surface and producing non-identical
  // snapshots in the durable audit row. `name` is @unique (never null), so
  // ascending name order is total and stable.
  const rows = await delegate.findMany({
    select: { [idField]: true, name: true, description: true, aiPromptHint: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: typeof r[idField] === "string" ? r[idField] : null,
    name: typeof r.name === "string" ? r.name : null,
    description: typeof r.description === "string" ? r.description : null,
    aiPromptHint: typeof r.aiPromptHint === "string" ? r.aiPromptHint : null,
  }));
}

function createGetTypeTableValues(prisma: PrismaClient): ToolDefinition {
  return {
    name: "get_type_table_values",
    description: `Get valid values for a type table.

Use this before creating entities to know valid types, roles, and classifications.
Type tables are the ERP's vocabulary — they define what classifications are available.`,

    inputSchema: z.strictObject({
      typeName: z.enum(["PARTY_TYPE", "ROLE_TYPE", "CONTACT_MECHANISM_TYPE"])
        .describe("The type table to query"),
    }),

    riskLevel: "none",
    entity: "type_table",
    tags: ["discovery", "type-table"],

    handler: async (inputRaw: unknown, _context: ToolContext) => {
      // inputRaw is pre-validated by the registry's Zod schema before the
      // handler runs, so this cast is safe at runtime.
      const input = inputRaw as { typeName: TypeName };
      const config = TYPE_TABLE_MAP[input.typeName];
      const values = await queryTypeTable(prisma, config.delegateKey, config.idField);

      // Run description and aiPromptHint through stripHtmlTags +
      // sanitizeForLogOutput as defense-in-depth. These fields are admin-
      // authored global reference data (not user input), but they flow to
      // the AI agent via the tool result and are persisted to the cross-
      // tenant durable audit sink — the same surfaces that scrub every
      // other string leaf. A corrupt or attacker-influenced value in the
      // type table would otherwise reach the agent and the audit row
      // verbatim, inconsistent with the sanitization applied everywhere
      // else (round-124 review). stripHtmlTags first so any HTML
      // injection is stripped; sanitizeForLogOutput second so URLs,
      // paths, and secret-shaped tokens are collapsed/redacted.
      const sanitizedValues = values.map((v) => ({
        ...v,
        description: v.description !== null ? sanitizeForLogOutput(stripHtmlTags(v.description)) : null,
        aiPromptHint: v.aiPromptHint !== null ? sanitizeForLogOutput(stripHtmlTags(v.aiPromptHint)) : null,
      }));

      return {
        success: true,
        data: { typeName: input.typeName, values: sanitizedValues, totalAvailable: sanitizedValues.length },
      };
    },
  };
}

// ─── Tool: describe_entity ────────────────────────────────────────

function createDescribeEntity(prisma: PrismaClient): ToolDefinition {
  return {
    name: "describe_entity",
    description: `Describe an entity in the ERP system.

Use this to understand the structure and purpose of an entity before creating or querying it.
Returns the entity's description, AI prompt hint, and key fields.`,

    inputSchema: z.strictObject({
      entityName: z.string()
        .transform((s) => s.trim().toLowerCase())
        .pipe(z.string().min(1).max(64))
        .describe("The entity name to describe (e.g., 'party', 'person', 'role_type')"),
    }),

    riskLevel: "none",
    entity: "entity_descriptor",
    tags: ["discovery", "schema"],

    handler: async (inputRaw: unknown, _context: ToolContext) => {
      const input = inputRaw as { entityName: string };
      // Access via dynamic property — the entity_descriptor model is global
      // reference data (not tenant-scoped), so admin client bypasses RLS.
      const raw = (prisma as unknown as Record<string, unknown>)["entityDescriptor"];
      if (!raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).findFirst !== "function") {
        return {
          success: false,
          error: {
            code: "ENTITY_NOT_FOUND",
            message: `Entity descriptor table not available.`,
            suggestedTools: ["list_available_tools"],
          },
        };
      }
      const delegate = raw as { findFirst: (opts: { where: { entityName: string } }) => Promise<Record<string, unknown> | null> };
      const row = await delegate.findFirst({ where: { entityName: input.entityName } });

      if (!row) {
        return {
          success: false,
          error: {
            code: "ENTITY_NOT_FOUND",
            message: `No descriptor found for entity '${input.entityName}'. Use 'list_available_tools' to see available entities, or 'get_type_table_values' for classification vocabularies.`,
            suggestedTools: ["list_available_tools"],
          },
        };
      }

      const description = typeof row.description === "string"
        ? sanitizeForLogOutput(stripHtmlTags(row.description))
        : null;
      const aiPromptHint = typeof row.aiPromptHint === "string"
        ? sanitizeForLogOutput(stripHtmlTags(row.aiPromptHint))
        : null;
      const keyFields = row.keyFields != null && typeof row.keyFields === "object"
        ? row.keyFields
        : null;

      return {
        success: true,
        data: {
          entityName: input.entityName,
          description,
          aiPromptHint,
          keyFields,
        },
      };
    },
  };
}

// ─── Tool: get_valid_transitions ──────────────────────────────────

/**
 * Valid status transitions per entity.
 *
 * Each entry maps a from-status → set of allowed to-status values.
 * Admin-curated reference data — not tenant-scoped. New entities added in
 * future phases must register their transitions here so agents know the
 * allowed state-machine edges before attempting a transition.
 */
const STATUS_TRANSITIONS: Record<string, Record<string, string[]>> = {
  party: {
    active: ["inactive", "suspended"],
    inactive: ["active", "suspended"],
    suspended: ["active", "inactive"],
  },
  order: {
    draft: ["pending", "cancelled"],
    pending: ["confirmed", "cancelled"],
    confirmed: ["in_progress", "cancelled"],
    in_progress: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  },
  invoice: {
    draft: ["pending"],
    pending: ["partially_paid", "overdue", "cancelled"],
    partially_paid: ["paid", "overdue", "cancelled"],
    paid: [],
    overdue: ["paid", "cancelled"],
    cancelled: [],
  },
};

function createGetValidTransitions(): ToolDefinition {
  return {
    name: "get_valid_transitions",
    description: `Get valid status transitions for an entity.

Use this before transitioning an entity's status to know which moves are allowed.
Returns a map of current status → allowed next statuses.

Example: get_valid_transitions({ entity: "party" }) returns { active: ["inactive", "suspended"], ... }`,

    inputSchema: z.strictObject({
      entity: z.string()
        .transform((s) => s.trim().toLowerCase())
        .pipe(z.string().min(1).max(64))
        .describe("The entity name (e.g., 'party', 'order', 'invoice')"),
    }),

    riskLevel: "none",
    entity: "status_transition",
    tags: ["discovery", "status"],

    handler: async (inputRaw: unknown, _context: ToolContext) => {
      const input = inputRaw as { entity: string };
      const transitions = STATUS_TRANSITIONS[input.entity];

      if (transitions === undefined) {
        // Enumerate all registered entities so the agent knows what's available.
        const registered = Object.keys(STATUS_TRANSITIONS).join(", ");
        return {
          success: false,
          error: {
            code: "ENTITY_NOT_FOUND",
            message: `No status transitions registered for entity '${input.entity}'. Available entities: ${registered}.`,
            suggestedTools: ["describe_entity", "list_available_tools"],
          },
        };
      }

      return {
        success: true,
        data: {
          entity: input.entity,
          transitions,
        },
      };
    },
  };
}

// ─── Tool: search_across_entities ─────────────────────────────────

function createSearchAcrossEntities(): ToolDefinition {
  return {
    name: "search_across_entities",
    description: `Universal search across all entity types in the ERP system.

Use this when you don't know which specific entity type to query. Search by
name with optional entity type filtering. Returns paginated results with a
count of total matches per entity type.

Example: search_across_entities({ query: "Acme" })
Example: search_across_entities({ query: "Widget", entity: "product" })`,

    inputSchema: z.strictObject({
      query: z.string()
        .transform((s) => s.trim())
        .pipe(z.string().min(1).max(200))
        .describe("Search term (partial match, case-insensitive)"),
      entity: z.enum(["party", "product"]).optional()
        .describe("Restrict search to a specific entity type. Omit to search all."),
      limit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT),
      offset: z.number().int().min(MIN_SEARCH_OFFSET).max(MAX_SEARCH_OFFSET).optional().default(0),
    }),

    riskLevel: "none",
    entity: "universal_search",
    tags: ["discovery", "search"],

    handler: async (inputRaw: unknown, context: ToolContext) => {
      const input = inputRaw as { query: string; entity?: string; limit: number; offset: number };

      // search_across_entities is a read-only discovery tool that delegates to
      // the appropriate service. Party search is handled by partyService;
      // product search is handled by productService. Both are available via
      // ToolContext.services.
      if (input.entity) {
        if (input.entity === "party") {
          const svc = context.services.partyService;
          if (!svc || typeof svc !== "object" || typeof (svc as Record<string, unknown>).searchParties !== "function") {
            return {
              success: false,
              error: {
                code: "ENTITY_NOT_FOUND",
                message: "Party search service is not available.",
                suggestedTools: ["list_available_tools"],
              },
            };
          }
          const result = await (svc as { searchParties: (input: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown> }).searchParties({
            tenantId: context.tenantId,
            name: input.query,
            limit: input.limit,
            offset: input.offset,
          });
          return { success: true, data: { entity: "party", query: input.query, ...(result as Record<string, unknown>) } };
        }

        if (input.entity === "product") {
          const svc = context.services.productService;
          if (!svc || typeof svc !== "object" || typeof (svc as Record<string, unknown>).searchProducts !== "function") {
            return {
              success: false,
              error: {
                code: "ENTITY_NOT_FOUND",
                message: "Product search service is not available.",
                suggestedTools: ["list_available_tools"],
              },
            };
          }
          const result = await (svc as { searchProducts: (input: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown> }).searchProducts({
            tenantId: context.tenantId,
            name: input.query,
            limit: input.limit,
            offset: input.offset,
          });
          return { success: true, data: { entity: "product", query: input.query, ...(result as Record<string, unknown>) } };
        }

        return {
          success: false,
          error: {
            code: "ENTITY_NOT_FOUND",
            message: `Entity type '${input.entity}' is not searchable. Available: party, product.`,
            suggestedTools: ["list_available_tools", "describe_entity"],
          },
        };
      }

      // No entity specified — search parties and products in parallel
      const [partyResult, productResult] = await Promise.allSettled([
        (async () => {
          const svc = context.services.partyService;
          if (!svc || typeof svc !== "object" || typeof (svc as Record<string, unknown>).searchParties !== "function") return null;
          return (svc as { searchParties: (input: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown> }).searchParties({
            tenantId: context.tenantId,
            name: input.query,
            limit: input.limit,
            offset: input.offset,
          });
        })(),
        (async () => {
          const svc = context.services.productService;
          if (!svc || typeof svc !== "object" || typeof (svc as Record<string, unknown>).searchProducts !== "function") return null;
          return (svc as { searchProducts: (input: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown> }).searchProducts({
            tenantId: context.tenantId,
            name: input.query,
            limit: input.limit,
            offset: input.offset,
          });
        })(),
      ]);

      return {
        success: true,
        data: {
          query: input.query,
          results: {
            party: partyResult.status === "fulfilled" && partyResult.value ? partyResult.value : null,
            product: productResult.status === "fulfilled" && productResult.value ? productResult.value : null,
          },
        },
      };
    },
  };
}

// ─── Tool: explain_error ──────────────────────────────────────────

/**
 * Error code explanations for AI agents. Maps domain error codes and common
 * Prisma codes to human-readable messages with actionable guidance.
 *
 * This is the "Layer 4" hallucination guard from AGENTIC_AI_DESIGN.md — when
 * an agent encounters an unfamiliar error code, it can call this tool to get
 * a plain-English explanation and suggested next steps instead of guessing.
 */
const ERROR_EXPLANATIONS: Record<string, { message: string; suggestedTools: string[]; context?: Record<string, string> }> = {
  INVALID_TYPE_VALUE: {
    message: "The value you provided does not match any valid option in the system. Type tables (PARTY_TYPE, ROLE_TYPE, etc.) define the allowed values.",
    suggestedTools: ["get_type_table_values", "list_available_tools", "describe_entity"],
    context: { tip: "Run get_type_table_values with the relevant typeName to see all valid options." },
  },
  ENTITY_NOT_FOUND: {
    message: "The entity you referenced does not exist in this tenant. It may have been deleted, or the ID may be incorrect.",
    suggestedTools: ["search_parties", "search_across_entities", "describe_entity"],
    context: { tip: "Use search_across_entities to find the correct entity ID." },
  },
  DUPLICATE_ENTITY: {
    message: "An entity with the same unique constraint already exists. The system prevents duplicate records for data integrity.",
    suggestedTools: ["search_parties", "get_party"],
    context: { tip: "Search for the existing entity and use its ID instead of creating a new one." },
  },
  MISSING_SUBTYPE_DATA: {
    message: "Required subtype data is missing. When creating a PARTY, you must provide the correct subtype fields (person or organization).",
    suggestedTools: ["create_party", "describe_entity"],
    context: { tip: "Use describe_entity with entity='party' to see required subtype fields." },
  },
  CONCURRENCY_CONFLICT: {
    message: "A concurrent modification was detected. Another operation modified the same record between your read and write.",
    suggestedTools: [],
    context: { tip: "Re-query the entity and retry the operation with a new idempotency key." },
  },
  P2002: {
    message: "Database unique constraint violation — a record with the same unique field(s) already exists.",
    suggestedTools: ["search_parties", "get_party"],
    context: { tip: "Search for the existing record and reuse its ID, or modify the conflicting field." },
  },
  P2025: {
    message: "Attempted to update or delete a record that does not exist.",
    suggestedTools: ["get_party", "search_parties"],
    context: { tip: "Verify the entity ID exists before attempting the operation." },
  },
  P2003: {
    message: "Foreign key constraint violation — a referenced record does not exist.",
    suggestedTools: ["get_type_table_values", "search_parties"],
    context: { tip: "Ensure the referenced entity (e.g., party, role type) exists before creating the dependent record." },
  },
  P2034: {
    message: "Transaction conflict or timeout — the database could not complete the operation due to concurrent access.",
    suggestedTools: [],
    context: { tip: "Retry the operation with the same idempotency key after a short delay." },
  },
  P1000: {
    message: "Authentication failed — the database connection credentials are invalid.",
    suggestedTools: [],
    context: { tip: "Check DATABASE_URL and DATABASE_ADMIN_URL environment variables. This is a server configuration issue." },
  },
  P1001: {
    message: "Cannot reach the database — the database server is not available.",
    suggestedTools: [],
    context: { tip: "Check that PostgreSQL is running and the connection string is correct. This is a server infrastructure issue." },
  },
  P1008: {
    message: "Operation timed out — the database query took too long to complete.",
    suggestedTools: [],
    context: { tip: "This is likely a transient issue. Retry the operation." },
  },
};

function createExplainError(_prisma: PrismaClient): ToolDefinition {
  return {
    name: "explain_error",
    description: `Explain an error code and suggest how to recover.

Use this when you encounter an error you don't understand. Returns a plain-
English explanation and a list of tools that can help you fix the issue.

Example: explain_error({ errorCode: "INVALID_TYPE_VALUE" })`,

    inputSchema: z.strictObject({
      errorCode: z.string()
        .transform((s) => s.trim().toUpperCase())
        .pipe(z.string().min(1).max(50))
        .describe("The error code to explain (e.g., 'INVALID_TYPE_VALUE', 'P2002')"),
    }),

    riskLevel: "none",
    entity: "error_explanation",
    tags: ["discovery", "error"],

    handler: async (inputRaw: unknown, _context: ToolContext) => {
      const input = inputRaw as { errorCode: string };
      const explanation = ERROR_EXPLANATIONS[input.errorCode];

      if (!explanation) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_ERROR_CODE",
            message: `No explanation found for error code '${input.errorCode}'. Check the tool output for the exact error code, or contact support.`,
            suggestedTools: ["list_available_tools"],
          },
        };
      }

      return {
        success: true,
        data: {
          errorCode: input.errorCode,
          message: explanation.message,
          suggestedTools: explanation.suggestedTools,
          context: explanation.context,
        },
      };
    },
  };
}

// ─── Registration ─────────────────────────────────────────────────

export function registerDiscoveryTools(registry: ToolRegistry, prisma: PrismaClient): void {
  registry.register(createListAvailableTools(registry));
  registry.register(createGetTypeTableValues(prisma));
  registry.register(createDescribeEntity(prisma));
  registry.register(createGetValidTransitions());
  registry.register(createSearchAcrossEntities());
  registry.register(createExplainError(prisma));
}
