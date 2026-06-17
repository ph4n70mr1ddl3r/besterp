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
import {
  UUID_REGEX,
  COUNTRY_CODE_REGEX,
  isValidISODate,
  stripHtmlTags,
  InvalidTypeValueError,
  MAX_PERSON_NAME_LENGTH,
  MAX_MIDDLE_NAME_LENGTH,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_LEGAL_NAME_LENGTH,
  MAX_TAX_ID_LENGTH,
  MAX_ROLE_TYPE_LENGTH,
  MAX_GENDER_LENGTH,
  MAX_DATE_STRING_LENGTH,
  MAX_ADDRESS_LINE_LENGTH,
  MAX_CITY_LENGTH,
  MAX_STATE_PROVINCE_LENGTH,
  MAX_POSTAL_CODE_LENGTH,
  MAX_COUNTRY_CODE_LENGTH,
  MAX_AREA_CODE_LENGTH,
  MAX_LINE_NUMBER_LENGTH,
  MAX_EXTENSION_LENGTH,
  MAX_PHONE_COUNTRY_CODE_LENGTH,
  MAX_EMAIL_LENGTH,
} from "@besterp/shared";
import type {
  CreatePartyInput,
  SearchPartiesInput,
  AddPartyRoleInput,
  AddContactMechanismInput,
  PartyResult,
  SearchPartiesResult,
  PartyRoleResult,
  ContactMechanismResult,
} from "../../modules/core/party/party.types.js";

// Services are accessed via context.services — this is the contract
// the MCP module must satisfy when building ToolContext.
interface PartyServices {
  partyService: {
    createParty(input: CreatePartyInput): Promise<PartyResult>;
    getParty(tenantId: string, partyId: string): Promise<PartyResult>;
    searchParties(input: SearchPartiesInput): Promise<SearchPartiesResult>;
    addPartyRole(input: AddPartyRoleInput): Promise<PartyRoleResult>;
    addContactMechanism(input: AddContactMechanismInput): Promise<ContactMechanismResult>;
  };
}

function getPartyService(ctx: ToolContext) {
  const svc = ctx.services.partyService;
  if (!svc || typeof svc !== "object") {
    throw new InvalidTypeValueError(
      "PartyService not available in ToolContext.services",
      { context: { field: "partyService" } }
    );
  }
  return svc as PartyServices["partyService"];
}

// ─── SuperRefine Helpers ─────────────────────────────────────────

interface SubtypeFieldConfig {
  requiredField: string;
  requiredMessage: string;
  disallowedFields: { field: string; message: string }[];
}

function validateSubtypeFields<T extends Record<string, unknown>>(
  data: T,
  ctx: z.RefinementCtx,
  subtypeKey: keyof T & string,
  subtypeValue: string,
  configs: Record<string, SubtypeFieldConfig>,
): void {
  const config = configs[subtypeValue];
  if (!config) return;

  const requiredField = config.requiredField as keyof T & string;
  if (data[requiredField] === undefined) {
    ctx.addIssue({ code: "custom", message: config.requiredMessage, path: [requiredField] });
  }
  for (const { field, message } of config.disallowedFields) {
    if (data[field as keyof T] !== undefined) {
      ctx.addIssue({ code: "custom", message, path: [field] });
    }
  }
}

const PARTY_SUBTYPE_CONFIGS: Record<string, SubtypeFieldConfig> = {
  PERSON: {
    requiredField: "person",
    requiredMessage: "'person' is required when partyType is PERSON",
    disallowedFields: [{ field: "organization", message: "'organization' should not be provided when partyType is PERSON" }],
  },
  ORGANIZATION: {
    requiredField: "organization",
    requiredMessage: "'organization' is required when partyType is ORGANIZATION",
    disallowedFields: [{ field: "person", message: "'person' should not be provided when partyType is ORGANIZATION" }],
  },
};

const CONTACT_SUBTYPE_CONFIGS: Record<string, SubtypeFieldConfig> = {
  POSTAL_ADDRESS: {
    requiredField: "postalAddress",
    requiredMessage: "postalAddress is required when contactMechanismType is POSTAL_ADDRESS",
    disallowedFields: [
      { field: "telecomNumber", message: "telecomNumber should not be provided when contactMechanismType is POSTAL_ADDRESS" },
      { field: "emailAddress", message: "emailAddress should not be provided when contactMechanismType is POSTAL_ADDRESS" },
    ],
  },
  TELECOM_NUMBER: {
    requiredField: "telecomNumber",
    requiredMessage: "telecomNumber is required when contactMechanismType is TELECOM_NUMBER",
    disallowedFields: [
      { field: "postalAddress", message: "postalAddress should not be provided when contactMechanismType is TELECOM_NUMBER" },
      { field: "emailAddress", message: "emailAddress should not be provided when contactMechanismType is TELECOM_NUMBER" },
    ],
  },
  EMAIL_ADDRESS: {
    requiredField: "emailAddress",
    requiredMessage: "emailAddress is required when contactMechanismType is EMAIL_ADDRESS",
    disallowedFields: [
      { field: "postalAddress", message: "postalAddress should not be provided when contactMechanismType is EMAIL_ADDRESS" },
      { field: "telecomNumber", message: "telecomNumber should not be provided when contactMechanismType is EMAIL_ADDRESS" },
    ],
  },
};

// ─── Schemas ──────────────────────────────────────────────────────

const personSchema = z.object({
  firstName: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_PERSON_NAME_LENGTH)).describe("First/given name"),
  lastName: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_PERSON_NAME_LENGTH)).describe("Last/family name"),
  middleName: z.string().optional().transform(s => s?.trim() || undefined).pipe(z.string().max(MAX_MIDDLE_NAME_LENGTH).optional()).describe("Middle name"),
  birthDate: z.string().optional().transform(s => s?.trim() || undefined)
    .pipe(z.string().max(MAX_DATE_STRING_LENGTH).optional())
    .refine(
      v => v === undefined || isValidISODate(v),
      "Invalid date format - must be ISO 8601"
    )
    .describe("Date of birth (ISO 8601)"),
  gender: z.string().optional().transform(s => s?.trim() || undefined).pipe(z.string().max(MAX_GENDER_LENGTH).optional()).describe("Gender"),
});

const organizationSchema = z.object({
  legalName: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_LEGAL_NAME_LENGTH)).describe("Legal/registered name of the organization"),
  taxId: z.string().optional().transform(s => s?.trim() || undefined).pipe(z.string().max(MAX_TAX_ID_LENGTH).optional()).describe("Tax identification number"),
  registrationDate: z.string().optional().transform(s => s?.trim() || undefined)
    .pipe(z.string().max(MAX_DATE_STRING_LENGTH).optional())
    .refine(
      v => v === undefined || isValidISODate(v),
      "Invalid date format - must be ISO 8601"
    )
    .describe("Date of registration (ISO 8601)"),
});

const postalAddressSchema = z.object({
  addressLine1: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_ADDRESS_LINE_LENGTH)).describe("Street address line 1"),
  addressLine2: z.string().optional().transform(s => s?.trim() ? stripHtmlTags(s.trim()) : undefined).pipe(z.string().max(MAX_ADDRESS_LINE_LENGTH).optional()).describe("Street address line 2"),
  city: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_CITY_LENGTH)).describe("City"),
  stateProvince: z.string().optional().transform(s => s?.trim() ? stripHtmlTags(s.trim()) : undefined).pipe(z.string().max(MAX_STATE_PROVINCE_LENGTH).optional()).describe("State or province"),
  postalCode: z.string().optional().transform(s => s?.trim() || undefined).pipe(z.string().max(MAX_POSTAL_CODE_LENGTH).optional()).describe("Postal/ZIP code"),
  country: z.string().transform(s => stripHtmlTags(s.trim().toUpperCase())).pipe(z.string().min(2).max(MAX_COUNTRY_CODE_LENGTH)).describe("Country code (e.g., US, DE, JP)"),
});

const telecomNumberSchema = z.object({
  countryCode: z.string().optional().default("+1").transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_PHONE_COUNTRY_CODE_LENGTH).regex(COUNTRY_CODE_REGEX, "Must be an E.164 country code (e.g., '+1', '+44')")).describe("Country code (default: +1)"),
  areaCode: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_AREA_CODE_LENGTH)).describe("Area code"),
  lineNumber: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_LINE_NUMBER_LENGTH)).describe("Phone line number"),
  extension: z.string().optional().transform(s => s?.trim() ? stripHtmlTags(s.trim()) : undefined).pipe(z.string().max(MAX_EXTENSION_LENGTH).optional()).describe("Extension"),
});

const emailAddressSchema = z.object({
  email: z.string().transform(s => s.trim().toLowerCase()).pipe(z.string().email().max(MAX_EMAIL_LENGTH)).describe("Email address"),
});

// ─── Tool: create_party ───────────────────────────────────────────

const createPartySchema = z.object({
  partyType: z.enum(["PERSON", "ORGANIZATION"]).describe("Type of party to create"),
  name: z.string().transform(s => stripHtmlTags(s.trim())).pipe(z.string().min(1).max(MAX_PARTY_NAME_LENGTH)).describe("Display name for the party (1-500 characters)"),
  description: z.string().optional().transform(s => s?.trim() ? stripHtmlTags(s.trim()) : undefined).pipe(z.string().max(MAX_PARTY_DESCRIPTION_LENGTH).optional()).describe("Optional description (max 1000 characters)"),
  person: personSchema.optional().describe("Person details (required when partyType is PERSON)"),
  organization: organizationSchema.optional().describe("Organization details (required when partyType is ORGANIZATION)"),
}).superRefine((data, ctx) => {
  validateSubtypeFields(data, ctx, "partyType", data.partyType, PARTY_SUBTYPE_CONFIGS);
});

type CreatePartyInput_z = z.infer<typeof createPartySchema>;

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

  inputSchema: createPartySchema,

  riskLevel: "low",
  entity: "party",
  tags: ["party", "create", "core"],

  handler: async (input: CreatePartyInput_z, context: ToolContext) => {
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
        "Use 'add_contact_mechanism' to add address, phone, or email.",
      ],
    };
  },
};

// ─── Tool: get_party ──────────────────────────────────────────────

const getParty: ToolDefinition = {
  name: "get_party",
  description: `Get a party by ID, including subtype data (person/organization) and roles.

Returns full party details. Use this to inspect a specific party's information.`,

  inputSchema: z.object({
    partyId: z.string().min(1).max(200).regex(UUID_REGEX, "Must be a valid UUID").describe("The unique UUID of the party"),
  }),

  riskLevel: "none",
  entity: "party",
  tags: ["party", "read", "core"],

  handler: async (input: { partyId: string }, context: ToolContext) => {
    const svc = getPartyService(context);
    const party = await svc.getParty(context.tenantId, input.partyId);
    return {
      success: true,
      data: party,
      nextActions: [
        "Use 'add_party_role' to assign a role to this party.",
        "Use 'add_contact_mechanism' to add address, phone, or email.",
      ],
    };
  },
};

// ─── Tool: search_parties ─────────────────────────────────────────

const searchPartiesSchema = z.object({
  name: z.string().optional().transform(s => s?.trim()).pipe(z.string().max(MAX_PARTY_NAME_LENGTH).optional()).refine(v => v === undefined || v.length > 0, "name filter cannot be whitespace-only").describe("Filter by name (case-insensitive partial match)"),
  partyType: z.enum(["PERSON", "ORGANIZATION"]).optional().describe("Filter by party type"),
  roleType: z.string().optional().transform(s => s?.trim()).pipe(z.string().max(MAX_ROLE_TYPE_LENGTH).optional()).refine(v => v === undefined || v.length > 0, "roleType filter cannot be whitespace-only").describe("Filter by role type name (e.g., 'Customer', 'Supplier')"),
  limit: z.number().int().min(1).max(500).optional().default(50).describe("Maximum results to return (max 500)"),
  offset: z.number().int().min(0).optional().default(0).describe("Number of results to skip (min 0)"),
});

type SearchPartiesInput_z = z.infer<typeof searchPartiesSchema>;

const searchParties: ToolDefinition = {
  name: "search_parties",
  description: `Search for parties with optional filters.

Returns a paginated list of parties matching the criteria.
Use this to find customers, suppliers, or any party by name, type, or role.`,

  inputSchema: searchPartiesSchema,

  riskLevel: "none",
  entity: "party",
  tags: ["party", "search", "core"],

  handler: async (input: SearchPartiesInput_z, context: ToolContext) => {
    const svc = getPartyService(context);
    const result = await svc.searchParties({
      tenantId: context.tenantId,
      ...input,
    });
    const morePages = result.hasMore
      ? ` Use offset ${result.offset + result.limit} to see more results.`
      : "";
    return {
      success: true,
      data: result,
      nextActions: [
        `Found ${result.total} ${result.total === 1 ? "party" : "parties"}.${morePages}`,
        "Use 'get_party' with a specific party ID to see full details.",
      ],
    };
  },
};

// ─── Tool: add_party_role ─────────────────────────────────────────

const addPartyRoleSchema = z.object({
  partyId: z.string().min(1).max(200).regex(UUID_REGEX, "Must be a valid UUID").describe("The UUID of the party to assign the role to"),
  roleType: z.string().transform(s => s.trim()).pipe(z.string().min(1).max(MAX_ROLE_TYPE_LENGTH)).describe("Role type name (e.g., 'Customer', 'Supplier', 'Employee')"),
  fromDate: z.string().optional().transform(s => s?.trim() || undefined)
    .pipe(z.string().max(MAX_DATE_STRING_LENGTH).optional())
    .refine(
      v => v === undefined || isValidISODate(v),
      "Invalid date format - must be ISO 8601"
    )
    .describe(`Start date for the role (ISO 8601, max ${MAX_DATE_STRING_LENGTH} chars, default: now)`),
});

type AddPartyRoleInput_z = z.infer<typeof addPartyRoleSchema>;

const addPartyRole: ToolDefinition = {
  name: "add_party_role",
  description: `Assign a role to a party.

Roles determine what a party can do in the system (Customer, Supplier, Employee, etc.).
A party can have multiple roles. Use 'get_type_table_values' with typeName "ROLE_TYPE" to see available roles.

Example: Make a party a customer
  add_party_role({ partyId: "abc-123", roleType: "Customer" })`,

  inputSchema: addPartyRoleSchema,

  riskLevel: "low",
  entity: "party",
  tags: ["party", "role", "update"],

  handler: async (input: AddPartyRoleInput_z, context: ToolContext) => {
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

const addContactMechanismSchema = z.object({
  partyId: z.string().min(1).max(200).regex(UUID_REGEX, "Must be a valid UUID").describe("The UUID of the party to add the contact to"),
  contactMechanismType: z.enum(["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"])
    .describe("Type of contact mechanism"),
  postalAddress: postalAddressSchema.optional()
    .describe("Postal address details (required when contactMechanismType is POSTAL_ADDRESS)"),
  telecomNumber: telecomNumberSchema.optional()
    .describe("Phone number details (required when contactMechanismType is TELECOM_NUMBER)"),
  emailAddress: emailAddressSchema.optional()
    .describe("Email details (required when contactMechanismType is EMAIL_ADDRESS)"),
}).superRefine((data, ctx) => {
  validateSubtypeFields(data, ctx, "contactMechanismType", data.contactMechanismType, CONTACT_SUBTYPE_CONFIGS);
});

type AddContactMechanismInput_z = z.infer<typeof addContactMechanismSchema>;

const addContactMechanism: ToolDefinition = {
  name: "add_contact_mechanism",
  description: `Add a contact mechanism (address, phone, or email) to a party.

Use this to add postal addresses, phone numbers, or email addresses to a party.
A party can have multiple contacts of each type.

Use 'get_type_table_values' with typeName "CONTACT_MECHANISM_TYPE" to see available types.`,

  inputSchema: addContactMechanismSchema,

  riskLevel: "low",
  entity: "party",
  tags: ["party", "contact", "create"],

  handler: async (input: AddContactMechanismInput_z, context: ToolContext) => {
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
