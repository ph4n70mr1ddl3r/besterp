// Party MCP Tools — Tool definitions for the Party domain.
//
// These tools are the PRIMARY agent-facing interface for party operations.
// Each tool delegates to the NestJS PartyService for business logic.
//
// Tool naming convention: verb_entity (e.g., create_party, search_parties)
//
// VALIDATION STRATEGY (defense-in-depth across layers):
// - REST endpoints: class-validator DTOs in party.dto.ts (ValidationPipe)
// - MCP tools: Zod schemas in this file with superRefine for cross-field
// - Service layer: Explicit validation in party.service.ts
// - Database: Constraints (unique indexes, FK, CHECK) as final safety net

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
  sanitizeForLogOutput,
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
  MIN_COUNTRY_CODE_LENGTH,
  MAX_AREA_CODE_LENGTH,
  MAX_LINE_NUMBER_LENGTH,
  MAX_EXTENSION_LENGTH,
  MAX_PHONE_COUNTRY_CODE_LENGTH,
  MAX_EMAIL_LENGTH,
  EMAIL_REGEX,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
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
  if (typeof (svc as PartyServices["partyService"]).getParty !== "function") {
    throw new InvalidTypeValueError(
      "PartyService in ToolContext.services is missing required methods",
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

// Reusable Zod schema builders — eliminate repeated transform+pipe chains.
// Each helper applies stripHtmlTags + trim + length validation in one step.

/** Required string: trims, strips HTML, enforces min/max length. */
function sanitizedString(min: number, max: number) {
  return z.string().max(max)
    .transform(s => stripHtmlTags(s.trim()))
    .pipe(z.string().min(min).max(max));
}

/** Optional trimmed string that rejects whitespace-only input.
 *  Trims, strips HTML/script payloads, and normalises empty/whitespace-only input
 *  to undefined. Used for optional fields and search filters. */
function optionalFilteredString(max: number) {
  return z.string().max(max)
    .optional()
    .transform(s => {
      if (s === undefined) return undefined;
      const trimmed = stripHtmlTags(s.trim());
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .pipe(z.string().max(max).optional());
}

/** Optional ISO 8601 date: trims, validates format, enforces max length. */
function optionalIsoDate(max: number = MAX_DATE_STRING_LENGTH) {
  return z.string().max(max)
    .optional()
    .transform(s => s?.trim() || undefined)
    .pipe(z.string().max(max).optional())
    .refine(
      // After the transform, `v` is either undefined (empty/whitespace input)
      // or a non-empty string, so a length check is redundant — just validate
      // the format. Parentheses make the precedence explicit.
      v => v === undefined || isValidISODate(v),
      "Invalid date format - must be ISO 8601"
    );
}

/**
 * UUID path parameter. Centralises the repeated id schema so every tool
 * shares one definition. The 36-char max matches the canonical UUID format;
 * UUID_REGEX is the real gatekeeper and is kept aligned with
 * PartyService.requireUuid by shared.test.ts.
 */
function uuidParam(description: string) {
  return z.string()
    .transform(s => s.trim())
    .pipe(z.string().min(1).max(36).regex(UUID_REGEX, "Must be a valid UUID"))
    .describe(description);
}

const personSchema = z.object({
  firstName: sanitizedString(1, MAX_PERSON_NAME_LENGTH).describe("First/given name"),
  lastName: sanitizedString(1, MAX_PERSON_NAME_LENGTH).describe("Last/family name"),
  middleName: optionalFilteredString(MAX_MIDDLE_NAME_LENGTH).describe("Middle name"),
  birthDate: optionalIsoDate().describe("Date of birth (ISO 8601)"),
  gender: optionalFilteredString(MAX_GENDER_LENGTH).describe("Gender"),
});

const organizationSchema = z.object({
  legalName: sanitizedString(1, MAX_LEGAL_NAME_LENGTH).describe("Legal/registered name of the organization"),
  taxId: optionalFilteredString(MAX_TAX_ID_LENGTH).describe("Tax identification number"),
  registrationDate: optionalIsoDate().describe("Date of registration (ISO 8601)"),
});

const postalAddressSchema = z.object({
  addressLine1: sanitizedString(1, MAX_ADDRESS_LINE_LENGTH).describe("Street address line 1"),
  addressLine2: optionalFilteredString(MAX_ADDRESS_LINE_LENGTH).describe("Street address line 2"),
  city: sanitizedString(1, MAX_CITY_LENGTH).describe("City"),
  stateProvince: optionalFilteredString(MAX_STATE_PROVINCE_LENGTH).describe("State or province"),
  postalCode: optionalFilteredString(MAX_POSTAL_CODE_LENGTH).describe("Postal/ZIP code"),
  country: z.string().max(MAX_COUNTRY_CODE_LENGTH)
    .transform(s => stripHtmlTags(s.trim().toUpperCase()))
    .pipe(z.string().min(MIN_COUNTRY_CODE_LENGTH).max(MAX_COUNTRY_CODE_LENGTH))
    .describe("Country code (e.g., US, DE, JP)"),
});

const telecomNumberSchema = z.object({
  countryCode: z.string().max(MAX_PHONE_COUNTRY_CODE_LENGTH)
    .optional()
    .transform(s => s?.trim() || undefined)
    .pipe(z.string().min(1).max(MAX_PHONE_COUNTRY_CODE_LENGTH).regex(COUNTRY_CODE_REGEX, "Must be an E.164 country code (e.g., '+1', '+44')").optional())
    .describe("E.164 country code (e.g., '+1', '+44'). The service layer applies a default of '+1' if omitted."),
  areaCode: sanitizedString(1, MAX_AREA_CODE_LENGTH).describe("Area code"),
  lineNumber: sanitizedString(1, MAX_LINE_NUMBER_LENGTH).describe("Phone line number"),
  extension: optionalFilteredString(MAX_EXTENSION_LENGTH).describe("Extension"),
});

const emailAddressSchema = z.object({
  // Route through the SAME `EMAIL_REGEX` the service layer uses (party.service.ts),
  // not Zod's built-in `.email()`. Zod's validator accepts addresses the
  // service's `EMAIL_REGEX` rejects (e.g. a double-dot local part
  // `a..b@x.com`), so an MCP-submitted address could pass validation here and
  // then be rejected by the service's duplicate-check / re-validation — a
  // cross-surface inconsistency (round-50 review). The service is canonical, so
  // the MCP path must agree with it.
  email: z.string().max(MAX_EMAIL_LENGTH).transform(s => stripHtmlTags(s.trim().toLowerCase()))
    .pipe(z.string().max(MAX_EMAIL_LENGTH).regex(EMAIL_REGEX, "Invalid email format (must match EMAIL_REGEX)"))
    .describe("Email address"),
});

// ─── Tool: create_party ───────────────────────────────────────────

const createPartySchema = z.object({
  partyType: z.enum(["PERSON", "ORGANIZATION"]).describe("Type of party to create"),
  name: sanitizedString(1, MAX_PARTY_NAME_LENGTH).describe("Display name for the party (1-500 characters)"),
  description: optionalFilteredString(MAX_PARTY_DESCRIPTION_LENGTH).describe("Optional description (max 1000 characters)"),
  person: personSchema.optional().describe("Person details (required when partyType is PERSON)"),
  organization: organizationSchema.optional().describe("Organization details (required when partyType is ORGANIZATION)"),
}).superRefine((data, ctx) => {
  validateSubtypeFields(data, ctx, data.partyType, PARTY_SUBTYPE_CONFIGS);
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
  create_party({ partyType: "ORGANIZATION", name: "Acme Corp", organization: { legalName: "Acme Corporation Ltd." } })

For idempotent writes, pass an idempotencyKey (string, max 500 chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: createPartySchema,

  riskLevel: "low",
  entity: "party",
  tags: ["party", "create", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as CreatePartyInput_z;
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
    partyId: uuidParam("The unique UUID of the party"),
  }),

  riskLevel: "none",
  entity: "party",
  tags: ["party", "read", "core"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as { partyId: string };
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
  name: optionalFilteredString(MAX_PARTY_NAME_LENGTH).describe("Filter by name (case-insensitive partial match)"),
  partyType: z.enum(["PERSON", "ORGANIZATION"]).optional().describe("Filter by party type"),
  roleType: optionalFilteredString(MAX_ROLE_TYPE_LENGTH).describe("Filter by role type name (e.g., 'Customer', 'Supplier')"),
  limit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT).describe(`Maximum results to return (max ${MAX_SEARCH_LIMIT})`),
  offset: z.number().int().min(MIN_SEARCH_OFFSET).max(MAX_SEARCH_OFFSET).optional().default(0).describe(`Number of results to skip (min ${MIN_SEARCH_OFFSET})`),
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

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as SearchPartiesInput_z;
    const svc = getPartyService(context);
    const result = await svc.searchParties({
      ...input,
      tenantId: context.tenantId,
    });
    const morePages = result.hasMore
      ? ` Use offset ${Math.min(result.offset + result.limit, result.total)} to see more results.`
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
  partyId: uuidParam("The UUID of the party to assign the role to"),
  roleType: sanitizedString(1, MAX_ROLE_TYPE_LENGTH).describe("Role type name (e.g., 'Customer', 'Supplier', 'Employee')"),
  fromDate: optionalIsoDate().describe(`Start date for the role (ISO 8601, max ${MAX_DATE_STRING_LENGTH} chars, default: now)`),
});

type AddPartyRoleInput_z = z.infer<typeof addPartyRoleSchema>;

const addPartyRole: ToolDefinition = {
  name: "add_party_role",
  description: `Assign a role to a party.

Roles determine what a party can do in the system (Customer, Supplier, Employee, etc.).
A party can have multiple roles. Use 'get_type_table_values' with typeName "ROLE_TYPE" to see available roles.

Example: Make a party a customer
  add_party_role({ partyId: "abc-123", roleType: "Customer" })

For idempotent writes, pass an idempotencyKey (string, max 500 chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: addPartyRoleSchema,

  riskLevel: "low",
  entity: "party",
  tags: ["party", "role", "update"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as AddPartyRoleInput_z;
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
        // `input.roleType` is HTML-stripped by the Zod schema but NOT
        // secret-sanitized (it may carry a `?api_key=…`/connection-string
        // payload). `nextActions` is reflected to the agent verbatim and is
        // excluded from the audit/error-handler `data` redaction, so run it
        // through sanitizeForLogOutput to match every other agent-facing
        // surface (the round-48 asymmetric-leak class). stripHtmlTags is
        // applied as defense-in-depth so any HTML that survived the Zod
        // transform (e.g. via a bypassed validator) is also stripped.
        `Role '${sanitizeForLogOutput(stripHtmlTags(input.roleType))}' assigned. Use 'get_party' to see all roles for this party.`,
        "Use 'add_contact_mechanism' to add contact information.",
      ],
    };
  },
};

// ─── Tool: add_contact_mechanism ──────────────────────────────────

const addContactMechanismSchema = z.object({
  partyId: uuidParam("The UUID of the party to add the contact to"),
  contactMechanismType: z.enum(["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"])
    .describe("Type of contact mechanism"),
  postalAddress: postalAddressSchema.optional()
    .describe("Postal address details (required when contactMechanismType is POSTAL_ADDRESS)"),
  telecomNumber: telecomNumberSchema.optional()
    .describe("Phone number details (required when contactMechanismType is TELECOM_NUMBER)"),
  emailAddress: emailAddressSchema.optional()
    .describe("Email details (required when contactMechanismType is EMAIL_ADDRESS)"),
}).superRefine((data, ctx) => {
  validateSubtypeFields(data, ctx, data.contactMechanismType, CONTACT_SUBTYPE_CONFIGS);
});

type AddContactMechanismInput_z = z.infer<typeof addContactMechanismSchema>;

const addContactMechanism: ToolDefinition = {
  name: "add_contact_mechanism",
  description: `Add a contact mechanism (address, phone, or email) to a party.

Use this to add postal addresses, phone numbers, or email addresses to a party.
A party can have multiple contacts of each type.

Use 'get_type_table_values' with typeName "CONTACT_MECHANISM_TYPE" to see available types.

For idempotent writes, pass an idempotencyKey (string, max 500 chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: addContactMechanismSchema,

  riskLevel: "low",
  entity: "party",
  tags: ["party", "contact", "create"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as AddContactMechanismInput_z;
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
