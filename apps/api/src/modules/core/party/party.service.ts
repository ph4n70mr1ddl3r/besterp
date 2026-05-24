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
  ConcurrencyError,
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
    if (!name || name.trim().length === 0) {
      throw new InvalidTypeValueError(
        "Party name cannot be empty",
        { 
          suggestedTools: ["create_party"],
          context: { field: "name", received: name }
        }
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
      if (!personData.lastName || personData.lastName.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "lastName is required for person data",
          { suggestedTools: ["create_party"], context: { field: "lastName" } }
        );
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
    }

    // Get RLS-scoped client for tenant isolation
    const db = this.prisma.tenantScoped(tenantId);

    // Look up party type ID from the type table
    const partyTypeRecord = await db.partyType.findFirst({
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
                  birthDate: personData.birthDate ? new Date(personData.birthDate) : null,
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
        include: PartyService.PARTY_INCLUDE,
      });
    });

    this.logger.log(`Created ${partyType} party: ${name} (${party.partyId})`);
    return this.toPartyResult(party);
  }

  // ─── Get Party ────────────────────────────────────────────────

  async getParty(tenantId: string, partyId: string): Promise<PartyResult> {
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

    return this.toPartyResult(party);
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
      // Use contains for flexible partial matching (case-insensitive)
      const trimmedName = name.trim();
      if (trimmedName.length > 0) {
        where.name = { contains: trimmedName, mode: "insensitive" };
      }
    }
    
    if (partyType) {
      where.partyType = { name: partyType };
    }
    
    if (roleType) {
      where.roles = { some: { roleType: { name: roleType } } };
    }

    // Use separate count query for better performance
    const total = await db.party.count({ where });
    
    const items = await db.party.findMany({
      where,
      include: PartyService.PARTY_INCLUDE,
      take: validatedLimit,
      skip: validatedOffset,
      orderBy: { createdAt: "desc" },
    });

    return {
      items: items.map((p) => this.toPartyResult(p)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: validatedOffset + validatedLimit < total,
    };
  }

  // ─── Add Party Role ───────────────────────────────────────────

  async addPartyRole(input: AddPartyRoleInput): Promise<PartyRoleResult> {
    const { tenantId, partyId, roleType, fromDate } = input;

    const db = this.prisma.tenantScoped(tenantId);

    // Validate inputs
    if (!roleType || roleType.trim().length === 0) {
      throw new InvalidTypeValueError(
        "roleType cannot be empty",
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "roleType", received: roleType },
        }
      );
    }

    // Verify party exists in tenant (RLS enforces this, but explicit check gives better error)
    const party = await db.party.findFirst({
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

    // Look up role type with better error handling
    const roleTypeRecord = await db.roleType.findFirst({
      where: { name: roleType.trim() },
    });
    if (!roleTypeRecord) {
      throw new InvalidTypeValueError(
        `ROLE_TYPE '${roleType}' is not valid. Use 'get_type_table_values' to see valid role types.`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "roleType", invalidValue: roleType, lookupField: "name" },
        }
      );
    }

    // Check if role already active with more specific error
    const existingRole = await db.partyRole.findFirst({
      where: {
        partyId,
        roleTypeId: roleTypeRecord.roleTypeId,
        thruDate: null,
      },
    });
    if (existingRole) {
      throw new DuplicateEntityError(
        `Party '${partyId}' already has active role '${roleType}'. ` +
        `Existing role started on ${existingRole.fromDate.toISOString()}. ` +
        `Use 'update_party_role' to modify it or set thruDate first.`,
        {
          suggestedTools: ["get_party", "update_party_role"],
          context: { 
            partyId, 
            roleType, 
            existingRoleId: existingRole.partyRoleId,
            existingRoleDate: existingRole.fromDate.toISOString()
          },
        }
      );
    }

    // Validate and parse fromDate
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

    // Create role in transaction for data consistency
    const role = await db.$transaction(async (tx) => {
      return tx.partyRole.create({
        data: {
          partyId,
          roleTypeId: roleTypeRecord.roleTypeId,
          fromDate: roleFromDate,
        },
        include: { roleType: true },
      });
    });

    this.logger.log(`Added role '${roleType}' to party ${partyId} (ID: ${role.partyRoleId})`);
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

    const db = this.prisma.tenantScoped(tenantId);

    // Validate inputs
    if (!contactMechanismType || contactMechanismType.trim().length === 0) {
      throw new InvalidTypeValueError(
        "contactMechanismType cannot be empty",
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "contactMechanismType", received: contactMechanismType },
        }
      );
    }

    // Verify party exists in tenant
    const party = await db.party.findFirst({
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

    // Look up contact mechanism type
    const cmType = await db.contactMechanismType.findFirst({
      where: { name: contactMechanismType.trim() },
    });
    if (!cmType) {
      throw new InvalidTypeValueError(
        `CONTACT_MECHANISM_TYPE '${contactMechanismType}' is not valid. ` +
        `Valid types: ['POSTAL_ADDRESS', 'TELECOM_NUMBER', 'EMAIL_ADDRESS'].`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { 
            field: "contactMechanismType", 
            invalidValue: contactMechanismType,
            validValues: ["POSTAL_ADDRESS", "TELECOM_NUMBER", "EMAIL_ADDRESS"]
          },
        }
      );
    }

    // Validate subtype data with detailed validation
    let validContactData: PostalAddressInput | TelecomNumberInput | EmailAddressInput | undefined;
    
    if (contactMechanismType === "POSTAL_ADDRESS") {
      if (!postalAddress) {
        throw new MissingSubtypeDataError(
          "postalAddress is required when contactMechanismType is POSTAL_ADDRESS.",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, missingField: "postalAddress" }
          }
        );
      }
      
      // Validate postal address structure
      if (!postalAddress.addressLine1 || postalAddress.addressLine1.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "addressLine1 is required for postal address",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "addressLine1" }
          }
        );
      }
      if (!postalAddress.city || postalAddress.city.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "city is required for postal address",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "city" }
          }
        );
      }
      if (!postalAddress.country || postalAddress.country.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "country is required for postal address",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "country" }
          }
        );
      }
      validContactData = postalAddress;
    } 
    else if (contactMechanismType === "TELECOM_NUMBER") {
      if (!telecomNumber) {
        throw new MissingSubtypeDataError(
          "telecomNumber is required when contactMechanismType is TELECOM_NUMBER.",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, missingField: "telecomNumber" }
          }
        );
      }
      
      // Validate telecom number structure
      if (!telecomNumber.areaCode || telecomNumber.areaCode.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "areaCode is required for telecom number",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "areaCode" }
          }
        );
      }
      if (!telecomNumber.lineNumber || telecomNumber.lineNumber.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "lineNumber is required for telecom number",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "lineNumber" }
          }
        );
      }
      validContactData = telecomNumber;
    } 
    else if (contactMechanismType === "EMAIL_ADDRESS") {
      if (!emailAddress) {
        throw new MissingSubtypeDataError(
          "emailAddress is required when contactMechanismType is EMAIL_ADDRESS.",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, missingField: "emailAddress" }
          }
        );
      }
      
      // Simple email validation
      if (!emailAddress.email || emailAddress.email.trim().length === 0) {
        throw new MissingSubtypeDataError(
          "email is required for email address",
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "email" }
          }
        );
      }
      
      // Basic email format validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(emailAddress.email.trim())) {
        throw new InvalidTypeValueError(
          `Invalid email format: ${emailAddress.email}`,
          { 
            suggestedTools: ["add_contact_mechanism"],
            context: { contactMechanismType, field: "email", invalidValue: emailAddress.email }
          }
        );
      }
      validContactData = emailAddress;
    }

    if (!validContactData) {
      throw new MissingSubtypeDataError(
        `No contact data provided for contactMechanismType '${contactMechanismType}'.`,
        {
          suggestedTools: ["add_contact_mechanism"],
          context: { contactMechanismType },
        }
      );
    }

    // Create contact mechanism with subtype in a transaction
    const contactMechanism = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      return tx.contactMechanism.create({
        data: {
          contactMechanismTypeId: cmType.contactMechanismTypeId,
          tenantId,
          postalAddress: contactMechanismType === "POSTAL_ADDRESS" && validContactData
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
          telecomNumber: contactMechanismType === "TELECOM_NUMBER" && validContactData
            ? {
                create: {
                  countryCode: (validContactData as TelecomNumberInput).countryCode?.trim() || "+1",
                  areaCode: (validContactData as TelecomNumberInput).areaCode.trim(),
                  lineNumber: (validContactData as TelecomNumberInput).lineNumber.trim(),
                  extension: (validContactData as TelecomNumberInput).extension?.trim() || null,
                },
              }
            : undefined,
          emailAddress: contactMechanismType === "EMAIL_ADDRESS" && validContactData
            ? {
                create: {
                  email: (validContactData as EmailAddressInput).email.trim().toLowerCase(),
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

    this.logger.log(`Added ${contactMechanismType} to party ${partyId} (ID: ${contactMechanism.contactMechanismId})`);

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

  private toPartyResult(party: PartyWithIncludes): PartyResult {
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
