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
import { PrismaService } from "../../../prisma/prisma.service";
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
} from "./party.types";

@Injectable()
export class PartyService {
  private readonly logger = new Logger(PartyService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Create Party ─────────────────────────────────────────────

  async createParty(input: CreatePartyInput): Promise<PartyResult> {
    const { tenantId, partyType, name, description, person: personData, organization: orgData } = input;

    // Validate subtype data
    if (partyType === "PERSON" && !personData) {
      throw new MissingSubtypeDataError(
        "When partyType is PERSON, the 'person' object with firstName and lastName is required.",
        { suggestedTools: ["create_party"] }
      );
    }
    if (partyType === "ORGANIZATION" && !orgData) {
      throw new MissingSubtypeDataError(
        "When partyType is ORGANIZATION, the 'organization' object with legalName is required.",
        { suggestedTools: ["create_party"] }
      );
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
        include: {
          person: true,
          organization: true,
          partyType: true,
          roles: {
            include: { roleType: true },
          },
        },
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
      include: {
        person: true,
        organization: true,
        partyType: true,
        roles: {
          include: { roleType: true },
        },
      },
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

    const db = this.prisma.tenantScoped(tenantId);

    const where: Prisma.PartyWhereInput = {
      tenantId,
      ...(name ? { name: { contains: name, mode: "insensitive" } } : {}),
      ...(partyType ? { partyType: { name: partyType } } : {}),
      ...(roleType ? { roles: { some: { roleType: { name: roleType } } } } : {}),
    };

    const [items, total] = await Promise.all([
      db.party.findMany({
        where,
        include: {
          person: true,
          organization: true,
          partyType: true,
          roles: { include: { roleType: true } },
        },
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
      }),
      db.party.count({ where }),
    ]);

    return {
      items: items.map((p: any) => this.toPartyResult(p)),
      total,
      limit,
      offset,
    };
  }

  // ─── Add Party Role ───────────────────────────────────────────

  async addPartyRole(input: AddPartyRoleInput): Promise<PartyRoleResult> {
    const { tenantId, partyId, roleType, fromDate } = input;

    const db = this.prisma.tenantScoped(tenantId);

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

    // Look up role type
    const roleTypeRecord = await db.roleType.findFirst({
      where: { name: roleType },
    });
    if (!roleTypeRecord) {
      throw new InvalidTypeValueError(
        `ROLE_TYPE '${roleType}' is not valid. Use 'get_type_table_values' to see valid role types.`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "roleType", invalidValue: roleType },
        }
      );
    }

    // Check if role already active
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
        `Use 'update_party_role' to modify it or set thruDate first.`,
        {
          suggestedTools: ["get_party"],
          context: { partyId, roleType },
        }
      );
    }

    const role = await db.partyRole.create({
      data: {
        partyId,
        roleTypeId: roleTypeRecord.roleTypeId,
        fromDate: fromDate ? new Date(fromDate) : new Date(),
      },
      include: { roleType: true },
    });

    this.logger.log(`Added role '${roleType}' to party ${partyId}`);
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
      where: { name: contactMechanismType },
    });
    if (!cmType) {
      throw new InvalidTypeValueError(
        `CONTACT_MECHANISM_TYPE '${contactMechanismType}' is not valid. ` +
        `Valid types: ['POSTAL_ADDRESS', 'TELECOM_NUMBER', 'EMAIL_ADDRESS'].`,
        {
          suggestedTools: ["get_type_table_values"],
          context: { field: "contactMechanismType", invalidValue: contactMechanismType },
        }
      );
    }

    // Validate subtype data
    if (contactMechanismType === "POSTAL_ADDRESS" && !postalAddress) {
      throw new MissingSubtypeDataError(
        "postalAddress is required when contactMechanismType is POSTAL_ADDRESS.",
        { suggestedTools: ["add_contact_mechanism"] }
      );
    }
    if (contactMechanismType === "TELECOM_NUMBER" && !telecomNumber) {
      throw new MissingSubtypeDataError(
        "telecomNumber is required when contactMechanismType is TELECOM_NUMBER.",
        { suggestedTools: ["add_contact_mechanism"] }
      );
    }
    if (contactMechanismType === "EMAIL_ADDRESS" && !emailAddress) {
      throw new MissingSubtypeDataError(
        "emailAddress is required when contactMechanismType is EMAIL_ADDRESS.",
        { suggestedTools: ["add_contact_mechanism"] }
      );
    }

    // Create contact mechanism with subtype in a transaction
    const contactMechanism = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      return tx.contactMechanism.create({
        data: {
          contactMechanismTypeId: cmType.contactMechanismTypeId,
          tenantId,
          postalAddress: postalAddress
            ? {
                create: {
                  addressLine1: postalAddress.addressLine1,
                  addressLine2: postalAddress.addressLine2 || null,
                  city: postalAddress.city,
                  stateProvince: postalAddress.stateProvince || null,
                  postalCode: postalAddress.postalCode || null,
                  country: postalAddress.country,
                },
              }
            : undefined,
          telecomNumber: telecomNumber
            ? {
                create: {
                  countryCode: telecomNumber.countryCode || "+1",
                  areaCode: telecomNumber.areaCode,
                  lineNumber: telecomNumber.lineNumber,
                  extension: telecomNumber.extension || null,
                },
              }
            : undefined,
          emailAddress: emailAddress
            ? {
                create: {
                  email: emailAddress.email,
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

    this.logger.log(`Added ${contactMechanismType} to party ${partyId}`);

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

  private toPartyResult(party: any): PartyResult {
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
      roles: (party.roles ?? []).map((r: any) => ({
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
