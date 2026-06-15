// Discovery MCP Tools — Tools for AI self-service and system introspection.
//
// These tools let AI agents discover what they can do, what entities
// exist, and what valid values are available. This is the "Schema-as-Prompt"
// principle from AGENTIC_AI_DESIGN.md.

import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { InvalidTypeValueError } from "@besterp/shared";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
} from "@besterp/mcp-tools";

// ─── Tool: list_available_tools ───────────────────────────────────

function createListAvailableTools(registry: ToolRegistry): ToolDefinition {
  return {
    name: "list_available_tools",
    description: `Returns a list of all available MCP tools with descriptions.

Use this to discover what operations you can perform in the ERP system.
Each tool listing includes its risk level and confirmation requirements.`,

    inputSchema: z.object({
      entity: z.string().optional().describe("Filter tools by entity (e.g., 'party', 'order')"),
    }),

    riskLevel: "none",
    tags: ["discovery", "meta"],

    handler: async (input: { entity?: string }, _context: ToolContext) => {
      let tools = registry.getDiscoveryInfo();
      if (input.entity) {
        tools = tools.filter((t) => t.entity === input.entity);
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

type TypeTableRow = { id: string; name: string; description: string | null; aiPromptHint: string | null };

function queryTypeTable(
  prisma: PrismaClient,
  delegateName: string,
  idField: string,
): Promise<TypeTableRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any)[delegateName].findMany({
    select: { [idField]: true, name: true, description: true, aiPromptHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }).then((rows: any[]) =>
    rows.map((r) => ({
      id: r[idField] as string,
      name: r.name as string,
      description: r.description as string | null,
      aiPromptHint: r.aiPromptHint as string | null,
    }))
  );
}

function createGetTypeTableValues(prisma: PrismaClient): ToolDefinition {
  return {
    name: "get_type_table_values",
    description: `Get valid values for a type table.

Use this before creating entities to know valid types, roles, and classifications.
Type tables are the ERP's vocabulary — they define what classifications are available.`,

    inputSchema: z.object({
      typeName: z.enum(["PARTY_TYPE", "ROLE_TYPE", "CONTACT_MECHANISM_TYPE"])
        .describe("The type table to query"),
    }),

    riskLevel: "none",
    tags: ["discovery", "type-table"],

    handler: async (input: { typeName: "PARTY_TYPE" | "ROLE_TYPE" | "CONTACT_MECHANISM_TYPE" }, _context: ToolContext) => {

      const queries: Record<typeof input.typeName, () => Promise<TypeTableRow[]>> = {
        PARTY_TYPE: () => queryTypeTable(prisma, "partyType", "partyTypeId"),
        ROLE_TYPE: () => queryTypeTable(prisma, "roleType", "roleTypeId"),
        CONTACT_MECHANISM_TYPE: () => queryTypeTable(prisma, "contactMechanismType", "contactMechanismTypeId"),
      };

      const query = queries[input.typeName];
      if (!query) {
        throw new InvalidTypeValueError(
          `Unhandled type table: ${input.typeName}`,
          { context: { typeName: input.typeName } }
        );
      }
      const values = await query();

      return {
        success: true,
        data: { typeName: input.typeName, values, totalAvailable: values.length },
      };
    },
  };
}

// ─── Registration ─────────────────────────────────────────────────

export function registerDiscoveryTools(registry: ToolRegistry, prisma: PrismaClient): void {
  registry.register(createListAvailableTools(registry));
  registry.register(createGetTypeTableValues(prisma));
}
