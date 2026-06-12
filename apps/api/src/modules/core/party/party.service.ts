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
// This service is a create-and-relation path — it does not perform
// general-purpose updates. Duplicate-role prevention is enforced by the
// `party_active_role_unique` DB constraint (and caught as P2002 if the
// application-level check is ever removed).

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service.js";
import { Prisma } from "@prisma/client";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  UUID_REGEX,
  EMAIL_REGEX,
  COUNTRY_CODE_REGEX,
  stripHtmlTags,
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
  DEFAULT_SEARCH_LIMIT,
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
  } as const;

  // ─── Create Party ─────────────────────────────────────────────

  async createParty(input: CreatePartyInput): Promise<PartyResult> {
    const { tenantId, partyType, name, description, person: personData, organization: orgData } = input;

    // Input validation with better error messages
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new InvalidTypeValueError(
        "Party name cannot be empty",
        { 
          suggestedTools: ["create_party"],
          context: { field: "name", received: name }
        }
      );
    }
    this.requireMaxLength(name, "Party name", MAX_PARTY_NAME_LENGTH);
    // Validate description length (MCP tool path has no DTO validation)
    const trimmedDescription = description?.trim() || null;
    if (trimmedDescription) {
      this.requireMaxLength(trimmedDescription, "Description", MAX_PARTY_DESCRIPTION_LENGTH);
    }

    // Validate subtype data
    if (partyType === "PERSON" && !personData) {
      throw new MissingSubtypeDataError(
        "When partyType is PERSON, the 'person' object with firstName and lastName is required.",
        { suggestedTools: ["create_party"], context: { partyType, missingField: "person" } }
      );
    }
    if (partyType === "ORGANIZATION" && !orgData) {
      throw new MissingSubtypeDataError(
        "When partyType is ORGANIZATION, the 'organization' object with legalName is required.",
        { suggestedTools: ["create_party"], context: { partyType, missingField: "organization" } }
      );
    }
    // Enforce subtype exclusivity — only the matching subtype data should be provided.
    // The REST path enforces this via PartySubtypeExclusiveConstraint in the DTO,
    // but MCP tools call the service directly without DTO validation.
    if (partyType === "PERSON" && orgData) {
      throw new InvalidTypeValueError(
        "When partyType is PERSON, 'organization' data must not be provided. Only 'person' data is expected.",
        { suggestedTools: ["create_party"], context: { partyType, unexpectedField: "organization" } }
      );
    }
    if (partyType === "ORGANIZATION" && personData) {
      throw new InvalidTypeValueError(
        "When partyType is ORGANIZATION, 'person' data must not be provided. Only 'organization' data is expected.",
        { suggestedTools: ["create_party"], context: { partyType, unexpectedField: "person" } }
      );
    }
    
    // Validate person data if provided
    if (personData) {
      if (!personData.firstName || personData.firstName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "firstName is required for person data",
          { suggestedTools: ["create_party"], context: { field: "firstName" } }
        );
      }
      this.requireMaxLength(personData.firstName, "First name", MAX_PERSON_NAME_LENGTH);
      if (!personData.lastName || personData.lastName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "lastName is required for person data",
          { suggestedTools: ["create_party"], context: { field: "lastName" } }
        );
      }
      this.requireMaxLength(personData.lastName, "Last name", MAX_PERSON_NAME_LENGTH);
      if (personData.gender !== undefined && personData.gender !== null) {
        this.requireMaxLength(personData.gender, "Gender", MAX_GENDER_LENGTH);
      }
      if (personData.middleName !== undefined && personData.middleName !== null) {
        this.requireMaxLength(personData.middleName, "Middle name", MAX_MIDDLE_NAME_LENGTH);
      }
      // Defense-in-depth: validate birthDate shape before passing to Prisma.
      // The REST DTO uses @IsDateString (strict ISO 8601) but the MCP Zod
      // schema only enforces a 30-char max length. A typo like "2024-13-40"
      // would otherwise reach `new Date(...)` and produce Invalid Date,
      // which Prisma rejects with an opaque P2009 / serialization error
      // that the MCP layer can't translate into a structured response.
      if (personData.birthDate !== undefined && personData.birthDate !== null) {
        this.requireValidDate(personData.birthDate, "birthDate");
      }
    }

    // Validate organization data if provided
    if (orgData) {
      if (!orgData.legalName || orgData.legalName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "legalName is required for organization data",
          { suggestedTools: ["create_party"], context: { field: "legalName" } }
        );
      }
      this.requireMaxLength(orgData.legalName, "Legal name", MAX_LEGAL_NAME_LENGTH);
      // See personData.birthDate comment — same defense-in-depth rationale.
      if (orgData.registrationDate !== undefined && orgData.registrationDate !== null) {
        this.requireValidDate(orgData.registrationDate, "registrationDate");
      }
    }

    // Trim and sanitize all name fields before storage to prevent whitespace-padded
    // and HTML-injected names. DTOs handle this for the REST path via @Transform,
    // but the MCP tool path calls the service directly without DTO normalization.
    const trimmedPerson = personData ? {
      ...personData,
      firstName: stripHtmlTags(personData.firstName.trim()),
      lastName: stripHtmlTags(personData.lastName.trim()),
      middleName: personData.middleName?.trim() ? stripHtmlTags(personData.middleName.trim()) : undefined,
      gender: personData.gender ? stripHtmlTags(personData.gender.trim()) : undefined,
    } : undefined;
    const trimmedOrg = orgData ? {
      ...orgData,
      legalName: stripHtmlTags(orgData.legalName.trim()),
      taxId: orgData.taxId
        ? (() => {
            const trimmed = orgData.taxId.trim();
            this.requireMaxLength(trimmed, "Tax ID", MAX_TAX_ID_LENGTH, "create_party");
            return stripHtmlTags(trimmed);
          })()
        : undefined,
    } : undefined;

    // Get RLS-scoped client for tenant isolation
    const db = this.prisma.tenantScoped(tenantId);

    // NOTE: Type table lookups are done OUTSIDE the main transaction.
    // This is safe because type tables (PARTY_TYPE, ROLE_TYPE, etc.) are
    // system-managed, seeded at deploy time, and never deleted by app code.
    // Moving them inside would add transaction overhead with no benefit.
    // Look up party type ID from the type table
    const partyTypeRecord = await db.partyType.findUnique({
      where: { name: partyType },
    });
    if (!partyTypeRecord) {
      throw new InvalidTypeValueError(
        `PARTY_TYPE '${partyType}' is not valid. Valid types: ['PERSON', 'ORGANIZATION'].`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "partyType", invalidValue: partyType, validValues: ["PERSON", "ORGANIZATION"] },
        }
      );
    }

    // Sanitize text fields — strip HTML tags to prevent stored XSS.
    // Defense-in-depth: the API layer should also escape on render, but
    // sanitizing at storage time prevents malicious content from persisting.
    const sanitizedName = stripHtmlTags(trimmedName);
    const sanitizedDescription = trimmedDescription ? stripHtmlTags(trimmedDescription) : null;

    // Create party with supertype/subtype in a transaction
    const party = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const data: Prisma.PartyCreateInput = {
        partyType: { connect: { partyTypeId: partyTypeRecord.partyTypeId } },
        tenantId,
        name: sanitizedName,
        description: sanitizedDescription,
      };
      if (trimmedPerson) {
        data.person = {
          create: {
            firstName: trimmedPerson.firstName,
            lastName: trimmedPerson.lastName,
            middleName: trimmedPerson.middleName || null,
            birthDate: trimmedPerson.birthDate ? PartyService.safeParseDate(trimmedPerson.birthDate) : null,
            gender: trimmedPerson.gender || null,
          },
        };
      }
      if (trimmedOrg) {
        data.organization = {
          create: {
            legalName: trimmedOrg.legalName,
            taxId: trimmedOrg.taxId || null,
            registrationDate: trimmedOrg.registrationDate
              ? PartyService.safeParseDate(trimmedOrg.registrationDate)
              : null,
          },
        };
      }
      return tx.party.create({
        data,
        include: PartyService.PARTY_INCLUDE,
      });
    });

    this.logger.log(`Created ${partyType} party: ${trimmedName} (${party.partyId})`);
    return PartyService.toPartyResult(party);
  }

  // ─── Get Party ────────────────────────────────────────────────

  async getParty(tenantId: string, partyId: string): Promise<PartyResult> {
    // Validate partyId format — MCP tools don't go through the REST controller's
    // requireUuid(), so we need defense-in-depth at the service layer.
    this.requireUuid(partyId, "partyId");

    const db = this.prisma.tenantScoped(tenantId);

    const party = await db.party.findFirst({
      where: { partyId, tenantId },
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
    const { tenantId, name, partyType, roleType, limit = DEFAULT_SEARCH_LIMIT, offset = MIN_SEARCH_OFFSET } = input;

    // Validate pagination parameters
    const validatedLimit = Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT); // Clamp between 1-500
    const validatedOffset = Math.max(offset, MIN_SEARCH_OFFSET);

    const db = this.prisma.tenantScoped(tenantId);

    // Build where clause more efficiently
    const where: Prisma.PartyWhereInput = { tenantId };
    
    if (name) {
      // Use contains for flexible partial matching (case-insensitive).
      // Trim whitespace to avoid useless LIKE '%  %' queries.
      //
      // TODO: For production, add a pg_trgm GIN index on party.name
      // to avoid sequential scans on large tables:
      //   CREATE EXTENSION IF NOT EXISTS pg_trgm;
      //   CREATE INDEX CONCURRENTLY party_name_trgm_idx ON party USING gin (name gin_trgm_ops);
      const trimmedName = name.trim();
      if (trimmedName.length > 0) {
        where.name = { contains: trimmedName, mode: "insensitive" };
      } else {
        // Whitespace-only name: silently widening the query to "return all
        // parties" is a footgun — a caller who types "   " probably meant
        // a real filter, and the response size can be surprising. Reject
        // explicitly so the caller gets a clear error.
        throw new InvalidTypeValueError(
          "name filter cannot be whitespace-only.",
          { suggestedTools: ["search_parties"], context: { field: "name" } }
        );
      }
    }
    
    if (partyType) {
      where.partyType = { name: partyType };
    }
    
    if (roleType) {
      const trimmedRoleType = roleType.trim();
      if (trimmedRoleType.length > 0) {
        where.roles = { some: { roleType: { name: { equals: trimmedRoleType, mode: "insensitive" } } } };
      } else {
        // See `name` filter above for rationale.
        throw new InvalidTypeValueError(
          "roleType filter cannot be whitespace-only.",
          { suggestedTools: ["search_parties", "get_type_table_values"], context: { field: "roleType" } }
        );
      }
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

    // Validate partyId format — MCP tools don't go through the REST controller's
    // requireUuid(), so we need defense-in-depth at the service layer.
    this.requireUuid(partyId, "partyId");

    const db = this.prisma.tenantScoped(tenantId);

    // NOTE: Type table lookup outside transaction — safe because role types
    // are system-managed immutable data (see createParty for rationale).

    // ─── Pure input validation (fail fast, before any DB access) ─────
    if (!roleType || roleType.trim().length === 0) {
      throw new InvalidTypeValueError(
        "roleType cannot be empty",
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "roleType", received: roleType },
        }
      );
    }
    this.requireMaxLength(roleType, "Role type", MAX_ROLE_TYPE_LENGTH, "get_type_table_values");
    const trimmedRoleType = roleType.trim();

    // Validate and parse fromDate BEFORE any DB access (pure computation)
    const roleFromDate = fromDate != null && fromDate.trim().length > 0 ? new Date(fromDate) : new Date();
    if (isNaN(roleFromDate.getTime())) {
      throw new InvalidTypeValueError(
        `Invalid fromDate format: ${fromDate}. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)`,
        {
          suggestedTools: ["add_party_role"],
          context: { field: "fromDate", invalidValue: fromDate },
        }
      );
    }

    // ─── Database lookups (after pure validation passes) ─────────────
    // Look up role type (static shared data, safe outside transaction)
    const roleTypeRecord = await db.roleType.findUnique({
      where: { name: trimmedRoleType },
    });
    if (!roleTypeRecord) {
      throw new InvalidTypeValueError(
        `ROLE_TYPE '${trimmedRoleType}' is not valid. Use 'get_type_table_values' to see valid role types.`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "roleType", invalidValue: trimmedRoleType, lookupField: "name" },
        }
      );
    }

    // Atomic check + create in a single transaction to prevent TOCTOU race.
    // Two concurrent requests with the same partyId/roleType must not both
    // pass the duplicate check and both insert.
    const role = await db.$transaction(async (tx) => {
      // Verify party exists (inside tx for atomicity)
      const party = await tx.party.findFirst({
        where: { partyId, tenantId },
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

      // Check for existing active role (inside tx to prevent TOCTOU race).
      // Explicit tenantId filter is defense-in-depth alongside RLS.
      const existingRole = await tx.partyRole.findFirst({
        where: {
          partyId,
          roleTypeId: roleTypeRecord.roleTypeId,
          thruDate: null,
          party: { tenantId },
        },
      });
      if (existingRole) {
        throw new DuplicateEntityError(
          `Party '${partyId}' already has active role '${trimmedRoleType}'. ` +
          `Existing role started on ${existingRole.fromDate.toISOString()}. ` +
          `To change a party's role, first end the current role by setting a thruDate, ` +
          `then re-call add_party_role.`,
          {
            suggestedTools: ["get_party"],
            context: {
              partyId,
              roleType: trimmedRoleType,
              existingRoleId: existingRole.partyRoleId,
              existingRoleDate: existingRole.fromDate.toISOString(),
            },
          }
        );
      }

      return tx.partyRole.create({
        data: {
          partyId,
          roleTypeId: roleTypeRecord.roleTypeId,
          fromDate: roleFromDate,
        },
        include: { roleType: true },
      });
    }).catch((err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new DuplicateEntityError(
          `Party '${partyId}' already has active role '${trimmedRoleType}' (unique constraint violation). ` +
          `To change a party's role, first end the current role by setting a thruDate, ` +
          `then re-call add_party_role.`,
          {
            suggestedTools: ["get_party"],
            context: {
              partyId,
              roleType: trimmedRoleType,
            },
          }
        );
      }
      throw err;
    });

    this.logger.log(`Added role '${trimmedRoleType}' to party ${partyId} (ID: ${role.partyRoleId})`);
    return {
      partyRoleId: role.partyRoleId,
      partyId: role.partyId,
      roleTypeName: role.roleType.name,
      fromDate: role.fromDate.toISOString(),
      thruDate: role.thruDate?.toISOString() ?? null,
    };
  }

  // ─── Add Contact Mechanism ────────────────────────────────────

  async addContactMechanism(input: AddContactMechanismInput): Promise<ContactMechanismResult> {
    const {
      tenantId,
      partyId,
      contactMechanismType,
      postalAddress,
      telecomNumber,
      emailAddress,
    } = input;

    // Validate partyId format — MCP tools don't go through the REST controller's
    // requireUuid(), so we need defense-in-depth at the service layer.
    this.requireUuid(partyId, "partyId");

    const db = this.prisma.tenantScoped(tenantId);

    // ─── Pure input validation (fail fast, before any DB access) ─────
    let normalizedEmail: string | undefined;
    if (!contactMechanismType || contactMechanismType.trim().length === 0) {
      throw new InvalidTypeValueError(
        "contactMechanismType cannot be empty",
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "contactMechanismType", received: contactMechanismType },
        }
      );
    }
    this.requireMaxLength(contactMechanismType, "Contact mechanism type", MAX_CONTACT_MECHANISM_TYPE_LENGTH, "get_type_table_values");
    const trimmedCmType = contactMechanismType.trim();

    // Validate subtype data early — avoids wasting a DB round-trip on invalid input.
    if (trimmedCmType === "POSTAL_ADDRESS") {
      if (!postalAddress) {
        throw new MissingSubtypeDataError(
          "postalAddress is required when contactMechanismType is POSTAL_ADDRESS.",
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, missingField: "postalAddress" } }
        );
      }
      this.requireNonEmpty(postalAddress.addressLine1, "addressLine1", "postal address");
      this.requireMaxLength(postalAddress.addressLine1, "addressLine1", MAX_ADDRESS_LINE_LENGTH, "add_contact_mechanism");
      this.requireNonEmpty(postalAddress.city, "city", "postal address");
      this.requireMaxLength(postalAddress.city, "city", MAX_CITY_LENGTH, "add_contact_mechanism");
      this.requireNonEmpty(postalAddress.country, "country", "postal address");
      this.requireMaxLength(postalAddress.country, "country", MAX_COUNTRY_CODE_LENGTH, "add_contact_mechanism");
      if (postalAddress.addressLine2) this.requireMaxLength(postalAddress.addressLine2, "addressLine2", MAX_ADDRESS_LINE_LENGTH, "add_contact_mechanism");
      if (postalAddress.stateProvince) this.requireMaxLength(postalAddress.stateProvince, "stateProvince", MAX_STATE_PROVINCE_LENGTH, "add_contact_mechanism");
      if (postalAddress.postalCode) this.requireMaxLength(postalAddress.postalCode, "postalCode", MAX_POSTAL_CODE_LENGTH, "add_contact_mechanism");
    } else if (trimmedCmType === "TELECOM_NUMBER") {
      if (!telecomNumber) {
        throw new MissingSubtypeDataError(
          "telecomNumber is required when contactMechanismType is TELECOM_NUMBER.",
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, missingField: "telecomNumber" } }
        );
      }
      this.requireNonEmpty(telecomNumber.areaCode, "areaCode", "telecom number");
      this.requireMaxLength(telecomNumber.areaCode, "areaCode", MAX_AREA_CODE_LENGTH, "add_contact_mechanism");
      this.requireNonEmpty(telecomNumber.lineNumber, "lineNumber", "telecom number");
      this.requireMaxLength(telecomNumber.lineNumber, "lineNumber", MAX_LINE_NUMBER_LENGTH, "add_contact_mechanism");
      if (telecomNumber.countryCode) {
        this.requireMaxLength(telecomNumber.countryCode, "countryCode", MAX_PHONE_COUNTRY_CODE_LENGTH, "add_contact_mechanism");
        // Length check alone accepts arbitrary strings (e.g. "abc" or
        // "++++") up to 5 chars. Validate the E.164 shape explicitly so
        // a malformed value produces a clear error rather than being
        // stored verbatim and breaking downstream phone-number parsing.
        if (!COUNTRY_CODE_REGEX.test(telecomNumber.countryCode)) {
          throw new InvalidTypeValueError(
            `countryCode must be an E.164 country code (e.g., '+1', '+44'). Received: ${telecomNumber.countryCode}.`,
            { suggestedTools: ["add_contact_mechanism"], context: { field: "countryCode", invalidValue: telecomNumber.countryCode } }
          );
        }
      }
      if (telecomNumber.extension) this.requireMaxLength(telecomNumber.extension, "extension", MAX_EXTENSION_LENGTH, "add_contact_mechanism");
    } else if (trimmedCmType === "EMAIL_ADDRESS") {
      if (!emailAddress) {
        throw new MissingSubtypeDataError(
          "emailAddress is required when contactMechanismType is EMAIL_ADDRESS.",
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, missingField: "emailAddress" } }
        );
      }
      this.requireNonEmpty(emailAddress.email, "email", "email address");
      this.requireMaxLength(emailAddress.email, "email", MAX_EMAIL_LENGTH, "add_contact_mechanism");
      normalizedEmail = emailAddress.email.trim().toLowerCase();
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        throw new InvalidTypeValueError(
          `Invalid email format: ${normalizedEmail}`,
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, field: "email", invalidValue: normalizedEmail } }
        );
      }
    } else {
      // Unknown type — fail fast before any DB round-trip
      throw new InvalidTypeValueError(
        `CONTACT_MECHANISM_TYPE '${trimmedCmType}' is not valid. ` +
        `Valid types: ['POSTAL_ADDRESS', 'TELECOM_NUMBER', 'EMAIL_ADDRESS'].`,
        {
          suggestedTools: ["get_type_table_values"],
          context: {
            field: "contactMechanismType",
            invalidValue: trimmedCmType,
            validValues: ["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"]
          },
        }
      );
    }

    // ─── Database lookups (after pure validation passes) ─────────────
    // NOTE: Type table lookup outside transaction — safe because contact
    // mechanism types are system-managed immutable data (see createParty).
    // For known types (POSTAL_ADDRESS, TELECOM_NUMBER, EMAIL_ADDRESS), the
    // early validation above already confirmed the type is valid. The DB
    // lookup here is defense-in-depth to catch stale seed data.

    // Look up contact mechanism type
    const cmType = await db.contactMechanismType.findUnique({
      where: { name: trimmedCmType },
    });
    if (!cmType) {
      throw new InvalidTypeValueError(
        `CONTACT_MECHANISM_TYPE '${trimmedCmType}' exists as a known type but was not found in the database. ` +
        `This may indicate the database has not been seeded. Run 'npm run db:seed'.`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { 
            field: "contactMechanismType", 
            invalidValue: trimmedCmType,
            validValues: ["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"],
            hint: "Database may need seeding"
          },
        }
      );
    }

    // ─── Transaction: party existence check + contact creation ────────

    // Create contact mechanism with subtype in a transaction.
    // Party existence check is INSIDE the transaction to prevent the TOCTOU
    // race where the party could be deleted between the check and the create.
    const contactMechanism = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // Verify party exists in tenant (inside tx for atomicity)
      const existingParty = await tx.party.findFirst({
        where: { partyId, tenantId },
      });
      if (!existingParty) {
        throw new EntityNotFoundError(
          `Party '${partyId}' not found.`,
          {
            suggestedTools: ["search_parties", "get_party"],
            context: { partyId },
          }
        );
      }

      const postalAddressCreate = trimmedCmType === "POSTAL_ADDRESS" && postalAddress
        ? {
            create: {
              addressLine1: stripHtmlTags(postalAddress.addressLine1.trim()),
              addressLine2: postalAddress.addressLine2?.trim() ? stripHtmlTags(postalAddress.addressLine2.trim()) : null,
              city: stripHtmlTags(postalAddress.city.trim()),
              stateProvince: postalAddress.stateProvince?.trim() ? stripHtmlTags(postalAddress.stateProvince.trim()) : null,
              postalCode: postalAddress.postalCode?.trim() ? stripHtmlTags(postalAddress.postalCode.trim()) : null,
              country: stripHtmlTags(postalAddress.country.trim().toUpperCase()),
            },
          }
        : undefined;
      const telecomNumberCreate = trimmedCmType === "TELECOM_NUMBER" && telecomNumber
        ? {
            create: {
              countryCode: telecomNumber.countryCode?.trim() ? stripHtmlTags(telecomNumber.countryCode.trim()) : "+1",
              areaCode: stripHtmlTags(telecomNumber.areaCode.trim()),
              lineNumber: stripHtmlTags(telecomNumber.lineNumber.trim()),
              extension: telecomNumber.extension?.trim() ? stripHtmlTags(telecomNumber.extension.trim()) : null,
            },
          }
        : undefined;
      const emailAddressCreate = trimmedCmType === "EMAIL_ADDRESS" && normalizedEmail
        ? {
            create: {
              email: normalizedEmail,
            },
          }
        : undefined;

      return tx.contactMechanism.create({
        data: {
          contactMechanismTypeId: cmType.contactMechanismTypeId,
          tenantId,
          postalAddress: postalAddressCreate,
          telecomNumber: telecomNumberCreate,
          emailAddress: emailAddressCreate,
          partyContacts: {
            create: { partyId },
          },
        },
        include: {
          postalAddress: true,
          telecomNumber: true,
          emailAddress: true,
          contactMechanismType: true,
        },
      });
    });

    this.logger.log(`Added ${trimmedCmType} to party ${partyId} (ID: ${contactMechanism.contactMechanismId})`);

    // Format return data consistently
    return {
      contactMechanismId: contactMechanism.contactMechanismId,
      contactMechanismType: contactMechanism.contactMechanismType.name,
      partyId,
      postalAddress: contactMechanism.postalAddress
        ? {
            addressLine1: contactMechanism.postalAddress.addressLine1,
            addressLine2: contactMechanism.postalAddress.addressLine2 ?? undefined,
            city: contactMechanism.postalAddress.city,
            stateProvince: contactMechanism.postalAddress.stateProvince ?? undefined,
            postalCode: contactMechanism.postalAddress.postalCode ?? undefined,
            country: contactMechanism.postalAddress.country,
          }
        : null,
      telecomNumber: contactMechanism.telecomNumber
        ? {
            countryCode: contactMechanism.telecomNumber.countryCode ?? undefined,
            areaCode: contactMechanism.telecomNumber.areaCode,
            lineNumber: contactMechanism.telecomNumber.lineNumber,
            extension: contactMechanism.telecomNumber.extension ?? undefined,
          }
        : null,
      emailAddress: contactMechanism.emailAddress
        ? { email: contactMechanism.emailAddress.email }
        : null,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /** Validate a non-empty required string field, throwing MissingSubtypeDataError. */
  private requireNonEmpty(
    value: string | undefined | null,
    field: string,
    parentType: string,
    tool = "add_contact_mechanism",
  ): void {
    if (!value || value.trim().length === 0) {
      throw new MissingSubtypeDataError(
        `${field} is required for ${parentType}`,
        { suggestedTools: [tool], context: { parentType, field } }
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

  /** Validate that a string does not exceed maxLength after trimming.
   *  Trimming is done internally so callers don't need to pre-trim. */
  private requireMaxLength(
    value: string,
    field: string,
    maxLength: number,
    tool = "create_party",
  ): void {
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(
        `${field} is too long (${trimmed.length} characters, max ${maxLength})`,
        { suggestedTools: [tool], context: { field, length: trimmed.length, maxLength } }
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
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) {
      throw new InvalidTypeValueError(
        `${field} is not a valid ISO 8601 date. Received: ${value}.`,
        { suggestedTools: ["create_party"], context: { field, invalidValue: value } }
      );
    }
  }

  /**
   * Parse a date string to a Date object. Throws if the value is not valid.
   * Callers MUST validate the format first via requireValidDate() before
   * calling this — it is a last-line defense, not a soft fallback.
   */
  private static safeParseDate(value: string): Date {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new InvalidTypeValueError(
        `Invalid date value: ${value}`,
        { suggestedTools: ["create_party"], context: { field: "date", invalidValue: value } }
      );
    }
    return d;
  }

  private static toPartyResult(party: PartyWithIncludes): PartyResult {
    return {
      partyId: party.partyId,
      name: party.name,
      partyType: party.partyType?.name ?? "UNKNOWN",
      description: party.description,
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
