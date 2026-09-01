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
import { InvalidTypeValueError, sanitizeForLogOutput, stripHtmlTags, MAX_ENTITY_LENGTH } from "@besterp/shared";

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

function createGetValidTransitions(_prisma: PrismaClient): ToolDefinition {
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

// ─── Registration ─────────────────────────────────────────────────

export function registerDiscoveryTools(registry: ToolRegistry, prisma: PrismaClient): void {
  registry.register(createListAvailableTools(registry));
  registry.register(createGetTypeTableValues(prisma));
  registry.register(createDescribeEntity(prisma));
  registry.register(createGetValidTransitions(prisma));
}
