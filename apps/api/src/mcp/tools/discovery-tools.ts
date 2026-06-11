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

    handler: async (input: { typeName: string }, _context: ToolContext) => {

      // Zod enum validates typeName at the registry level — all cases are exhaustive.
      const handlers: { [K in "PARTY_TYPE" | "ROLE_TYPE" | "CONTACT_MECHANISM_TYPE"]: () => Promise<TypeTableRow[]> } = {
        PARTY_TYPE: async () => (await prisma.partyType.findMany({
          select: { partyTypeId: true, name: true, description: true, aiPromptHint: true },
        })).map((r) => ({ id: r.partyTypeId, name: r.name, description: r.description, aiPromptHint: r.aiPromptHint })),
        ROLE_TYPE: async () => (await prisma.roleType.findMany({
          select: { roleTypeId: true, name: true, description: true, aiPromptHint: true },
        })).map((r) => ({ id: r.roleTypeId, name: r.name, description: r.description, aiPromptHint: r.aiPromptHint })),
        CONTACT_MECHANISM_TYPE: async () => (await prisma.contactMechanismType.findMany({
          select: { contactMechanismTypeId: true, name: true, description: true, aiPromptHint: true },
        })).map((r) => ({ id: r.contactMechanismTypeId, name: r.name, description: r.description, aiPromptHint: r.aiPromptHint })),
      };

      const handler = handlers[input.typeName];
      // Safety net — Zod enum should make this unreachable
      if (!handler) {
        throw new InvalidTypeValueError(
          `Unhandled type table: ${input.typeName}`,
          { context: { typeName: input.typeName } }
        );
      }
      const values = await handler();

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
