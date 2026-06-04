// BestERP Phase 0a Spike: MCP Tool Server
//
// ⚠️  DEPRECATED: This file is the Phase 0a SPIKE implementation.
//     Production code is in apps/api/src/mcp/ which uses the ToolRegistry,
//     middleware pipeline, and NestJS PartyService.
//     This file is retained ONLY for standalone spike testing.
//
// Validates: MCP as primary agent interface (ADR-001)
// - Semantic tool definitions with JSON Schema
// - One tool: create_party with full validation
// - Idempotency key support
// - Rich error messages for AI agents
// - AI action logging

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { withTenant, richError, hashInput } from "@besterp/shared";

// ─── Database ────────────────────────────────────────────────

// App client (non-superuser, subject to RLS)
// Used for ALL tenant-scoped operations: creating parties, querying
// tenant data via withTenant(). This is the primary client.
const prisma = new PrismaClient({ log: ["error"] });

// Admin client (superuser, BYPASSES RLS)
// Used ONLY for operations that require cross-tenant access:
//   1. Idempotency record lookups (need to find by key across tenants)
//   2. Type table queries (PARTY_TYPE, ROLE_TYPE etc. — not tenant-scoped)
//   3. AI action log writes (audit-level, admin context)
// NEVER use adminPrisma for tenant-scoped data reads/writes — it bypasses RLS.
const adminPrisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
  log: ["error"],
});

// ─── Tenant context helper ───────────────────────────────────
// Imported from @besterp/shared. See packages/shared/src/tenant.ts

// ─── Rich error formatter ────────────────────────────────────
// Imported from @besterp/shared. See packages/shared/src/errors.ts

// ─── Input hashing for idempotency ──────────────────────────
// Imported from @besterp/shared. See packages/shared/src/crypto.ts

// ─── MCP Server ──────────────────────────────────────────────

const server = new McpServer({
  name: "besterp-mcp",
  version: "0.1.0-spike",
});

// ─── Tool: create_party ──────────────────────────────────────

server.tool(
  "create_party",
  `Creates a new party (person or organization) in the ERP system.

Use this tool to create customers, suppliers, employees, or any party.
After creating a party, use 'add_party_role' to assign roles like Customer, Supplier, etc.

Available party types:
- PERSON: An individual human being
- ORGANIZATION: A company or business entity

Example: Create a customer person named "Jane Doe"
  create_party({ partyType: "PERSON", name: "Jane Doe", tenantId: "...", person: { firstName: "Jane", lastName: "Doe" } })

Example: Create a supplier organization
  create_party({ partyType: "ORGANIZATION", name: "Acme Corp", tenantId: "...", organization: { legalName: "Acme Corporation Ltd." } })`,

  {
    idempotencyKey: z.string().describe(
      "Unique key to prevent duplicate creation. Use format: party-create-{description}-{date}. Example: party-create-acme-corp-20260510"
    ),
    tenantId: z.string().describe("The tenant/organization ID this party belongs to"),
    partyType: z.enum(["PERSON", "ORGANIZATION"]).describe("Type of party to create"),
    name: z.string().describe("Display name for the party"),
    description: z.string().optional().describe("Optional description of the party"),

    // Person fields (required when partyType is PERSON)
    person: z
      .object({
        firstName: z.string().describe("First/given name"),
        lastName: z.string().describe("Last/family name"),
        middleName: z.string().optional().describe("Middle name"),
        birthDate: z.string().optional().describe("Date of birth (ISO 8601)"),
        gender: z.string().optional().describe("Gender"),
      })
      .optional()
      .describe("Person details (required when partyType is PERSON)"),

    // Organization fields (required when partyType is ORGANIZATION)
    organization: z
      .object({
        legalName: z.string().describe("Legal/registered name of the organization"),
        taxId: z.string().optional().describe("Tax identification number"),
        registrationDate: z.string().optional().describe("Date of registration (ISO 8601)"),
      })
      .optional()
      .describe("Organization details (required when partyType is ORGANIZATION)"),
  },

  async (input) => {
    const {
      idempotencyKey,
      tenantId,
      partyType,
      name,
      description,
      person: personData,
      organization: orgData,
    } = input;

    const toolInput = { ...input };
    const inputHash = hashInput(toolInput);

    try {
      // ─── Idempotency Check ──────────────────────────────────
      const existingRecord = await adminPrisma.idempotencyRecord.findUnique({
        where: { idempotencyKey },
      });

      if (existingRecord) {
        if (existingRecord.status === "completed") {
          // Check input hash mismatch
          if (existingRecord.inputHash !== inputHash) {
            return richError(
              "IDEMPOTENCY_KEY_MISMATCH",
              `Idempotency key '${idempotencyKey}' was already used with different input. This suggests a bug in the calling agent. Use a new idempotency key for a different operation.`,
              ["create_party"],
              { originalInputHash: existingRecord.inputHash }
            );
          }
          // Return stored result
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "replayed",
                  message: "Returning previously created party (idempotent replay)",
                  party: existingRecord.result,
                }),
              },
            ],
          };
        }
        if (existingRecord.status === "pending") {
          return richError(
            "REQUEST_IN_PROGRESS",
            `A request with idempotency key '${idempotencyKey}' is already in progress. Wait and retry.`,
            ["create_party"]
          );
        }
        // status === 'failed' — re-execute
      }

      // Create idempotency record
      if (!existingRecord) {
        await adminPrisma.idempotencyRecord.create({
          data: {
            idempotencyKey,
            toolName: "create_party",
            tenantId,
            userId: "spike-test-user",
            status: "pending",
            inputHash,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
      }

      // ─── Validation ─────────────────────────────────────────
      if (partyType === "PERSON" && !personData) {
        return richError(
          "MISSING_SUBTYPE_DATA",
          "When partyType is PERSON, the 'person' object with firstName and lastName is required.",
          ["create_party"]
        );
      }
      if (partyType === "ORGANIZATION" && !orgData) {
        return richError(
          "MISSING_SUBTYPE_DATA",
          "When partyType is ORGANIZATION, the 'organization' object with legalName is required.",
          ["create_party"]
        );
      }

      // Look up party type ID
      const partyTypeRecord = await adminPrisma.partyType.findFirst({
        where: { name: partyType },
      });
      if (!partyTypeRecord) {
        return richError(
          "INVALID_TYPE_VALUE",
          `PARTY_TYPE '${partyType}' is not valid. Valid types: ['PERSON', 'ORGANIZATION'].`,
          ["create_party"],
          { validValues: ["PERSON", "ORGANIZATION"] }
        );
      }

      // ─── Create Party ───────────────────────────────────────
      const party = await withTenant(prisma, tenantId, async (tx) => {
        return tx.party.create({
          data: {
            partyTypeId: partyTypeRecord.partyTypeId,
            tenantId,
            name,
            description: description || null,
            person: personData
              ? {
                  create: {
                    firstName: personData.firstName,
                    lastName: personData.lastName,
                    middleName: personData.middleName || null,
                    birthDate: personData.birthDate
                      ? new Date(personData.birthDate)
                      : null,
                    gender: personData.gender || null,
                  },
                }
              : undefined,
            organization: orgData
              ? {
                  create: {
                    legalName: orgData.legalName,
                    taxId: orgData.taxId || null,
                    registrationDate: orgData.registrationDate
                      ? new Date(orgData.registrationDate)
                      : null,
                  },
                }
              : undefined,
          },
          include: {
            person: true,
            organization: true,
            partyType: true,
          },
        });
      });

      const result = {
        partyId: party.partyId,
        name: party.name,
        partyType: party.partyType.name,
        person: party.person,
        organization: party.organization,
        createdAt: party.createdAt,
      };

      // Update idempotency record
      await adminPrisma.idempotencyRecord.update({
        where: { idempotencyKey },
        data: {
          status: "completed",
          result: result as any,
          completedAt: new Date(),
        },
      });

      // ─── AI Action Log ──────────────────────────────────────
      await adminPrisma.aiActionLog.create({
        data: {
          agentId: "spike-test-agent",
          conversationId: "spike-conversation-1",
          userId: "spike-test-user",
          tenantId,
          toolCalled: "create_party",
          toolInput: toolInput as any,
          toolOutput: result as any,
          reasoning: `AI agent requested creation of ${partyType} party '${name}'`,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "created",
              party: result,
              nextActions: [
                "Use 'add_party_role' to assign a role (Customer, Supplier, Employee, etc.)",
                "Use 'add_contact_mechanism' to add address, phone, or email",
              ],
            }),
          },
        ],
      };
    } catch (error: any) {
      // Update idempotency record as failed
      await adminPrisma.idempotencyRecord
        .update({
          where: { idempotencyKey },
          data: {
            status: "failed",
            error: { message: error.message, code: error.code },
          },
        })
        .catch(() => {}); // ignore update errors

      // Return rich error for AI agent
      if (error.code === "P2002") {
        return richError(
          "DUPLICATE_ENTITY",
          `A party with this data already exists. Use 'search_parties' to find existing parties.`,
          ["search_parties", "create_party"]
        );
      }

      return richError(
        "INTERNAL_ERROR",
        `Unexpected error creating party: ${error.message}. Try again with a new idempotency key.`,
        ["create_party"]
      );
    }
  }
);

// ─── Tool: list_available_tools ──────────────────────────────

server.tool(
  "list_available_tools",
  "Returns a list of all available MCP tools with descriptions. Use this to discover what operations you can perform.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            tools: [
              {
                name: "create_party",
                description: "Create a new party (person or organization)",
                riskLevel: "low",
                confirmationRequired: false,
              },
              {
                name: "list_available_tools",
                description: "List all available tools (this tool)",
                riskLevel: "none",
                confirmationRequired: false,
              },
              {
                name: "get_type_table_values",
                description: "Get valid values for a type table (e.g., PARTY_TYPE, ROLE_TYPE)",
                riskLevel: "none",
                confirmationRequired: false,
              },
            ],
            note: "This is a spike — more tools will be added in production.",
          }),
        },
      ],
    };
  }
);

// ─── Tool: get_type_table_values ─────────────────────────────

server.tool(
  "get_type_table_values",
  "Get valid values for a type table. Use this before creating entities to know valid types, roles, and classifications.",
  {
    typeName: z
      .enum(["PARTY_TYPE", "ROLE_TYPE", "CONTACT_MECHANISM_TYPE"])
      .describe("The type table to query"),
  },
  async ({ typeName }) => {
    let values: any[];

    switch (typeName) {
      case "PARTY_TYPE":
        values = await adminPrisma.partyType.findMany({
          select: { partyTypeId: true, name: true, description: true, aiPromptHint: true },
        });
        break;
      case "ROLE_TYPE":
        values = await adminPrisma.roleType.findMany({
          select: { roleTypeId: true, name: true, description: true, aiPromptHint: true },
        });
        break;
      case "CONTACT_MECHANISM_TYPE":
        values = await adminPrisma.contactMechanismType.findMany({
          select: {
            contactMechanismTypeId: true,
            name: true,
            description: true,
            aiPromptHint: true,
          },
        });
        break;
      default:
        return richError(
          "INVALID_TYPE_TABLE",
          `Type table '${typeName}' not found. Valid tables: ['PARTY_TYPE', 'ROLE_TYPE', 'CONTACT_MECHANISM_TYPE']`,
          ["get_type_table_values"],
          { validTypeTables: ["PARTY_TYPE", "ROLE_TYPE", "CONTACT_MECHANISM_TYPE"] }
        );
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ typeName, values, totalAvailable: values.length }),
        },
      ],
    };
  }
);

// ─── Start Server ────────────────────────────────────────────

async function main() {
  console.error("🚀 BestERP MCP Tool Server (Spike) starting...");
  console.error("   Tools: create_party, list_available_tools, get_type_table_values");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("   Connected via stdio transport");
}

main().catch((e) => {
  console.error("MCP Server failed:", e);
  process.exit(1);
});
