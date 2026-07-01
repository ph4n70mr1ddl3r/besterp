// Party Domain Service — Core business logic for party operations.
//
// This service encapsulates ALL party-related business logic:
// - Creating parties (person/organization with supertype/subtype)
// - Assigning roles (Customer, Supplier, Employee, etc.)
// - Adding contact mechanisms (address, phone, email)
// - Searching parties with filters
//
// SECURITY LAYERS (defense-in-depth):
// 1. RLS: Every operation uses a tenant-scoped PrismaClient that calls
//    `set_tenant_context()` at the database level. Even if a developer
//    forgets a `where: { tenantId }` filter, RLS prevents cross-tenant access.
// 2. Application-level: Explicit `tenantId` filters are still applied as a
//    secondary safeguard and for query performance.
//
// VALIDATION STRATEGY (defense-in-depth across layers):
// - REST endpoints: class-validator DTOs in party.dto.ts (ValidationPipe)
// - MCP tools: Zod schemas in party-tools.ts with superRefine for cross-field
// - Service layer: Explicit validation in each method (this file)
// - Database: Constraints (unique indexes, FK, CHECK) as final safety net
//
// This service is a create-and-relation path — it does not perform
// general-purpose updates. Duplicate-role prevention is enforced by the
// `party_active_role_unique` DB constraint (and caught as P2002 if the
// application-level check is ever removed).

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service.js";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantScopedClient } from "@besterp/database";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyConflictError,
  UUID_REGEX,
  EMAIL_REGEX,
  COUNTRY_CODE_REGEX,
  isValidISODate,
  stripHtmlTags,
  sanitizeForLog,
  MAX_PARTY_NAME_LENGTH,
  MAX_PARTY_DESCRIPTION_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_MIDDLE_NAME_LENGTH,
  MAX_LEGAL_NAME_LENGTH,
  MAX_TAX_ID_LENGTH,
  MAX_ROLE_TYPE_LENGTH,
  MAX_CONTACT_MECHANISM_TYPE_LENGTH,
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
  MAX_GENDER_LENGTH,
  MAX_DATE_STRING_LENGTH,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  DEFAULT_SEARCH_LIMIT,
  MAX_TENANT_ID_LENGTH,
} from "@besterp/shared";
import {
  CreatePartyInput,
  PartyResult,
  SearchPartiesInput,
  SearchPartiesResult,
  AddPartyRoleInput,
  PartyRoleResult,
  AddContactMechanismInput,
  ContactMechanismResult,
} from "./party.types.js";

// Prisma return type for party queries with standard includes
type PartyWithIncludes = Prisma.PartyGetPayload<{
  include: {
    person: true;
    organization: true;
    partyType: true;
    roles: { include: { roleType: true } };
  };
}>;

@Injectable()
export class PartyService {
  private readonly logger = new Logger(PartyService.name);

  constructor(private readonly prisma: PrismaService) {}

  private static readonly PARTY_INCLUDE = {
    person: true,
    organization: true,
    partyType: true,
    roles: { include: { roleType: true } },
  } satisfies Prisma.PartyInclude;

  // ─── Create Party ─────────────────────────────────────────────

  async createParty(input: CreatePartyInput): Promise<PartyResult> {
    const { tenantId, partyType, name, description, person: personData, organization: orgData } = input;

    // Validate tenantId format — defense-in-depth for MCP callers that bypass DTO/Zod
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "create", "create_party");

    // Trim partyType FIRST so validation uses canonical value.
    // Boundary layers (REST @IsEnum, MCP z.enum) reject whitespace-padded
    // values, but the service is the last line of defense for direct/internal
    // callers. Previously it validated against untrimmed value, letting
    // partyType " PERSON " with BOTH person and organization data bypass
    // the exclusivity check (no DB constraint enforces at-most-one subtype).
    // Guard against non-string partyType first — only an issue for direct
    // callers that bypass boundary validation, but defense-in-depth matters.
    if (typeof partyType !== "string" || !partyType.trim()) {
      throw new InvalidTypeValueError(
        "Party type is required and must be a non-empty string.",
        { suggestedTools: ["create_party"], context: { field: "partyType", received: typeof partyType } }
      );
    }
    const trimmedPartyType = partyType.trim();

    const { trimmedName, trimmedDescription } = this.validateCreatePartyFields(name, description);
    this.validateCreatePartySubtype(trimmedPartyType, personData, orgData);
    this.validatePersonData(personData);
    this.validateOrganizationData(orgData);

    const { sanitizedPerson, sanitizedOrg, sanitizedName, sanitizedDescription } =
      this.sanitizeCreatePartyInput(trimmedName, trimmedDescription, personData, orgData);

    // Reject names that are entirely consumed by stripHtmlTags — the
    // boundary layers (REST DTO sanitizeTransform, MCP Zod sanitizedString)
    // both strip HTML before validation, so a raw-HTML-only name is caught
    // upstream. This is defense-in-depth for direct/internal callers.
    if (!sanitizedName) {
      throw new InvalidTypeValueError(
        "Party name must contain visible characters after HTML sanitization.",
        { suggestedTools: ["create_party"], context: { field: "name", originalValue: name } }
      );
    }

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const party = await this.createPartyTransaction(db, trimmedTenantId, trimmedPartyType, sanitizedName, sanitizedDescription, sanitizedPerson, sanitizedOrg);

    this.logger.log(`Created ${trimmedPartyType} party: ${sanitizeForLog(trimmedName)} (${party.partyId})`);
    return PartyService.toPartyResult(party);
  }

  private validateCreatePartyFields(name: string, description: string | undefined | null): { trimmedName: string; trimmedDescription: string | null } {
    if (typeof name !== "string") {
      throw new InvalidTypeValueError(
        "Party name is required and must be a string.",
        { suggestedTools: ["create_party"], context: { field: "name", received: typeof name } }
      );
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new InvalidTypeValueError("Party name cannot be empty", { suggestedTools: ["create_party"], context: { field: "name", received: name } });
    }
    this.requireMaxLength(trimmedName, "Party name", MAX_PARTY_NAME_LENGTH);

    const trimmedDescription = description?.trim() ?? null;
    if (trimmedDescription !== null && trimmedDescription.length === 0) {
      throw new InvalidTypeValueError("Description cannot be whitespace-only.", { suggestedTools: ["create_party"], context: { field: "description" } });
    }
    if (trimmedDescription !== null) {
      this.requireMaxLength(trimmedDescription, "Description", MAX_PARTY_DESCRIPTION_LENGTH);
    }
    return { trimmedName, trimmedDescription };
  }

  private validateCreatePartySubtype(partyType: string, personData: unknown, orgData: unknown): void {
    if (partyType === "PERSON" && !personData) {
      throw new MissingSubtypeDataError("When partyType is PERSON, the 'person' object with firstName and lastName is required.", { suggestedTools: ["create_party"], context: { partyType, missingField: "person" } });
    }
    if (partyType === "ORGANIZATION" && !orgData) {
      throw new MissingSubtypeDataError("When partyType is ORGANIZATION, the 'organization' object with legalName is required.", { suggestedTools: ["create_party"], context: { partyType, missingField: "organization" } });
    }
    if (partyType === "PERSON" && orgData) {
      throw new InvalidTypeValueError("When partyType is PERSON, 'organization' data must not be provided. Only 'person' data is expected.", { suggestedTools: ["create_party"], context: { partyType, unexpectedField: "organization" } });
    }
    if (partyType === "ORGANIZATION" && personData) {
      throw new InvalidTypeValueError("When partyType is ORGANIZATION, 'person' data must not be provided. Only 'organization' data is expected.", { suggestedTools: ["create_party"], context: { partyType, unexpectedField: "person" } });
    }
  }

  private validatePersonData(personData: CreatePartyInput["person"]): void {
    if (!personData) return;
    if (!personData.firstName || personData.firstName.trim().length === 0) {
      throw new MissingSubtypeDataError("firstName is required for person data", { suggestedTools: ["create_party"], context: { field: "firstName" } });
    }
    this.requireMaxLength(personData.firstName.trim(), "First name", MAX_PERSON_NAME_LENGTH);
    if (!personData.lastName || personData.lastName.trim().length === 0) {
      throw new MissingSubtypeDataError("lastName is required for person data", { suggestedTools: ["create_party"], context: { field: "lastName" } });
    }
    this.requireMaxLength(personData.lastName.trim(), "Last name", MAX_PERSON_NAME_LENGTH);
    if (personData.gender != null) this.requireMaxLength(personData.gender.trim(), "Gender", MAX_GENDER_LENGTH);
    if (personData.middleName != null) this.requireMaxLength(personData.middleName.trim(), "Middle name", MAX_MIDDLE_NAME_LENGTH);
    if (personData.birthDate != null) this.requireValidDate(personData.birthDate, "birthDate");
  }

  private validateOrganizationData(orgData: CreatePartyInput["organization"]): void {
    if (!orgData) return;
    if (!orgData.legalName || orgData.legalName.trim().length === 0) {
      throw new MissingSubtypeDataError("legalName is required for organization data", { suggestedTools: ["create_party"], context: { field: "legalName" } });
    }
    this.requireMaxLength(orgData.legalName.trim(), "Legal name", MAX_LEGAL_NAME_LENGTH);
    if (orgData.registrationDate != null) this.requireValidDate(orgData.registrationDate, "registrationDate");
    if (orgData.taxId != null) this.requireMaxLength(orgData.taxId.trim(), "Tax ID", MAX_TAX_ID_LENGTH);
  }

  private sanitizeCreatePartyInput(
    trimmedName: string, trimmedDescription: string | null,
    personData: CreatePartyInput["person"], orgData: CreatePartyInput["organization"],
  ): { sanitizedPerson: typeof personData; sanitizedOrg: typeof orgData; sanitizedName: string; sanitizedDescription: string | null } {
    const sanitizedPerson = personData
      ? {
          firstName: stripHtmlTags(personData.firstName.trim()),
          lastName: stripHtmlTags(personData.lastName.trim()),
          middleName: personData.middleName?.trim()
            ? stripHtmlTags(personData.middleName.trim())
            : undefined,
          gender: personData.gender?.trim() ? stripHtmlTags(personData.gender.trim()) : undefined,
          // Trim dates so the stored value is canonical. Validation
          // (requireValidDate) accepts whitespace-padded ISO dates to stay
          // consistent with parseFromDate/MCP; trimming here avoids relying
          // on new Date()'s whitespace tolerance when parsing below.
          birthDate: personData.birthDate?.trim() || undefined,
        }
      : undefined;
    const sanitizedOrg = orgData
      ? {
          legalName: stripHtmlTags(orgData.legalName.trim()),
          taxId: orgData.taxId ? stripHtmlTags(orgData.taxId.trim()) : undefined,
          // See birthDate above — store the trimmed (canonical) date string.
          registrationDate: orgData.registrationDate?.trim() || undefined,
        }
      : undefined;

    return {
      sanitizedPerson,
      sanitizedOrg,
      sanitizedName: stripHtmlTags(trimmedName),
      sanitizedDescription: trimmedDescription ? (stripHtmlTags(trimmedDescription) || null) : null,
    };
  }

  private async createPartyTransaction(
    db: PrismaClient,
    tenantId: string, partyTypeName: string,
    name: string, description: string | null,
    sanitizedPerson: CreatePartyInput["person"] | undefined,
    sanitizedOrg: CreatePartyInput["organization"] | undefined,
  ) {
    try {
      return await db.$transaction(async (tx: Prisma.TransactionClient) => {
        const partyTypeRecord = await tx.partyType.findUnique({ where: { name: partyTypeName } });
        if (!partyTypeRecord) {
          throw new InvalidTypeValueError(
            `PARTY_TYPE '${partyTypeName}' is not valid. Valid types: ['PERSON', 'ORGANIZATION'].`,
            { suggestedTools: ["get_type_table_values"], context: { field: "partyType", invalidValue: partyTypeName, validValues: ["PERSON", "ORGANIZATION"] } }
          );
        }

        const data: Prisma.PartyCreateInput = {
          partyType: { connect: { partyTypeId: partyTypeRecord.partyTypeId } },
          tenantId,
          name,
          description,
        };
        if (sanitizedPerson) {
          data.person = {
            create: {
              firstName: sanitizedPerson.firstName,
              lastName: sanitizedPerson.lastName,
              middleName: sanitizedPerson.middleName ?? null,
              birthDate: sanitizedPerson.birthDate ? new Date(sanitizedPerson.birthDate) : null,
              gender: sanitizedPerson.gender ?? null,
            },
          };
        }
        if (sanitizedOrg) {
          data.organization = {
            create: {
              legalName: sanitizedOrg.legalName,
              taxId: sanitizedOrg.taxId ?? null,
              registrationDate: sanitizedOrg.registrationDate
                ? new Date(sanitizedOrg.registrationDate)
                : null,
            },
          };
        }
        return tx.party.create({ data, include: PartyService.PARTY_INCLUDE });
      }, { timeout: 10_000 });
    } catch (err) {
      PartyService.handleTransactionError(err, "create_party", "create_party", "party");
    }
  }

  /** Map Prisma transaction errors to DomainErrors. Throws the mapped error. */
  private static handleTransactionError(
    err: unknown,
    retryTool: string,
    suggestTool: string,
    entityName = "record",
  ): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        const target = (err.meta?.target as string[] | undefined);
        const field = Array.isArray(target) && target.length > 0 ? (target[0] as string) : "this record";
        throw new DuplicateEntityError(
          `A ${entityName} with the same ${field} already exists in this tenant.`,
          { suggestedTools: [suggestTool], context: { prismaCode: "P2002", conflictingField: field } }
        );
      }
      if (err.code === "P2034") {
        throw new ConcurrencyConflictError(
          `Transaction conflict on ${entityName} — please retry.`,
          { suggestedTools: [retryTool], context: { prismaCode: "P2034" } }
        );
      }
    }
    throw err;
  }

  // ─── Get Party ────────────────────────────────────────────────

  async getParty(tenantId: string, partyId: string): Promise<PartyResult> {
    // Validate tenantId format — defense-in-depth for MCP callers that bypass DTO/Zod
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get", "get_party");

    // Validate partyId format — MCP tools don't go through the REST controller's
    // requireUuid(), so we need defense-in-depth at the service layer.
    this.requireUuid(partyId, "partyId");

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const party = await db.party.findUnique({
      where: { partyId },
      include: PartyService.PARTY_INCLUDE,
    });

    if (!party) {
      throw new EntityNotFoundError(
        `Party '${partyId}' not found.`,
        {
          suggestedTools: ["search_parties", "get_party"],
          context: { partyId },
        }
      );
    }

    return PartyService.toPartyResult(party);
  }

  // ─── Search Parties ───────────────────────────────────────────

  async searchParties(input: SearchPartiesInput): Promise<SearchPartiesResult> {
    const { tenantId, name, partyType, roleType } = input;
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const offset = input.offset ?? MIN_SEARCH_OFFSET;

    // Validate tenantId format — defense-in-depth for MCP callers that bypass DTO/Zod
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "search", "search_parties");

    // Validate pagination parameters
    const validatedLimit = Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT); // Clamp between 1-500
    const validatedOffset = Math.min(Math.max(offset, MIN_SEARCH_OFFSET), MAX_SEARCH_OFFSET);

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    // Build where clause after validation to ensure tenantId is validated first
    const where: Prisma.PartyWhereInput = { tenantId: trimmedTenantId };
    
    const trimmedName = this.requireNonEmptyFilter(name, "name", ["search_parties"]);
    if (trimmedName) {
      // Use contains for flexible partial matching (case-insensitive).
      // Trim whitespace to avoid useless LIKE '%  %' queries.
      // The pg_trgm GIN index (migration 20260619000000) supports these queries.
      where.name = { contains: trimmedName, mode: "insensitive" };
    }

    const trimmedPartyType = this.requireNonEmptyFilter(partyType, "partyType", ["search_parties"]);
    if (trimmedPartyType) {
      where.partyType = { name: { equals: trimmedPartyType, mode: "insensitive" } };
    }

    const trimmedRoleType = this.requireNonEmptyFilter(roleType, "roleType", ["search_parties", "get_type_table_values"]);
    if (trimmedRoleType) {
      where.roles = { some: { roleType: { name: { equals: trimmedRoleType, mode: "insensitive" } } } };
    }

    // NOTE: Under PostgreSQL READ COMMITTED, each statement inside the
    // transaction gets a fresh snapshot, so a concurrent INSERT between
    // count and findMany can cause `total` and `items.length` to disagree.
    // This is acceptable for search pagination — the worst case is an
    // off-by-one in `hasMore`. Using REPEATABLE READ would prevent this
    // but adds contention overhead that isn't justified for a search endpoint.
    const [total, items] = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const count = await tx.party.count({ where });
      const rows = await tx.party.findMany({
        where,
        include: PartyService.PARTY_INCLUDE,
        take: validatedLimit,
        skip: validatedOffset,
        orderBy: { createdAt: "desc" },
      });
      return [count, rows] as const;
    });

    return {
      items: items.map((p) => PartyService.toPartyResult(p)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: validatedOffset + validatedLimit < total,
    };
  }

  // ─── Add Party Role ───────────────────────────────────────────

  async addPartyRole(input: AddPartyRoleInput): Promise<PartyRoleResult> {
    const { tenantId, partyId, roleType, fromDate } = input;

    // Validate tenantId format — defense-in-depth for MCP callers that bypass DTO/Zod
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "add role", "add_party_role");

    this.requireUuid(partyId, "partyId");

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const trimmedRoleType = this.validateAddPartyRoleInput(roleType);
    const roleFromDate = this.parseFromDate(fromDate);

    const roleTypeRecord = await db.roleType.findUnique({ where: { name: trimmedRoleType } });
    if (!roleTypeRecord) {
      throw new InvalidTypeValueError(
        `ROLE_TYPE '${trimmedRoleType}' is not valid. Use 'get_type_table_values' to see valid role types.`,
        { suggestedTools: ["get_type_table_values"], context: { field: "roleType", invalidValue: trimmedRoleType, lookupField: "name" } }
      );
    }

    const role = await this.addPartyRoleTransaction(db, trimmedTenantId, partyId, roleTypeRecord.roleTypeId, trimmedRoleType, roleFromDate);

    this.logger.log(`Added role '${sanitizeForLog(trimmedRoleType)}' to party ${partyId} (ID: ${role.partyRoleId})`);
    return {
      partyRoleId: role.partyRoleId,
      partyId: role.partyId,
      roleTypeName: role.roleType.name,
      fromDate: role.fromDate.toISOString(),
      thruDate: role.thruDate?.toISOString() ?? null,
    };
  }

  private validateAddPartyRoleInput(roleType: string): string {
    const trimmed = roleType.trim();
    if (!trimmed) {
      throw new InvalidTypeValueError("roleType cannot be empty", { suggestedTools: ["get_type_table_values"], context: { field: "roleType", received: roleType } });
    }
    this.requireMaxLength(trimmed, "Role type", MAX_ROLE_TYPE_LENGTH, "get_type_table_values");
    return trimmed;
  }

  private parseFromDate(fromDate: string | undefined | null): Date {
    if (fromDate != null && fromDate.length > MAX_DATE_STRING_LENGTH) {
      throw new InvalidTypeValueError(
        `fromDate is too long (${fromDate.length} characters, max ${MAX_DATE_STRING_LENGTH}).`,
        { suggestedTools: ["add_party_role"], context: { field: "fromDate", length: fromDate.length, maxLength: MAX_DATE_STRING_LENGTH } }
      );
    }
    // When fromDate is absent or whitespace-only, default to "now". Any
    // provided value MUST be valid ISO 8601 — mirroring requireValidDate()
    // (used for birthDate/registrationDate) so both date entry points enforce
    // the same format. Relying on new Date() alone is too permissive: it
    // accepts many non-ISO strings (e.g. "Jan 1 2024", "2024/01/01") that
    // would slip past the error message below, which promises ISO 8601.
    // isValidISODate() already combines the ISO regex with a Date parse
    // check, so a passing value is guaranteed to construct a valid Date.
    const trimmed = fromDate != null ? fromDate.trim() : "";
    if (trimmed.length === 0) {
      return new Date();
    }
    if (!isValidISODate(trimmed)) {
      throw new InvalidTypeValueError(
        `Invalid fromDate format: ${fromDate}. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)`,
        { suggestedTools: ["add_party_role"], context: { field: "fromDate", invalidValue: fromDate ?? "undefined" } }
      );
    }
    return new Date(trimmed);
  }

  private async addPartyRoleTransaction(
    db: PrismaClient,
    tenantId: string, partyId: string, roleTypeId: string,
    trimmedRoleType: string, roleFromDate: Date,
  ): Promise<Prisma.PartyRoleGetPayload<{ include: { roleType: true } }>> {
    try {
      return await db.$transaction(async (tx) => {
        const party = await tx.party.findFirst({ where: { partyId, tenantId } });
        if (!party) {
          throw new EntityNotFoundError(`Party '${partyId}' not found.`, { suggestedTools: ["search_parties", "get_party"], context: { partyId } });
        }

        const existingRole = await tx.partyRole.findFirst({
          where: { partyId, roleTypeId, thruDate: null, party: { tenantId } },
        });
        if (existingRole) {
          throw new DuplicateEntityError(
            `Party '${partyId}' already has active role '${trimmedRoleType}'. Existing role started on ${existingRole.fromDate.toISOString()}. ` +
            `To change a party's role, first end the current role by setting a thruDate, then re-call add_party_role.`,
            { suggestedTools: ["get_party"], context: { partyId, roleType: trimmedRoleType, existingRoleId: existingRole.partyRoleId, existingRoleDate: existingRole.fromDate.toISOString() } }
          );
        }

        return tx.partyRole.create({
          data: { partyId, roleTypeId, fromDate: roleFromDate },
          include: { roleType: true },
        });
      }, { timeout: 10_000 });
    } catch (err) {
      PartyService.handleTransactionError(err, "add_party_role", "get_party", "party role");
    }
  }

  // ─── Add Contact Mechanism ────────────────────────────────────

  async addContactMechanism(input: AddContactMechanismInput): Promise<ContactMechanismResult> {
    const { tenantId, partyId, contactMechanismType, postalAddress, telecomNumber, emailAddress } = input;

    // Validate tenantId format — defense-in-depth for MCP callers that bypass DTO/Zod
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "add contact", "add_contact_mechanism");

    this.requireUuid(partyId, "partyId");

    const db: TenantScopedClient = this.prisma.tenantScoped(trimmedTenantId);

    const trimmedCmType = this.validateContactMechanismType(contactMechanismType);
    const normalizedEmail = this.validateContactMechanismSubtype(trimmedCmType, postalAddress, telecomNumber, emailAddress);

    const cmType = await db.contactMechanismType.findUnique({ where: { name: trimmedCmType } });
    if (!cmType) {
      throw new InvalidTypeValueError(
        `CONTACT_MECHANISM_TYPE '${trimmedCmType}' is not valid. Valid types: ['POSTAL_ADDRESS', 'TELECOM_NUMBER', 'EMAIL_ADDRESS'].`,
        { suggestedTools: ["get_type_table_values"], context: { field: "contactMechanismType", invalidValue: trimmedCmType, validValues: ["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"] } }
      );
    }

    const contactMechanism = await this.createContactMechanismTransaction(db, trimmedTenantId, partyId, trimmedCmType, cmType.contactMechanismTypeId, postalAddress, telecomNumber, normalizedEmail);

    this.logger.log(`Added ${sanitizeForLog(trimmedCmType)} to party ${partyId} (ID: ${contactMechanism.contactMechanismId})`);
    return PartyService.formatContactResult(contactMechanism, partyId);
  }

  private validateContactMechanismType(type: string): string {
    return this.requireStringField(type, "contactMechanismType", MAX_CONTACT_MECHANISM_TYPE_LENGTH, "contact mechanism type", "get_type_table_values");
  }

  private validateContactMechanismSubtype(
    type: string, postalAddress: AddContactMechanismInput["postalAddress"],
    telecomNumber: AddContactMechanismInput["telecomNumber"],
    emailAddress: AddContactMechanismInput["emailAddress"],
  ): string | undefined {
    if (type === "POSTAL_ADDRESS") {
      if (!postalAddress) {
        throw new MissingSubtypeDataError("postalAddress is required when contactMechanismType is POSTAL_ADDRESS.", { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: type, missingField: "postalAddress" } });
      }
      this.requireStringField(postalAddress.addressLine1, "addressLine1", MAX_ADDRESS_LINE_LENGTH, "postal address", "add_contact_mechanism");
      this.requireStringField(postalAddress.city, "city", MAX_CITY_LENGTH, "postal address", "add_contact_mechanism");
      this.requireStringField(postalAddress.country, "country", MAX_COUNTRY_CODE_LENGTH, "postal address", "add_contact_mechanism");
      // Enforce the same minimum as the Zod schema / DTO (ISO 3166-1
      // alpha-2). requireStringField only guards against empty/oversize,
      // so a 1-char value like "U" would otherwise slip past the service
      // layer — the last line of defense for MCP callers that bypass Zod.
      const trimmedCountry = postalAddress.country.trim();
      if (trimmedCountry.length < MIN_COUNTRY_CODE_LENGTH) {
        throw new InvalidTypeValueError(
          `country must be at least ${MIN_COUNTRY_CODE_LENGTH} characters (ISO 3166-1 alpha-2/3). Received: '${trimmedCountry}'.`,
          { suggestedTools: ["add_contact_mechanism"], context: { field: "country", received: trimmedCountry, minLength: MIN_COUNTRY_CODE_LENGTH } }
        );
      }
      if (postalAddress.addressLine2) this.requireMaxLength(postalAddress.addressLine2, "addressLine2", MAX_ADDRESS_LINE_LENGTH, "add_contact_mechanism");
      if (postalAddress.stateProvince) this.requireMaxLength(postalAddress.stateProvince, "stateProvince", MAX_STATE_PROVINCE_LENGTH, "add_contact_mechanism");
      if (postalAddress.postalCode) this.requireMaxLength(postalAddress.postalCode, "postalCode", MAX_POSTAL_CODE_LENGTH, "add_contact_mechanism");
      return undefined;
    } else if (type === "TELECOM_NUMBER") {
      if (!telecomNumber) {
        throw new MissingSubtypeDataError("telecomNumber is required when contactMechanismType is TELECOM_NUMBER.", { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: type, missingField: "telecomNumber" } });
      }
      this.requireStringField(telecomNumber.areaCode, "areaCode", MAX_AREA_CODE_LENGTH, "telecom number", "add_contact_mechanism");
      this.requireStringField(telecomNumber.lineNumber, "lineNumber", MAX_LINE_NUMBER_LENGTH, "telecom number", "add_contact_mechanism");
      if (telecomNumber.countryCode) {
        this.requireMaxLength(telecomNumber.countryCode, "countryCode", MAX_PHONE_COUNTRY_CODE_LENGTH, "add_contact_mechanism");
        if (!COUNTRY_CODE_REGEX.test(telecomNumber.countryCode)) {
          throw new InvalidTypeValueError(`countryCode must be an E.164 country code (e.g., '+1', '+44'). Received: ${telecomNumber.countryCode}.`, { suggestedTools: ["add_contact_mechanism"], context: { field: "countryCode", invalidValue: telecomNumber.countryCode } });
        }
      }
      if (telecomNumber.extension) this.requireMaxLength(telecomNumber.extension, "extension", MAX_EXTENSION_LENGTH, "add_contact_mechanism");
      return undefined;
    } else if (type === "EMAIL_ADDRESS") {
      if (!emailAddress) {
        throw new MissingSubtypeDataError("emailAddress is required when contactMechanismType is EMAIL_ADDRESS.", { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: type, missingField: "emailAddress" } });
      }
      this.requireStringField(emailAddress.email, "email", MAX_EMAIL_LENGTH, "email address", "add_contact_mechanism");
      // Strip HTML tags for consistency with the MCP path and every other
      // field this service sanitizes. The service is the last line of
      // defense for direct/internal callers that bypass the REST DTO's
      // stricter @IsEmail, and EMAIL_REGEX permits '<' and '>', so without
      // this a value like '<script>alert(1)</script>@x.com' would be stored
      // verbatim (stored-XSS surface if ever rendered). stripHtmlTags never
      // changes a valid email — the local part cannot contain '<' or '>' —
      // so legitimate addresses pass through untouched.
      const normalized = stripHtmlTags(emailAddress.email.trim().toLowerCase());
      if (!EMAIL_REGEX.test(normalized)) {
        throw new InvalidTypeValueError(`Invalid email format: ${normalized}`, { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: type, field: "email", invalidValue: normalized } });
      }
      return normalized;
    } else {
      throw new InvalidTypeValueError(
        `CONTACT_MECHANISM_TYPE '${type}' is not valid. Valid types: ['POSTAL_ADDRESS', 'TELECOM_NUMBER', 'EMAIL_ADDRESS'].`,
        { suggestedTools: ["get_type_table_values"], context: { field: "contactMechanismType", invalidValue: type, validValues: ["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"] } }
      );
    }
  }

  private async createContactMechanismTransaction(
    db: PrismaClient,
    tenantId: string, partyId: string, type: string,
    contactMechanismTypeId: string,
    postalAddress: AddContactMechanismInput["postalAddress"],
    telecomNumber: AddContactMechanismInput["telecomNumber"],
    normalizedEmail: string | undefined,
  ): Promise<Prisma.ContactMechanismGetPayload<{
    include: {
      postalAddress: true; telecomNumber: true; emailAddress: true; contactMechanismType: true;
    };
  }>> {
    try {
      return await db.$transaction(async (tx: Prisma.TransactionClient) => {
        const existingParty = await tx.party.findFirst({ where: { partyId, tenantId } });
        if (!existingParty) {
          throw new EntityNotFoundError(`Party '${partyId}' not found.`, { suggestedTools: ["search_parties", "get_party"], context: { partyId } });
        }

        return tx.contactMechanism.create({
          data: {
            contactMechanismTypeId,
            tenantId,
            postalAddress: type === "POSTAL_ADDRESS" && postalAddress ? { create: PartyService.sanitizePostalAddress(postalAddress) } : undefined,
            telecomNumber: type === "TELECOM_NUMBER" && telecomNumber ? { create: PartyService.sanitizeTelecomNumber(telecomNumber) } : undefined,
            emailAddress: type === "EMAIL_ADDRESS" && normalizedEmail ? { create: { email: normalizedEmail } } : undefined,
            partyContacts: { create: { partyId } },
          },
          include: { postalAddress: true, telecomNumber: true, emailAddress: true, contactMechanismType: true },
        });
      }, { timeout: 10_000 });
    } catch (err) {
      PartyService.handleTransactionError(err, "add_contact_mechanism", "add_contact_mechanism", "contact mechanism");
    }
  }

  private static sanitizePostalAddress(addr: NonNullable<AddContactMechanismInput["postalAddress"]>) {
    const addressLine2 = addr.addressLine2?.trim();
    const stateProvince = addr.stateProvince?.trim();
    const postalCode = addr.postalCode?.trim();
    return {
      addressLine1: stripHtmlTags(addr.addressLine1.trim()),
      addressLine2: addressLine2 ? stripHtmlTags(addressLine2) : null,
      city: stripHtmlTags(addr.city.trim()),
      stateProvince: stateProvince ? stripHtmlTags(stateProvince) : null,
      postalCode: postalCode ? stripHtmlTags(postalCode) : null,
      country: stripHtmlTags(addr.country.trim().toUpperCase()),
    };
  }

  private static sanitizeTelecomNumber(tel: NonNullable<AddContactMechanismInput["telecomNumber"]>) {
    const countryCode = tel.countryCode?.trim();
    const extension = tel.extension?.trim();
    return {
      countryCode: countryCode ? stripHtmlTags(countryCode) : "+1",
      areaCode: stripHtmlTags(tel.areaCode.trim()),
      lineNumber: stripHtmlTags(tel.lineNumber.trim()),
      extension: extension ? stripHtmlTags(extension) : null,
    };
  }

  private static formatContactResult(cm: Prisma.ContactMechanismGetPayload<{
    include: {
      postalAddress: true; telecomNumber: true; emailAddress: true; contactMechanismType: true;
    };
  }>, partyId: string): ContactMechanismResult {
    return {
      contactMechanismId: cm.contactMechanismId,
      contactMechanismType: cm.contactMechanismType.name,
      partyId,
      postalAddress: cm.postalAddress ? {
        addressLine1: cm.postalAddress.addressLine1,
        addressLine2: cm.postalAddress.addressLine2 ?? undefined,
        city: cm.postalAddress.city,
        stateProvince: cm.postalAddress.stateProvince ?? undefined,
        postalCode: cm.postalAddress.postalCode ?? undefined,
        country: cm.postalAddress.country,
      } : null,
      telecomNumber: cm.telecomNumber ? {
        countryCode: cm.telecomNumber.countryCode ?? undefined,
        areaCode: cm.telecomNumber.areaCode,
        lineNumber: cm.telecomNumber.lineNumber,
        extension: cm.telecomNumber.extension ?? undefined,
      } : null,
      emailAddress: cm.emailAddress ? { email: cm.emailAddress.email } : null,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /** Validate and trim an optional search filter. Returns trimmed value or undefined.
   *  Rejects whitespace-only input — a caller who types "   " probably meant
   *  a real filter, and silently widening the query to "return all" is a footgun. */
  private requireNonEmptyFilter(
    value: string | undefined,
    fieldName: string,
    suggestedTools: string[],
  ): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(
        `${fieldName} filter cannot be whitespace-only.`,
        { suggestedTools, context: { field: fieldName } }
      );
    }
    return trimmed;
  }

  /** Validate a required string field: must be non-empty and within maxLength.
   *  Trims before both checks for defense-in-depth. */
  private requireStringField(
    value: string | undefined | null,
    field: string,
    maxLength: number,
    parentType: string,
    tool = "create_party",
  ): string {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(
        `${field} is required for ${parentType}`,
        { suggestedTools: [tool], context: { parentType, field } }
      );
    }
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(
        `${field} is too long (${trimmed.length} characters, max ${maxLength})`,
        { suggestedTools: [tool], context: { field, length: trimmed.length, maxLength } }
      );
    }
    return trimmed;
  }

  /** Validate that a string does not exceed maxLength.
   *  Used for optional fields where the emptiness check is not needed.
   *  Callers are expected to pass already-trimmed values. */
  private requireMaxLength(
    value: string,
    field: string,
    maxLength: number,
    tool = "create_party",
  ): void {
    if (value.length > maxLength) {
      throw new InvalidTypeValueError(
        `${field} is too long (${value.length} characters, max ${maxLength})`,
        { suggestedTools: [tool], context: { field, length: value.length, maxLength } }
      );
    }
  }

  /** Validate that a value looks like a UUID. Gives a clear error instead of
   *  an opaque Prisma P2023 error for malformed IDs from MCP tool callers. */
  private requireUuid(value: string, field: string): void {
    if (!UUID_REGEX.test(value)) {
      throw new InvalidTypeValueError(
        `Invalid '${field}': must be a valid UUID.`,
        { suggestedTools: ["search_parties", "get_party"], context: { field, received: value } }
      );
    }
  }

  /** Validate that a date string parses to a real Date.
   *  Defense-in-depth — the DTO path validates with @IsDateString and
   *  the Zod path validates with .date() / .iso(), but the service is
   *  the last line of defense and is called from contexts (MCP, future
   *  internal callers) that may skip the boundary validation.
   *
   *  Also enforces a 30-char max length (matching the Zod schema's
   *  .max(30) on birthDate/registrationDate) so an oversized
   *  string that bypasses Zod still gets caught here. */
  private requireValidDate(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidTypeValueError(
        `${field} must be a non-empty ISO 8601 date string.`,
        { suggestedTools: ["create_party"], context: { field, received: value } }
      );
    }
    // Defense-in-depth: cap the raw input length so that an absurdly long
    // value (e.g., multi-KB string) is rejected before reaching new Date().
    // The Zod schemas limit birthDate/registrationDate to MAX_DATE_STRING_LENGTH;
    // mirror that here for any call path that bypasses Zod (e.g., REST).
    if (value.length > MAX_DATE_STRING_LENGTH) {
      throw new InvalidTypeValueError(
        `${field} is too long (${value.length} characters, max ${MAX_DATE_STRING_LENGTH}).`,
        { suggestedTools: ["create_party"], context: { field, length: value.length, maxLength: MAX_DATE_STRING_LENGTH } }
      );
    }
    // Validate the TRIMMED value so a date with surrounding whitespace
    // (e.g. " 2024-01-01 ") is accepted — consistent with parseFromDate()
    // and the MCP Zod schemas, which trim via .transform() before any
    // format check. The raw `value` is reported in the error below so the
    // caller sees exactly what they sent.
    const trimmed = value.trim();
    if (!isValidISODate(trimmed)) {
      throw new InvalidTypeValueError(
        `${field} is not a valid ISO 8601 date. Received: ${value}.`,
        { suggestedTools: ["create_party"], context: { field, invalidValue: value } }
      );
    }
  }

  private static toPartyResult(party: PartyWithIncludes): PartyResult {
    return {
      partyId: party.partyId,
      name: party.name,
      partyType: party.partyType?.name ?? "UNKNOWN",
      description: party.description ?? null,
      person: party.person
        ? {
            firstName: party.person.firstName,
            lastName: party.person.lastName,
            middleName: party.person.middleName,
            birthDate: party.person.birthDate?.toISOString() ?? null,
            gender: party.person.gender,
          }
        : null,
      organization: party.organization
        ? {
            legalName: party.organization.legalName,
            taxId: party.organization.taxId,
            registrationDate: party.organization.registrationDate?.toISOString() ?? null,
          }
        : null,
      roles: (party.roles ?? []).map((r) => ({
        partyRoleId: r.partyRoleId,
        roleTypeName: r.roleType?.name ?? "UNKNOWN",
        fromDate: r.fromDate.toISOString(),
        thruDate: r.thruDate?.toISOString() ?? null,
      })),
      createdAt: party.createdAt.toISOString(),
      updatedAt: party.updatedAt.toISOString(),
    };
  }
}
