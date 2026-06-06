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
// OPTIMISTIC CONCURRENCY: Updates check the `version` field to prevent
// lost updates when multiple agents modify the same entity concurrently.

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service.js";
import { Prisma } from "@prisma/client";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  UUID_REGEX,
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
  PostalAddressInput,
  TelecomNumberInput,
  EmailAddressInput,
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
    this.requireMaxLength(trimmedName, "Party name", 500);
    // Validate description length (MCP tool path has no DTO validation)
    const trimmedDescription = description?.trim() || null;
    if (trimmedDescription && trimmedDescription.length > 1000) {
      throw new InvalidTypeValueError(
        `Description is too long (${trimmedDescription.length} characters, max 1000)`,
        { suggestedTools: ["create_party"], context: { field: "description", length: trimmedDescription.length, maxLength: 1000 } }
      );
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
    
    // Validate person data if provided
    if (personData) {
      if (!personData.firstName || personData.firstName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "firstName is required for person data",
          { suggestedTools: ["create_party"], context: { field: "firstName" } }
        );
      }
      this.requireMaxLength(personData.firstName, "First name", 200);
      if (!personData.lastName || personData.lastName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "lastName is required for person data",
          { suggestedTools: ["create_party"], context: { field: "lastName" } }
        );
      }
      this.requireMaxLength(personData.lastName, "Last name", 200);
    }
    
    // Validate organization data if provided
    if (orgData) {
      if (!orgData.legalName || orgData.legalName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "legalName is required for organization data",
          { suggestedTools: ["create_party"], context: { field: "legalName" } }
        );
      }
      this.requireMaxLength(orgData.legalName, "Legal name", 500);
    }

    // Trim all name fields before storage to prevent whitespace-padded names.
    // DTOs handle this for the REST path via @Transform, but the MCP tool path
    // calls the service directly without DTO normalization.
    const trimmedPerson = personData ? {
      ...personData,
      firstName: personData.firstName.trim(),
      lastName: personData.lastName.trim(),
      middleName: personData.middleName?.trim() || undefined,
    } : undefined;
    const trimmedOrg = orgData ? {
      ...orgData,
      legalName: orgData.legalName.trim(),
      taxId: orgData.taxId?.trim() || undefined,
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

    // Create party with supertype/subtype in a transaction
    const party = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const data: Prisma.PartyCreateInput = {
        partyType: { connect: { partyTypeId: partyTypeRecord.partyTypeId } },
        tenantId,
        name: trimmedName,
        description: trimmedDescription,
      };
      if (trimmedPerson) {
        data.person = {
          create: {
            firstName: trimmedPerson.firstName,
            lastName: trimmedPerson.lastName,
            middleName: trimmedPerson.middleName || null,
            birthDate: trimmedPerson.birthDate ? new Date(trimmedPerson.birthDate) : null,
            gender: trimmedPerson.gender?.trim() || null,
          },
        };
      }
      if (trimmedOrg) {
        data.organization = {
          create: {
            legalName: trimmedOrg.legalName,
            taxId: trimmedOrg.taxId || null,
            registrationDate: trimmedOrg.registrationDate
              ? new Date(trimmedOrg.registrationDate)
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
        `Party '${partyId}' not found in tenant '${tenantId}'.`,
        {
          suggestedTools: ["search_parties", "get_party"],
          context: { partyId, tenantId },
        }
      );
    }

    return PartyService.toPartyResult(party);
  }

  // ─── Search Parties ───────────────────────────────────────────

  async searchParties(input: SearchPartiesInput): Promise<SearchPartiesResult> {
    const { tenantId, name, partyType, roleType, limit = 50, offset = 0 } = input;

    // Validate pagination parameters
    const validatedLimit = Math.min(Math.max(limit, 1), 500); // Clamp between 1-500
    const validatedOffset = Math.max(offset, 0);

    const db = this.prisma.tenantScoped(tenantId);

    // Build where clause more efficiently
    const where: Prisma.PartyWhereInput = { tenantId };
    
    if (name) {
      // Use contains for flexible partial matching (case-insensitive).
      // Trim whitespace to avoid useless LIKE '%  %' queries.
      const trimmedName = name.trim();
      if (trimmedName.length > 0) {
        where.name = { contains: trimmedName, mode: "insensitive" };
      }
      // If trimmed name is empty, skip the filter — returning all parties
      // is more useful than an empty result set.
    }
    
    if (partyType) {
      where.partyType = { name: partyType };
    }
    
    if (roleType) {
      const trimmedRoleType = roleType.trim();
      if (trimmedRoleType.length > 0) {
        where.roles = { some: { roleType: { name: trimmedRoleType } } };
      }
    }

    // Use a transaction to ensure count + findMany see a consistent snapshot.
    // Without this, a concurrent insert between the two queries could cause
    // hasMore to be inaccurate (count says N+1, but findMany returns N).
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
    this.requireMaxLength(roleType, "Role type", 100, "get_type_table_values");
    const trimmedRoleType = roleType.trim();

    // Validate and parse fromDate BEFORE any DB access (pure computation)
    const roleFromDate = fromDate ? new Date(fromDate) : new Date();
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
          `Party '${partyId}' not found in tenant '${tenantId}'.`,
          {
            suggestedTools: ["search_parties", "get_party"],
            context: { partyId, tenantId },
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
          `Use 'update_party_role' to modify it or set thruDate first.`,
          {
            suggestedTools: ["get_party", "update_party_role"],
            context: {
              partyId,
              roleType: trimmedRoleType,
              existingRoleId: existingRole.partyRoleId,
              existingRoleDate: existingRole.fromDate.toISOString()
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
    if (!contactMechanismType || contactMechanismType.trim().length === 0) {
      throw new InvalidTypeValueError(
        "contactMechanismType cannot be empty",
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "contactMechanismType", received: contactMechanismType },
        }
      );
    }
    const trimmedCmType = contactMechanismType.trim();
    this.requireMaxLength(trimmedCmType, "Contact mechanism type", 50, "get_type_table_values");

    // Validate subtype data early — avoids wasting a DB round-trip on invalid input.
    let validContactData: PostalAddressInput | TelecomNumberInput | EmailAddressInput;
    if (trimmedCmType === "POSTAL_ADDRESS") {
      if (!postalAddress) {
        throw new MissingSubtypeDataError(
          "postalAddress is required when contactMechanismType is POSTAL_ADDRESS.",
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, missingField: "postalAddress" } }
        );
      }
      this.requireNonEmpty(postalAddress.addressLine1, "addressLine1", "postal address");
      this.requireMaxLength(postalAddress.addressLine1, "addressLine1", 200, "add_contact_mechanism");
      this.requireNonEmpty(postalAddress.city, "city", "postal address");
      this.requireMaxLength(postalAddress.city, "city", 100, "add_contact_mechanism");
      this.requireNonEmpty(postalAddress.country, "country", "postal address");
      this.requireMaxLength(postalAddress.country, "country", 3, "add_contact_mechanism");
      if (postalAddress.addressLine2) this.requireMaxLength(postalAddress.addressLine2, "addressLine2", 200, "add_contact_mechanism");
      if (postalAddress.stateProvince) this.requireMaxLength(postalAddress.stateProvince, "stateProvince", 100, "add_contact_mechanism");
      if (postalAddress.postalCode) this.requireMaxLength(postalAddress.postalCode, "postalCode", 20, "add_contact_mechanism");
      validContactData = postalAddress;
    } else if (trimmedCmType === "TELECOM_NUMBER") {
      if (!telecomNumber) {
        throw new MissingSubtypeDataError(
          "telecomNumber is required when contactMechanismType is TELECOM_NUMBER.",
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, missingField: "telecomNumber" } }
        );
      }
      this.requireNonEmpty(telecomNumber.areaCode, "areaCode", "telecom number");
      this.requireMaxLength(telecomNumber.areaCode, "areaCode", 10, "add_contact_mechanism");
      this.requireNonEmpty(telecomNumber.lineNumber, "lineNumber", "telecom number");
      this.requireMaxLength(telecomNumber.lineNumber, "lineNumber", 20, "add_contact_mechanism");
      if (telecomNumber.countryCode) this.requireMaxLength(telecomNumber.countryCode, "countryCode", 5, "add_contact_mechanism");
      if (telecomNumber.extension) this.requireMaxLength(telecomNumber.extension, "extension", 10, "add_contact_mechanism");
      validContactData = telecomNumber;
    } else if (trimmedCmType === "EMAIL_ADDRESS") {
      if (!emailAddress) {
        throw new MissingSubtypeDataError(
          "emailAddress is required when contactMechanismType is EMAIL_ADDRESS.",
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, missingField: "emailAddress" } }
        );
      }
      this.requireNonEmpty(emailAddress.email, "email", "email address");
      this.requireMaxLength(emailAddress.email, "email", 254, "add_contact_mechanism");
      const normalizedEmail = emailAddress.email.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(normalizedEmail)) {
        throw new InvalidTypeValueError(
          `Invalid email format: ${emailAddress.email}`,
          { suggestedTools: ["add_contact_mechanism"], context: { contactMechanismType: trimmedCmType, field: "email", invalidValue: emailAddress.email } }
        );
      }
      validContactData = { ...emailAddress, email: normalizedEmail };
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
          `Party '${partyId}' not found in tenant '${tenantId}'.`,
          {
            suggestedTools: ["search_parties", "get_party"],
            context: { partyId, tenantId },
          }
        );
      }

      return tx.contactMechanism.create({
        data: {
          contactMechanismTypeId: cmType.contactMechanismTypeId,
          tenantId,
          postalAddress: trimmedCmType === "POSTAL_ADDRESS"
            ? {
                create: {
                  addressLine1: (validContactData as PostalAddressInput).addressLine1.trim(),
                  addressLine2: (validContactData as PostalAddressInput).addressLine2?.trim() || null,
                  city: (validContactData as PostalAddressInput).city.trim(),
                  stateProvince: (validContactData as PostalAddressInput).stateProvince?.trim() || null,
                  postalCode: (validContactData as PostalAddressInput).postalCode?.trim() || null,
                  country: (validContactData as PostalAddressInput).country.trim().toUpperCase(),
                },
              }
            : undefined,
          telecomNumber: trimmedCmType === "TELECOM_NUMBER"
            ? {
                create: {
                  countryCode: (validContactData as TelecomNumberInput).countryCode?.trim() || "+1",
                  areaCode: (validContactData as TelecomNumberInput).areaCode.trim(),
                  lineNumber: (validContactData as TelecomNumberInput).lineNumber.trim(),
                  extension: (validContactData as TelecomNumberInput).extension?.trim() || null,
                },
              }
            : undefined,
          emailAddress: trimmedCmType === "EMAIL_ADDRESS"
            ? {
                create: {
                  email: (validContactData as EmailAddressInput).email,
                },
              }
            : undefined,
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

  private static toPartyResult(party: PartyWithIncludes): PartyResult {
    return {
      partyId: party.partyId,
      name: party.name,
      partyType: party.partyType?.name ?? "UNKNOWN",
      tenantId: party.tenantId,
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
