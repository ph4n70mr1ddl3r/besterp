// Party MCP Tools — Tool definitions for the Party domain.
//
// These tools are the PRIMARY agent-facing interface for party operations.
// Each tool delegates to the NestJS PartyService for business logic.
//
// Tool naming convention: verb_entity (e.g., create_party, search_parties)

import { z } from "zod";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
} from "@besterp/mcp-tools";
import type {
  CreatePartyInput,
  SearchPartiesInput,
  AddPartyRoleInput,
  AddContactMechanismInput,
} from "../../modules/core/party/party.types.js";

// Services are accessed via context.services — this is the contract
// the MCP module must satisfy when building ToolContext.
interface PartyServices {
  partyService: {
    createParty(input: CreatePartyInput): Promise<any>;
    getParty(tenantId: string, partyId: string): Promise<any>;
    searchParties(input: SearchPartiesInput): Promise<any>;
    addPartyRole(input: AddPartyRoleInput): Promise<any>;
    addContactMechanism(input: AddContactMechanismInput): Promise<any>;
  };
}

function getPartyService(ctx: ToolContext) {
  return (ctx.services as unknown as PartyServices).partyService;
}

// ─── Schemas ──────────────────────────────────────────────────────

const personSchema = z.object({
  firstName: z.string().min(1).max(200).transform(s => s.trim()).describe("First/given name"),
  lastName: z.string().min(1).max(200).transform(s => s.trim()).describe("Last/family name"),
  middleName: z.string().max(100).optional().transform(s => s?.trim()).describe("Middle name"),
  birthDate: z.string().max(30).optional().describe("Date of birth (ISO 8601)"),
  gender: z.string().max(50).optional().transform(s => s?.trim()).describe("Gender"),
});

const organizationSchema = z.object({
  legalName: z.string().min(1).max(500).transform(s => s.trim()).describe("Legal/registered name of the organization"),
  taxId: z.string().max(50).optional().transform(s => s?.trim()).describe("Tax identification number"),
  registrationDate: z.string().optional().describe("Date of registration (ISO 8601)"),
});

const postalAddressSchema = z.object({
  addressLine1: z.string().min(1).max(200).transform(s => s.trim()).describe("Street address line 1"),
  addressLine2: z.string().max(200).optional().transform(s => s?.trim()).describe("Street address line 2"),
  city: z.string().min(1).max(100).transform(s => s.trim()).describe("City"),
  stateProvince: z.string().max(100).optional().transform(s => s?.trim()).describe("State or province"),
  postalCode: z.string().max(20).optional().transform(s => s?.trim()).describe("Postal/ZIP code"),
  country: z.string().min(1).max(3).transform(s => s.trim()).describe("Country code (e.g., US, DE, JP)"),
});

const telecomNumberSchema = z.object({
  countryCode: z.string().max(5).optional().default("+1").transform(s => s?.trim() ?? "+1").describe("Country code (default: +1)"),
  areaCode: z.string().min(1).max(10).transform(s => s.trim()).describe("Area code"),
  lineNumber: z.string().min(1).max(20).transform(s => s.trim()).describe("Phone line number"),
  extension: z.string().max(10).optional().transform(s => s?.trim()).describe("Extension"),
});

const emailAddressSchema = z.object({
  email: z.string().email().transform(s => s.trim().toLowerCase()).describe("Email address"),
});

// ─── Tool: create_party ───────────────────────────────────────────

const createParty: ToolDefinition = {
  name: "create_party",
  description: `Creates a new party (person or organization) in the ERP system.

Use this tool to create customers, suppliers, employees, or any party.
After creating a party, use 'add_party_role' to assign roles like Customer, Supplier, etc.
Then use 'add_contact_mechanism' to add address, phone, or email.

Available party types:
- PERSON: An individual human being
- ORGANIZATION: A company or business entity

Example: Create a customer person named "Jane Doe"
  create_party({ partyType: "PERSON", name: "Jane Doe", person: { firstName: "Jane", lastName: "Doe" } })

Example: Create a supplier organization
  create_party({ partyType: "ORGANIZATION", name: "Acme Corp", organization: { legalName: "Acme Corporation Ltd." } })`,

  inputSchema: z.object({
    idempotencyKey: z.string().describe(
      "Unique key to prevent duplicate creation. Format: party-create-{description}-{date}"
    ),
    partyType: z.enum(["PERSON", "ORGANIZATION"]).describe("Type of party to create"),
    name: z.string().min(1).max(500).transform(s => s.trim()).describe("Display name for the party (1-500 characters)"),
    description: z.string().max(1000).optional().transform(s => s?.trim()).describe("Optional description (max 1000 characters)"),
    person: personSchema.optional().describe("Person details (required when partyType is PERSON)"),
    organization: organizationSchema.optional().describe("Organization details (required when partyType is ORGANIZATION)"),
  }).refine(
    (data) => {
      if (data.partyType === "PERSON") return data.person !== undefined;
      if (data.partyType === "ORGANIZATION") return data.organization !== undefined;
      return true;
    },
    {
      message: "'person' is required when partyType is PERSON, 'organization' is required when partyType is ORGANIZATION",
      path: ["partyType"],
    }
  ),

  riskLevel: "low",
  entity: "party",
  tags: ["party", "create", "core"],

  handler: async (input: any, context: ToolContext) => {
    const svc = getPartyService(context);
    const party = await svc.createParty({
      tenantId: context.tenantId,
      partyType: input.partyType,
      name: input.name,
      description: input.description,
      person: input.person,
      organization: input.organization,
    });

    return {
      success: true,
      data: party,
      nextActions: [
        "Use 'add_party_role' to assign a role (Customer, Supplier, Employee, etc.)",
        "Use 'add_contact_mechanism' to add address, phone, or email",
      ],
    };
  },
};

// ─── Tool: get_party ──────────────────────────────────────────────

const getParty: ToolDefinition = {
  name: "get_party",
  description: `Get a party by ID, including subtype data (person/organization), roles, and contacts.

Returns full party details. Use this to inspect a specific party's information.`,

  inputSchema: z.object({
    partyId: z.string().min(1).describe("The unique ID of the party"),
  }),

  riskLevel: "none",
  entity: "party",
  tags: ["party", "read", "core"],

  handler: async (input: any, context: ToolContext) => {
    const svc = getPartyService(context);
    const party = await svc.getParty(context.tenantId, input.partyId);
    return { success: true, data: party };
  },
};

// ─── Tool: search_parties ─────────────────────────────────────────

const searchParties: ToolDefinition = {
  name: "search_parties",
  description: `Search for parties with optional filters.

Returns a paginated list of parties matching the criteria.
Use this to find customers, suppliers, or any party by name, type, or role.`,

  inputSchema: z.object({
    name: z.string().optional().transform(s => s?.trim()).describe("Filter by name (case-insensitive partial match)"),
    partyType: z.enum(["PERSON", "ORGANIZATION"]).optional().describe("Filter by party type"),
    roleType: z.string().optional().describe("Filter by role type name (e.g., 'Customer', 'Supplier')"),
    limit: z.number().int().min(1).max(500).optional().default(50).describe("Maximum results to return (max 500)"),
    offset: z.number().int().min(0).optional().default(0).describe("Number of results to skip (min 0)"),
  }),

  riskLevel: "none",
  entity: "party",
  tags: ["party", "search", "core"],

  handler: async (input: any, context: ToolContext) => {
    const svc = getPartyService(context);
    const result = await svc.searchParties({
      tenantId: context.tenantId,
      ...input,
    });
    return { success: true, data: result };
  },
};

// ─── Tool: add_party_role ─────────────────────────────────────────

const addPartyRole: ToolDefinition = {
  name: "add_party_role",
  description: `Assign a role to a party.

Roles determine what a party can do in the system (Customer, Supplier, Employee, etc.).
A party can have multiple roles. Use 'get_type_table_values' with typeName "ROLE_TYPE" to see available roles.

Example: Make a party a customer
  add_party_role({ partyId: "abc-123", roleType: "Customer" })`,

  inputSchema: z.object({
    idempotencyKey: z.string().describe("Idempotency key to prevent duplicate role assignment. Format: role-{partyId}-{roleType}-{date}"),
    partyId: z.string().min(1).describe("The party to assign the role to"),
    roleType: z.string().min(1).max(100).describe("Role type name (e.g., 'Customer', 'Supplier', 'Employee')"),
    fromDate: z.string().optional().describe("Start date for the role (ISO 8601, default: now)"),
  }),

  riskLevel: "low",
  entity: "party",
  tags: ["party", "role", "update"],

  handler: async (input: any, context: ToolContext) => {
    const svc = getPartyService(context);
    const result = await svc.addPartyRole({
      tenantId: context.tenantId,
      partyId: input.partyId,
      roleType: input.roleType,
      fromDate: input.fromDate,
    });
    return {
      success: true,
      data: result,
      nextActions: [
        `Role '${input.roleType}' assigned. Use 'get_party' to see all roles for this party.`,
        "Use 'add_contact_mechanism' to add contact information.",
      ],
    };
  },
};

// ─── Tool: add_contact_mechanism ──────────────────────────────────

const addContactMechanism: ToolDefinition = {
  name: "add_contact_mechanism",
  description: `Add a contact mechanism (address, phone, or email) to a party.

Use this to add postal addresses, phone numbers, or email addresses to a party.
A party can have multiple contacts of each type.

Use 'get_type_table_values' with typeName "CONTACT_MECHANISM_TYPE" to see available types.`,

  inputSchema: z.object({
    idempotencyKey: z.string().describe("Idempotency key to prevent duplicate contact creation. Format: contact-{partyId}-{type}-{date}"),
    partyId: z.string().min(1).describe("The party to add the contact to"),
    contactMechanismType: z.enum(["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"])
      .describe("Type of contact mechanism"),
    postalAddress: postalAddressSchema.optional()
      .describe("Postal address details (required when contactMechanismType is POSTAL_ADDRESS)"),
    telecomNumber: telecomNumberSchema.optional()
      .describe("Phone number details (required when contactMechanismType is TELECOM_NUMBER)"),
    emailAddress: emailAddressSchema.optional()
      .describe("Email details (required when contactMechanismType is EMAIL_ADDRESS)"),
  }).refine(
    (data) => {
      if (data.contactMechanismType === "POSTAL_ADDRESS") return data.postalAddress !== undefined;
      if (data.contactMechanismType === "TELECOM_NUMBER") return data.telecomNumber !== undefined;
      if (data.contactMechanismType === "EMAIL_ADDRESS") return data.emailAddress !== undefined;
      return true;
    },
    {
      message: "The matching subtype data must be provided for the chosen contactMechanismType",
      path: ["contactMechanismType"],
    }
  ),

  riskLevel: "low",
  entity: "party",
  tags: ["party", "contact", "create"],

  handler: async (input: any, context: ToolContext) => {
    const svc = getPartyService(context);
    const result = await svc.addContactMechanism({
      tenantId: context.tenantId,
      partyId: input.partyId,
      contactMechanismType: input.contactMechanismType,
      postalAddress: input.postalAddress,
      telecomNumber: input.telecomNumber,
      emailAddress: input.emailAddress,
    });
    return {
      success: true,
      data: result,
      nextActions: [
        "Use 'get_party' to see all contacts for this party.",
        "Use 'add_party_role' to assign additional roles.",
      ],
    };
  },
};

// ─── Registration ─────────────────────────────────────────────────

/**
 * Register all party tools with the tool registry.
 */
export function registerPartyTools(registry: ToolRegistry): void {
  registry.register(createParty);
  registry.register(getParty);
  registry.register(searchParties);
  registry.register(addPartyRole);
  registry.register(addContactMechanism);
}
