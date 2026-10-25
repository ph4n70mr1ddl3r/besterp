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
  type ToolResult,
  SERVICE_UNAVAILABLE,
} from "@besterp/mcp-tools";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  redactSensitiveFieldValues,
  sanitizeForLogOutput,
  stripHtmlTags,
  MAX_ENTITY_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_ERROR_CODE_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
} from "@besterp/shared";

// The code `explain_error` itself emits when a requested code has no entry in
// the explanation table. Defined here (not in either published inventory)
// because it is a self-referential, app-local code — but it MUST stay in the
// `ERROR_EXPLANATIONS` table, which it does, so an agent that hits it gets
// guidance instead of looping on a code with none.
const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR_CODE";

// Mapping from type table names to Prisma model delegate keys and ID fields.
const TYPE_TABLE_MAP = {
  PARTY_TYPE: { delegateKey: "partyType", idField: "partyTypeId" },
  ROLE_TYPE: { delegateKey: "roleType", idField: "roleTypeId" },
  CONTACT_MECHANISM_TYPE: { delegateKey: "contactMechanismType", idField: "contactMechanismTypeId" },
  PRODUCT_TYPE: { delegateKey: "productType", idField: "productTypeId" },
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

/**
 * Collect the names of the tools whose confirmation gate is enabled.
 *
 * The gate configuration lives in the `confirmation_gate` table, so the
 * discovery surface reads it from the database instead of hardcoding a risk
 * level heuristic — the gate can be enabled or disabled per tool at
 * runtime.
 *
 * Returns `null` when the lookup FAILED. The caller must then treat every
 * high/critical-risk tool as gated, because that is what the enforcement
 * path does: the confirmation gate fails CLOSED, so an unverifiable gate
 * blocks the call. Reporting "no tool is gated" while the gate actually
 * blocks every high-risk write would be the same class of drift the
 * discovery surface was rebuilt to eliminate — and it would tell an agent
 * to skip the confirmation the server is about to demand.
 */
async function listGatedToolNames(prisma: PrismaClient): Promise<Set<string> | null> {
  try {
    const gates = await prisma.confirmationGate.findMany({
      where: { enabled: true },
      select: { toolName: true },
    });
    return new Set(gates.map((g) => g.toolName));
  } catch {
    return null;
  }
}

/**
 * The discovery payload: every registered tool plus whether it requires an
 * agent confirmation.
 *
 * This is the SINGLE implementation of the discovery surface, shared by the
 * `list_available_tools` MCP tool and the `GET /api/mcp/tools` HTTP
 * endpoint. The HTTP endpoint used to return the bare
 * `registry.getDiscoveryInfo()` — no `confirmationRequired` flag — while its
 * own doc comment claimed it was "the same discovery payload the
 * `list_available_tools` MCP tool returns". An HTTP client therefore could
 * not learn that a write tool needs a `confirmation` until it got a
 * `CONFIRMATION_REQUIRED` rejection on its first write.
 */
export interface ToolDiscoveryEntry extends Record<string, unknown> {
  name: string;
  riskLevel: string;
  confirmationRequired: boolean;
}

export interface ToolDiscoveryPayload {
  tools: ToolDiscoveryEntry[];
  totalAvailable: number;
  note: string;
}

/**
 * Build the discovery payload for the given registry.
 *
 * The gate configuration lives in the `confirmation_gate` table, so the
 * discovery surface reads it from the database instead of hardcoding a risk
 * level heuristic — the gate can be enabled or disabled per tool at
 * runtime. A database failure is reported conservatively: every high/critical
 * tool is marked as requiring a confirmation, which is exactly what the
 * enforcement path does when the gate cannot be verified (it fails closed).
 */
export async function buildToolDiscoveryPayload(
  registry: ToolRegistry,
  prisma: PrismaClient,
  entityFilter?: string,
): Promise<ToolDiscoveryPayload> {
  let tools = registry.getDiscoveryInfo();
  if (entityFilter) {
    const filter = entityFilter.toLowerCase();
    tools = tools.filter((t) => (t.entity ?? "").toLowerCase() === filter);
  }
  const gatedTools = await listGatedToolNames(prisma);
  const withConfirmation = tools.map((t) => {
    // The gate middleware only enforces tools whose risk level is "high" or
    // "critical" (see confirmation-gate.ts), so a gate row for a
    // medium/low-risk tool is NOT enforced. Reporting it as
    // `confirmationRequired` would advertise a requirement the pipeline
    // does not apply — the same class of drift as a stale type table.
    const enforced = t.riskLevel === "high" || t.riskLevel === "critical";
    return {
      ...t,
      confirmationRequired: enforced && (gatedTools === null || gatedTools.has(t.name)),
    };
  });
  return {
    tools: withConfirmation as ToolDiscoveryEntry[],
    totalAvailable: withConfirmation.length,
    note: "Use 'get_type_table_values' with a typeName to see valid values for type tables.",
  };
}

function createListAvailableTools(registry: ToolRegistry, prisma: PrismaClient): ToolDefinition {
  return {
    name: "list_available_tools",
    description: `Returns a list of all available MCP tools with descriptions.

Use this to discover what operations you can perform in the ERP system.
Each tool listing includes its risk level and whether it requires an agent
confirmation.`,

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
          const trimmed = stripHtmlTags(s.trim());
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
      // Report which tools require an agent confirmation. The gate is
      // database-backed (`confirmation_gate`), so this reflects the deployed
      // configuration rather than a hardcoded guess — the agent can then
      // supply the `confirmation` field up front instead of discovering the
      // requirement through a CONFIRMATION_REQUIRED rejection.
      //
      // The payload is built by the shared `buildToolDiscoveryPayload`, which
      // the `GET /api/mcp/tools` HTTP endpoint uses too, so the two
      // discovery surfaces cannot drift apart.
      const payload = await buildToolDiscoveryPayload(registry, prisma, input.entity);
      return {
        success: true,
        data: payload,
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
      { suggestedTools: ["list_available_tools"], context: { field: "delegateKey", received: delegateKey } }
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
      typeName: z.enum(["PARTY_TYPE", "ROLE_TYPE", "CONTACT_MECHANISM_TYPE", "PRODUCT_TYPE"])
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
        .transform((s) => stripHtmlTags(s.trim()).toLowerCase())
        .pipe(z.string().min(1).max(MAX_ENTITY_LENGTH))
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
          code: SERVICE_UNAVAILABLE,
          message: "Entity descriptor table not available.",
            suggestedTools: ["list_available_tools"],
            context: { reason: "entityDescriptor delegate missing or malformed" },
          },
        };
      }
      const delegate = raw as { findFirst: (opts: { where: { entityName: string } }) => Promise<Record<string, unknown> | null> };
      const row = await delegate.findFirst({ where: { entityName: input.entityName } });

      if (!row) {
        return {
          success: false,
          error: {
            code: EntityNotFoundError.CODE,
            message: `No descriptor found for entity '${stripHtmlTags(sanitizeForLogOutput(input.entityName))}'. Use 'list_available_tools' to see available entities, or 'get_type_table_values' for classification vocabularies.`,
            suggestedTools: ["list_available_tools"],
            context: { entityName: stripHtmlTags(sanitizeForLogOutput(input.entityName)) },
          },
        };
      }

      const description = typeof row.description === "string"
        ? sanitizeForLogOutput(stripHtmlTags(row.description))
        : null;
      const aiPromptHint = typeof row.aiPromptHint === "string"
        ? sanitizeForLogOutput(stripHtmlTags(row.aiPromptHint))
        : null;
      // `keyFields` is a JSON blob straight from the entity_descriptor table.
      // The two string fields above are stripped/sanitized; this one was
      // returned raw — the same asymmetric-sanitization class the rest of
      // this file avoids. Redact it through the canonical shared redactor so
      // sensitive-named keys and URL/secret-shaped values are scrubbed before
      // the blob reaches the agent (and the durable audit sink).
      const keyFields = row.keyFields != null && typeof row.keyFields === "object"
        ? redactSensitiveFieldValues(row.keyFields)
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
 *
 * ONLY entities that BOTH expose a status field in the Prisma schema AND
 * have a transition tool may appear here. The previous map listed `party`
 * (whose model has NO status column), `order` and `invoice` (tables that do
 * not exist in this schema at all) — a hallucination-guarding tool that
 * itself injected a hallucination: an agent was told a status-transition
 * API existed for entities that have no status field and no transition tool.
 *
 * An entity is added here in the same phase that introduces its status
 * column and its transition tool.
 */
const STATUS_TRANSITIONS: Record<string, Record<string, string[]>> = {};

function createGetValidTransitions(): ToolDefinition {
  return {
    name: "get_valid_transitions",
    description: `Get valid status transitions for an entity.

Use this before transitioning an entity's status to know which moves are allowed.
Returns a map of current status → allowed next statuses.

Only entities that expose a status field AND have a status-transition tool are
listed. If the registry is empty, this deployment has no such entity yet and
no status transition can be performed.`,

    inputSchema: z.strictObject({
      entity: z.string()
        .transform((s) => stripHtmlTags(s.trim()).toLowerCase())
        .pipe(z.string().min(1).max(MAX_ENTITY_LENGTH))
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
        const registeredEntities = Object.keys(STATUS_TRANSITIONS);
        const registered = registeredEntities.length > 0 ? registeredEntities.join(", ") : "(none)";
        return {
          success: false,
          error: {
            code: EntityNotFoundError.CODE,
            message: registeredEntities.length > 0
              ? `No status transitions registered for entity '${stripHtmlTags(sanitizeForLogOutput(input.entity))}'. Available entities: ${registered}.`
              : `No status transitions are registered for entity '${stripHtmlTags(sanitizeForLogOutput(input.entity))}'. ` +
                "This deployment has no entity that exposes a status field with a transition tool, so no status transition can be performed.",
            suggestedTools: ["describe_entity", "list_available_tools"],
            context: { entity: stripHtmlTags(sanitizeForLogOutput(input.entity)) },
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

The response shape is ALWAYS the same: { query, results: { party, product } },
where each entry holds that entity's paginated result (or null when the
search was narrowed to the other entity, or when that entity's search
failed). When 'entity' narrows the search, the 'entity' field names it.

Example: search_across_entities({ query: "Acme" })
Example: search_across_entities({ query: "Widget", entity: "product" })`,

    inputSchema: z.strictObject({
      query: z.string()
        .transform((s) => stripHtmlTags(s.trim()))
        .pipe(z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH))
        .describe("Search term (partial match, case-insensitive)"),
      entity: z.enum(["party", "product"]).optional()
        .describe("Restrict search to a specific entity type. Omit to search all."),
      limit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT).describe(`Maximum results to return (max ${MAX_SEARCH_LIMIT})`),
      offset: z.number().int().min(MIN_SEARCH_OFFSET).max(MAX_SEARCH_OFFSET).optional().default(0).describe(`Number of results to skip (min ${MIN_SEARCH_OFFSET})`),
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
        const narrowed = await searchSingleEntity(context, input.entity, input.query, input.limit, input.offset);
        if (narrowed) return narrowed;
        return {
          success: false,
          error: {
            code: EntityNotFoundError.CODE,
            message: `Entity type '${stripHtmlTags(sanitizeForLogOutput(input.entity))}' is not searchable. Available: party, product.`,
            suggestedTools: ["list_available_tools", "describe_entity"],
            context: { entity: stripHtmlTags(sanitizeForLogOutput(input.entity)) },
          },
        };
      }

      // No entity specified — search parties and products in parallel.
      const [partyResult, productResult] = await Promise.allSettled([
        searchOneEntity(context, "partyService", "searchParties", input),
        searchOneEntity(context, "productService", "searchProducts", input),
      ]);

      // A rejected branch must NOT be reported as "no results" — a database
      // outage, an RLS failure, or a DomainError from the service is
      // indistinguishable from a genuine empty result when both surface as
      // `null`, which hides real incidents from the agent AND from operators.
      // Surface the failure explicitly: a partial success reports the branch
      // that worked alongside the error for the one that did not; a total
      // failure returns a structured error.
      const failures: Array<{ entity: string; reason: string }> = [];
      if (partyResult.status === "rejected") {
        failures.push({ entity: "party", reason: describeSearchFailure(partyResult.reason) });
      }
      if (productResult.status === "rejected") {
        failures.push({ entity: "product", reason: describeSearchFailure(productResult.reason) });
      }
      if (failures.length === 2) {
        return {
          success: false,
          error: {
            code: SERVICE_UNAVAILABLE,
            message: `Universal search failed for every entity type (${failures.map((f) => f.entity).join(", ")}). The operation did not complete — retry the same request later.`,
            suggestedTools: ["list_available_tools"],
            context: { failures },
          },
        };
      }

      return {
        success: true,
        data: {
          query: input.query,
          // The same three keys in every case: `entity` names the narrowed
          // entity type, or is null for the universal search.
          entity: null,
          results: {
            party: partyResult.status === "fulfilled" && partyResult.value ? partyResult.value : null,
            product: productResult.status === "fulfilled" && productResult.value ? productResult.value : null,
          },
          ...(failures.length > 0
            ? {
              partialFailure: true,
              failures,
              note: "One entity type could not be searched; the results above cover the rest.",
            }
            : {}),
        },
      };
    },
  };
}

/**
 * Search a SINGLE entity type.
 *
 * Returns `null` when the entity type is not searchable (the caller then
 * answers with the ENTITY_NOT_FOUND error).
 *
 * The response shape is the SAME whether or not `entity` narrows the search:
 * `{ query, results: { party, product } }`. The tool used to return a FLAT
 * object (`{ entity, query, items, total, … }`) for the narrowed case and a
 * NESTED one for the universal case, so an agent that called the tool twice —
 * once narrowed, once not — got structurally different payloads for the same
 * underlying search, and any client-side extractor written against one shape
 * broke on the other.
 */
async function searchSingleEntity(
  context: ToolContext,
  entity: string,
  query: string,
  limit: number,
  offset: number,
): Promise<ToolResult | null> {
  if (entity === "party") {
    const unavailable = unavailableServiceError(context, "partyService", "searchParties");
    if (unavailable) return unavailable;
    const result = await (context.services.partyService as { searchParties: (i: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown> }).searchParties({
      tenantId: context.tenantId,
      name: query,
      limit,
      offset,
    });
    return {
      success: true,
      data: {
        query,
        entity: "party",
        results: { party: result ?? null, product: null },
      },
    };
  }
  if (entity === "product") {
    const unavailable = unavailableServiceError(context, "productService", "searchProducts");
    if (unavailable) return unavailable;
    const result = await (context.services.productService as { searchProducts: (i: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown> }).searchProducts({
      tenantId: context.tenantId,
      name: query,
      limit,
      offset,
    });
    return {
      success: true,
      data: {
        query,
        entity: "product",
        results: { party: null, product: result ?? null },
      },
    };
  }
  return null;
}

/**
 * Run one entity search through the service exposed on the tool context.
 *
 * A missing/unavailable service REJECTS (rather than resolving to `null`).
 * Resolving to `null` made an absent service indistinguishable from a
 * genuine empty result: the settled-result inspection the caller performs
 * only sees REJECTED branches, so the failure was silently reported as
 * "no matches" with `success: true` — a service outage looked exactly like
 * an empty tenant.
 */
async function searchOneEntity(
  context: ToolContext,
  serviceKey: "partyService" | "productService",
  method: "searchParties" | "searchProducts",
  input: { query: string; limit: number; offset: number },
): Promise<unknown> {
  const svc = context.services[serviceKey];
  const search = svc && typeof svc === "object"
    ? (svc as unknown as Record<string, ((i: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown>) | undefined>)[method]
    : undefined;
  if (typeof search !== "function") {
    throw new Error(`${serviceKey === "partyService" ? "Party" : "Product"} search service is not available.`);
  }
  // Invoke the method ON THE SERVICE so `this` stays bound. `PartyService
  // .searchParties` and `ProductService.searchProducts` are class methods
  // that use `this.prisma`; calling the extracted reference as a bare
  // function made `this` undefined, so EVERY universal search (the path
  // that does NOT name an entity) failed with
  // "Cannot read properties of undefined (reading 'prisma')" and reported
  // SERVICE_UNAVAILABLE — telling the agent to retry a request that could
  // never succeed. The sibling branch that names an entity calls the
  // service as a member expression, which is why only the universal path
  // was broken.
  return (search as (i: { tenantId: string; name?: string; limit?: number; offset?: number }) => Promise<unknown>).call(
    svc,
    {
      tenantId: context.tenantId,
      name: input.query,
      limit: input.limit,
      offset: input.offset,
    },
  );
}

/**
 * Build the SERVICE_UNAVAILABLE result when the requested entity's search
 * service is not wired into the tool context. Returns null when the service
 * IS available, so the caller can proceed with the search.
 */
function unavailableServiceError(
  context: ToolContext,
  serviceKey: "partyService" | "productService",
  method: "searchParties" | "searchProducts",
): {
  success: false;
  error: { code: string; message: string; suggestedTools: string[]; context: Record<string, string> };
} | null {
  const svc = context.services[serviceKey];
  if (svc && typeof svc === "object" && typeof (svc as Record<string, unknown>)[method] === "function") return null;
  return {
    success: false,
    error: {
      code: SERVICE_UNAVAILABLE,
      message: `${serviceKey === "partyService" ? "Party" : "Product"} search service is not available.`,
      suggestedTools: ["list_available_tools"],
      context: { service: serviceKey },
    },
  };
}

/**
 * Summarise a rejected search branch for the agent-facing payload.
 *
 * The underlying error is sanitized (a Prisma/driver message can embed a
 * connection string or hostname) and capped so the payload stays bounded.
 */
function describeSearchFailure(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return sanitizeForLogOutput(message).slice(0, 200);
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
  // Self-referential entry: when `explain_error` answers that the requested
  // code has no explanation, the `UNKNOWN_ERROR_CODE` it emits is itself
  // explainable — an agent that hits it knows to check the exact code it saw
  // (or to contact support) instead of looping on a code with no guidance.
  [UNKNOWN_ERROR_CODE]: {
    message: "The requested error code has no entry in this server's explanation table — it was not recognised by the `explain_error` tool.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Check the exact error code returned by the failing tool (case-sensitive), or contact support with the code." },
  },
  INVALID_INPUT: {
    message: "The tool arguments failed schema validation. A required field is missing, has the wrong type, or exceeds its length limit.",
    suggestedTools: ["list_available_tools", "describe_entity"],
    context: { tip: "Re-read the tool description and check the 'context.issues' array of the error for the exact offending fields." },
  },
  CONFIRMATION_REQUIRED: {
    message: "This tool requires an explicit confirmation before it runs. High-risk operations must be justified by the agent.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Call the tool again with a 'confirmation' string (at least 10 characters) explaining why the operation should proceed." },
  },
  INVALID_CONFIRMATION: {
    message: "The confirmation you supplied was rejected — it was missing, too short, too long, or contained no visible text after sanitization.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Supply a plain-text justification of at least 10 visible characters." },
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    message: "The idempotency key was already used for a different operation, or two different keys were supplied for the same call.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Use a fresh idempotency key for every distinct operation." },
  },
  REQUEST_IN_PROGRESS: {
    message: "A concurrent request already holds this idempotency key. The operation is running or was rejected by a duplicate check.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Wait briefly and retry the SAME request with the SAME idempotency key." },
  },
  IDEMPOTENCY_CONTENTION: {
    message: "The idempotency record could not be acquired because of concurrent contention.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Wait briefly and retry the same request with the same idempotency key (do not use a new key)." },
  },
  [SERVICE_UNAVAILABLE]: {
    message: "A dependency required for this operation is unavailable. The operation did not complete.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Retry the same request later with the same idempotency key." },
  },
  REFERENCE_ERROR: {
    message: "A referenced record does not exist or does not belong to this tenant.",
    suggestedTools: ["search_across_entities", "get_party"],
    context: { tip: "Look up the referenced record in this tenant before referencing it." },
  },
  DATABASE_ERROR: {
    message: "The database rejected the operation. This is usually a server-side constraint or availability problem.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Retry shortly. If it persists, contact support with the error code." },
  },
  DATABASE_CONNECTION_ERROR: {
    message: "The database could not be reached. The operation did not complete.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Retry later — this is a transient infrastructure issue, not a problem with your input." },
  },
  INTERNAL_ERROR: {
    message: "An unexpected server-side error occurred. The operation did not complete.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Retry once; if it persists, contact support with the request ID." },
  },
  UNKNOWN_TOOL: {
    message: "The requested tool is not registered.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Call list_available_tools to see the exact tool names." },
  },
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
    context: { tip: "Re-query the entity and retry with the SAME idempotency key (do not use a new key) — the durable idempotency record already holds the outcome." },
  },
  // ── Agent registry ────────────────────────────────────────────
  AGENT_NOT_REGISTERED: {
    message: "The agent identity on this request is not registered in this tenant, so no agent permissions could be applied.",
    suggestedTools: ["list_available_tools", "describe_agent"],
    context: { tip: "Register the agent with register_agent, or call the tool without an agent identity." },
  },
  AGENT_INACTIVE: {
    message: "The agent identity on this request has been deactivated and cannot call tools.",
    suggestedTools: ["describe_agent", "list_agents"],
    context: { tip: "Reactivate the agent, or have the request performed without the deactivated agent identity." },
  },
  AGENT_CAPABILITY_DENIED: {
    message: "The agent is not permitted to call this tool. The agent's capability list does not contain it.",
    suggestedTools: ["describe_agent", "list_available_tools"],
    context: { tip: "Call describe_agent to review the agent's capabilities, then register the missing tool." },
  },
  AGENT_POLICY_UNAVAILABLE: {
    message: "The agent registry could not be read, so the agent's permissions could not be verified. The call was rejected.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "This is a server-side failure. Retry when the service is healthy — the call did not run." },
  },
  // ── Confirmation gate ─────────────────────────────────────────
  CONFIRMATION_GATE_UNAVAILABLE: {
    message: "The confirmation gate could not be verified, so the gated operation was rejected. The operation did not run.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "This is a server-side failure. Retry when the service is healthy." },
  },
  // ── Idempotency ───────────────────────────────────────────────
  IDEMPOTENCY_UNAVAILABLE: {
    message: "The idempotency store could not be reached, so the call could not be deduplicated. The operation did not run.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "This is a server-side failure. Retry the same request later with the same idempotency key." },
  },
  IDEMPOTENCY_UNKNOWN_STATUS: {
    message: "The stored idempotency record carries a status this server does not recognise, so the call cannot be safely deduplicated.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Use a fresh idempotency key, and report the error code to support." },
  },
  INVALID_IDEMPOTENCY_KEY: {
    message: "The idempotency key was rejected — it was empty, too long, or contained characters that are not allowed.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Supply a printable, non-empty key of at most 128 characters." },
  },
  STALE_PENDING_RECORD: {
    message: "A stale in-progress idempotency record was found for this key. The earlier request most likely crashed before completing.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Retry with a NEW idempotency key — the outcome of the earlier attempt is unknown." },
  },
  // ── Context identity ──────────────────────────────────────────
  INVALID_CONTEXT_ID: {
    message: "The request identity is not valid, so the call could not be attributed to a caller.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Check the identity fields on the request and retry." },
  },
  INVALID_TENANT_ID: {
    message: "The tenant identifier on this request is not valid, so the call could not be scoped to a tenant.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Use a tenant id made of letters, digits, hyphens and underscores." },
  },
  INVALID_USER_ID: {
    message: "The user identifier on this request is not valid, so the call could not be attributed to a caller.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "Use a printable, non-whitespace user identifier." },
  },
  // ── Shared domain errors ──────────────────────────────────────
  CONCURRENCY_RETRY: {
    message: "A serialization conflict was detected and the transaction is being retried.",
    suggestedTools: [],
    context: { tip: "No action needed — the server retries the transaction automatically." },
  },
  TENANT_CONTEXT_FAILED: {
    message: "The tenant context could not be established on the database connection, so the operation could not be scoped to a tenant.",
    suggestedTools: ["list_available_tools"],
    context: { tip: "This is a server-side failure — the row-level security setup may be incomplete. Report the error code to support." },
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

function createExplainError(): ToolDefinition {
  return {
    name: "explain_error",
    description: `Explain an error code and suggest how to recover.

Use this when you encounter an error you don't understand. Returns a plain-
English explanation and a list of tools that can help you fix the issue.

Example: explain_error({ errorCode: "INVALID_TYPE_VALUE" })`,

    inputSchema: z.strictObject({
      errorCode: z.string()
        .transform((s) => stripHtmlTags(s.trim()).toUpperCase())
        .pipe(z.string().min(1).max(MAX_ERROR_CODE_LENGTH))
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
            code: UNKNOWN_ERROR_CODE,
            message: `No explanation found for error code '${stripHtmlTags(sanitizeForLogOutput(input.errorCode))}'. Check the tool output for the exact error code, or contact support.`,
            suggestedTools: ["list_available_tools"],
            context: { errorCode: stripHtmlTags(sanitizeForLogOutput(input.errorCode)) },
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
  registry.register(createListAvailableTools(registry, prisma));
  registry.register(createGetTypeTableValues(prisma));
  registry.register(createDescribeEntity(prisma));
  registry.register(createGetValidTransitions());
  registry.register(createSearchAcrossEntities());
  registry.register(createExplainError());
}
