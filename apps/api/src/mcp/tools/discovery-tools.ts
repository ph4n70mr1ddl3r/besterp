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

    handler: async (input: { entity?: string }, _context: any) => {
      let tools = registry.getDiscoveryInfo();
      if (input.entity) {
        tools = tools.filter((t: any) => t.entity === input.entity);
      }
      return {
        success: true,
        data: {
          tools,
          totalAvailable: tools.length,
          note: "Use 'describe_entity_type' for detailed schema info on any entity.",
        },
      };
    },
  };
}

// ─── Tool: get_type_table_values ──────────────────────────────────

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

    handler: async (input: { typeName: string }, _context: any) => {
      let values: any[];

      switch (input.typeName) {
        case "PARTY_TYPE":
          values = await prisma.partyType.findMany({
            select: { partyTypeId: true, name: true, description: true, aiPromptHint: true },
          });
          break;
        case "ROLE_TYPE":
          values = await prisma.roleType.findMany({
            select: { roleTypeId: true, name: true, description: true, aiPromptHint: true },
          });
          break;
        case "CONTACT_MECHANISM_TYPE":
          values = await prisma.contactMechanismType.findMany({
            select: { contactMechanismTypeId: true, name: true, description: true, aiPromptHint: true },
          });
          break;
        default:
          return {
            success: false,
            error: {
              code: "INVALID_TYPE_TABLE",
              message: `Type table '${input.typeName}' not found. Valid tables: ['PARTY_TYPE', 'ROLE_TYPE', 'CONTACT_MECHANISM_TYPE']`,
              suggestedTools: ["get_type_table_values"],
              context: { validTypeTables: ["PARTY_TYPE", "ROLE_TYPE", "CONTACT_MECHANISM_TYPE"] },
            },
          };
      }

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
