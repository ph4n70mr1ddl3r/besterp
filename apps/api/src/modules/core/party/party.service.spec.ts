// Unit tests for PartyService
// Tests business logic for party operations with various scenarios

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PartyService } from "./party.service.js";
import { CreatePartyInput, SearchPartiesInput, AddContactMechanismInput } from "./party.types.js";
import { Prisma } from "@prisma/client";
import { TenantScopedClient } from "@besterp/database";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyRetryError,
  ConcurrencyConflictError,
  MAX_SEARCH_LIMIT,
} from "@besterp/shared";

/** Create a mock Prisma return object with all fields toPartyResult needs. */
function mockParty(overrides: Record<string, any> = {}) {
  return {
    partyId: "12345678-1234-1234-1234-123456789abc",
    partyTypeId: "pt-person",
    tenantId: "tenant-1",
    name: "Test Party",
    description: null,
    version: 1,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    partyType: { name: "PERSON", partyTypeId: "pt-person" },
    person: null,
    organization: null,
    roles: [],
    ...overrides,
  };
}

// Mock PrismaService
const mockPrismaService = {
  admin: {
    partyType: { findUnique: vi.fn() },
    roleType: { findUnique: vi.fn() },
    contactMechanismType: { findUnique: vi.fn() },
  },
  tenantScoped: vi.fn(),
} as any;

describe("PartyService", () => {
  let partyService: PartyService;

  beforeEach(() => {
    vi.clearAllMocks();
    partyService = new PartyService(mockPrismaService);
  });

  // Helper to set up the admin type lookups used by createParty / addPartyRole / addContactMechanism.
  // These methods moved global-type lookups (partyType, roleType, contactMechanismType) out of the
  // transaction and onto the admin client (round-51 review), so tests that previously mocked the
  // tx-level delegates must now mock the admin delegates instead.
  function mockAdminTypes(overrides: {
    partyTypeId?: string;
    roleTypeId?: string;
    contactMechanismTypeId?: string;
    partyTypeNull?: boolean;
    roleTypeNull?: boolean;
    cmTypeNull?: boolean;
  } = {}) {
    if (!overrides.partyTypeNull) {
      mockPrismaService.admin.partyType.findUnique.mockResolvedValue({ partyTypeId: overrides.partyTypeId ?? "pt-person" });
    } else {
      mockPrismaService.admin.partyType.findUnique.mockResolvedValue(null);
    }
    if (!overrides.roleTypeNull) {
      mockPrismaService.admin.roleType.findUnique.mockResolvedValue({ roleTypeId: overrides.roleTypeId ?? "rt-customer" });
    } else {
      mockPrismaService.admin.roleType.findUnique.mockResolvedValue(null);
    }
    if (!overrides.cmTypeNull) {
      mockPrismaService.admin.contactMechanismType.findUnique.mockResolvedValue({ contactMechanismTypeId: overrides.contactMechanismTypeId ?? "cmt-postal" });
    } else {
      mockPrismaService.admin.contactMechanismType.findUnique.mockResolvedValue(null);
    }
  }

  describe("createParty", () => {
    it("should create a person party successfully", async () => {
      mockAdminTypes();
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
      };

      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            partyType: {
              findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
            },
            party: {
              create: vi.fn().mockResolvedValue(
                mockParty({
                  name: "John Doe",
                  person: { firstName: "John", lastName: "Doe" },
                })
              ),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);

      expect(result.partyId).toBe("12345678-1234-1234-1234-123456789abc");
      expect(result.name).toBe("John Doe");
      expect(result.person?.firstName).toBe("John");
      expect(result.person?.lastName).toBe("Doe");
    });

    it("should create an organization party successfully", async () => {
      mockAdminTypes();
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: { legalName: "Acme Corporation" },
      };

      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            partyType: {
              findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-org" }),
            },
            party: {
              create: vi.fn().mockResolvedValue(
                mockParty({
                  partyTypeId: "pt-org",
                  name: "Acme Corp",
                  partyType: { name: "ORGANIZATION", partyTypeId: "pt-org" },
                  person: null,
                  organization: { legalName: "Acme Corporation" },
                })
              ),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);

      expect(result.partyId).toBe("12345678-1234-1234-1234-123456789abc");
      expect(result.name).toBe("Acme Corp");
      expect(result.organization?.legalName).toBe("Acme Corporation");
    });

    it("should throw error for firstName exceeding max length", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "x".repeat(201),
          lastName: "Doe",
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for lastName exceeding max length", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "John",
          lastName: "x".repeat(201),
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for legalName exceeding max length", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: {
          legalName: "x".repeat(501),
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for missing person data", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
      };

      await expect(partyService.createParty(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error for missing organization data", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
      };

      await expect(partyService.createParty(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error when PERSON partyType has organization data", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
        organization: { legalName: "Acme Corp" },
      } as any;

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow("organization");
    });

    it("should throw error when ORGANIZATION partyType has person data", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        person: { firstName: "John", lastName: "Doe" },
        organization: { legalName: "Acme Corporation" },
      } as any;

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow("person");
    });

    it("should reject whitespace-padded partyType that hides a conflicting subtype (defense-in-depth)", async () => {
      // Regression guard: validateCreatePartySubtype must compare the
      // TRIMMED partyType. The boundary layers (REST @IsEnum, MCP z.enum)
      // reject whitespace-padded values, but the service is the last line
      // of defense for direct/internal callers. Previously it compared the
      // untrimmed value, so partyType " PERSON " with BOTH person and
      // organization data bypassed the exclusivity check — and since no
      // DB constraint enforces at-most-one subtype, BOTH subtype rows
      // were created. The service must reject this regardless of padding.
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: " PERSON " as any,
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
        organization: { legalName: "Acme Corp" },
      } as any;

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow("organization");
    });

    it("should throw error for invalid party type", async () => {
      mockAdminTypes({ partyTypeNull: true });
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "INVALID_TYPE" as any,
        name: "Test Party",
      };

      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {};
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for empty name", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "",
        person: { firstName: "John", lastName: "Doe" },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for name exceeding max length", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "x".repeat(501),
        person: { firstName: "John", lastName: "Doe" },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should validate required person fields", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "",
          lastName: "Doe",
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error for description exceeding max length", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        description: "x".repeat(1001),
        person: { firstName: "John", lastName: "Doe" },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for whitespace-only name", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "   ",
        person: { firstName: "John", lastName: "Doe" },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should reject HTML-only person first name (defense-in-depth)", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "<script>", lastName: "Doe" },
      } as any;

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow("HTML");
    });

    it("should reject HTML-only person last name (defense-in-depth)", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "John", lastName: "<script>alert(1)</script>" },
      } as any;

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow("HTML");
    });

    it("should reject HTML-only organization legalName (defense-in-depth)", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: { legalName: "<script>alert(1)</script>" },
      } as any;

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow("HTML");
    });

    it("should trim gender and middleName fields", async () => {
      mockAdminTypes();
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "  John  ",
          lastName: "  Doe  ",
          middleName: "  A  ",
          gender: "  male  ",
        },
      };

      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            partyType: {
              findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
            },
            party: {
              create: vi.fn().mockResolvedValue(
                mockParty({
                  name: "John Doe",
                  person: { firstName: "John", lastName: "Doe", middleName: "A", gender: "male" },
                })
              ),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);
      expect(result.name).toBe("John Doe");
    });

    it("should reject an invalid birthDate before reaching Prisma", async () => {
      // Regression guard: the MCP Zod schema only enforces a length cap on
      // birthDate, so a value like "2024-13-40" or "not-a-date" reaches the
      // service. Without service-level validation, `new Date("not-a-date")`
      // produces Invalid Date, which Prisma rejects with an opaque
      // serialization error that the MCP layer can't translate into a
      // structured INVALID_TYPE_VALUE response.
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "John",
          lastName: "Doe",
          birthDate: "not-a-date",
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow(/birthDate/);
    });

    it("should reject an impossible calendar date (e.g. month 13) for birthDate", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "John",
          lastName: "Doe",
          birthDate: "2024-13-40",
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(/birthDate/);
    });

    it("should reject an invalid registrationDate for organization", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: {
          legalName: "Acme Corporation",
          registrationDate: "not-a-date",
        },
      };

      await expect(partyService.createParty(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.createParty(input)).rejects.toThrow(/registrationDate/);
    });

    it("should accept a valid ISO 8601 birthDate", async () => {
      mockAdminTypes();
      // Sanity check: a real ISO date should not trip the new guard.
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "John",
          lastName: "Doe",
          birthDate: "1990-06-15",
        },
      };

      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            partyType: {
              findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
            },
            party: {
              create: vi.fn().mockResolvedValue(
                mockParty({
                  name: "John Doe",
                  person: { firstName: "John", lastName: "Doe", birthDate: new Date("1990-06-15") },
                })
              ),
            },
          };
          return fn(tx);
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);
      expect(result.person?.birthDate).toBe("1990-06-15T00:00:00.000Z");
    });

    it("should accept a whitespace-padded ISO birthDate (consistent with fromDate)", async () => {
      mockAdminTypes();
      // Regression guard: requireValidDate must validate the TRIMMED value
      // so a padded date like " 1990-06-15 " is accepted — matching
      // parseFromDate() (add_party_role) and the MCP Zod schemas, which
      // trim before format checks. Previously the service rejected padded
      // birthDate with a confusing "not a valid ISO 8601" error.
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "John",
          lastName: "Doe",
          birthDate: "  1990-06-15  ",
        },
      };

      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            partyType: {
              findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
            },
            party: {
              create: vi.fn().mockResolvedValue(
                mockParty({
                  name: "John Doe",
                  person: { firstName: "John", lastName: "Doe", birthDate: new Date("1990-06-15") },
                })
              ),
            },
          };
          return fn(tx);
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);
      expect(result.person?.birthDate).toBe("1990-06-15T00:00:00.000Z");
    });
  });

  describe("getParty", () => {
    it("should return party when found", async () => {
      const mockDb = {
        party: {
          findUnique: vi.fn().mockResolvedValue(
            mockParty({ name: "John Doe", person: { firstName: "John", lastName: "Doe" } })
          ),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.getParty("tenant-1", "12345678-1234-1234-1234-123456789abc");

      expect(result.partyId).toBe("12345678-1234-1234-1234-123456789abc");
      expect(result.name).toBe("John Doe");
    });

    it("should throw InvalidTypeValueError for non-UUID partyId", async () => {
      await expect(partyService.getParty("tenant-1", "nonexistent")).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw EntityNotFoundError when partyId is valid UUID but party doesn't exist", async () => {
      const mockDb = {
        party: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(
        partyService.getParty("tenant-1", "00000000-0000-0000-0000-000000000000")
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("should throw InvalidTypeValueError for invalid UUID format", async () => {
      await expect(
        partyService.getParty("tenant-1", "not-a-uuid")
      ).rejects.toThrow(InvalidTypeValueError);
      await expect(
        partyService.getParty("tenant-1", "not-a-uuid")
      ).rejects.toThrow("partyId");
    });

    it("should scope the lookup by tenantId at the application level", async () => {
      const findUnique = vi.fn().mockResolvedValue(
        mockParty({ name: "John Doe", person: { firstName: "John", lastName: "Doe" } })
      );
      const mockDb = { party: { findUnique } };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await partyService.getParty("tenant-1", "12345678-1234-1234-1234-123456789abc");

      // Defense-in-depth: tenantId must appear in the where clause so a
      // regression in the RLS context-setting path cannot become a
      // cross-tenant read. Earlier versions relied solely on RLS here.
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            partyId: "12345678-1234-1234-1234-123456789abc",
            tenantId: "tenant-1",
          }),
        })
      );
    });
  });

  describe("searchParties", () => {
    it("should search parties with filters", async () => {
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        name: "John",
        limit: 10,
        offset: 0,
      };

      const mockDb = {
        party: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi.fn().mockResolvedValue([
            mockParty({ name: "John Doe", person: { firstName: "John", lastName: "Doe" } }),
            mockParty({
              partyId: "party-2",
              name: "John Smith",
              person: { firstName: "John", lastName: "Smith" },
            }),
          ]),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              count: vi.fn().mockResolvedValue(2),
              findMany: vi.fn().mockResolvedValue([
                mockParty({ name: "John Doe", person: { firstName: "John", lastName: "Doe" } }),
                mockParty({
                  partyId: "party-2",
                  name: "John Smith",
                  person: { firstName: "John", lastName: "Smith" },
                }),
              ]),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.searchParties(input);

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    it("should handle empty search results", async () => {
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        name: "Nonexistent",
      };

      const mockDb = {
        party: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.searchParties(input);

      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it("should validate pagination parameters", async () => {
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        name: "Test",
        limit: 1000,
        offset: -1,
      };

      const mockDb = {
        party: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.searchParties(input);

      expect(result.limit).toBe(500);
      expect(result.offset).toBe(0);
    });

    it("should trim roleType filter before querying", async () => {
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        roleType: "  Customer  ",
      };

      const mockDb = {
        party: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await partyService.searchParties(input);

      expect(mockDb.party.count).toHaveBeenCalled();
      expect(mockDb.party.findMany).toHaveBeenCalled();
    });

    it("should reject whitespace-only name filter (don't silently widen to all parties)", async () => {
      // Regression guard: the old code silently dropped a whitespace-only
      // `name` filter and returned every party in the tenant. That's a UX
      // footgun (caller types '   ' and gets 10,000 results) and a minor
      // information-disclosure risk. The fix is to throw explicitly.
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        name: "   ",
      };

      await expect(partyService.searchParties(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.searchParties(input)).rejects.toThrow(/whitespace-only/);
    });

    it("should reject whitespace-only roleType filter", async () => {
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        roleType: "   ",
      };

      await expect(partyService.searchParties(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.searchParties(input)).rejects.toThrow(/whitespace-only/);
    });
  });

  describe("addPartyRole", () => {
    it("should add role to party successfully", async () => {
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      };

      const mockDb = {
        roleType: {
          findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([{ partyRoleId: "role-123", fromDate: new Date(), thruDate: null }]),
            partyRole: {
              findUnique: vi.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
                roleType: { name: "Customer", roleTypeId: "rt-customer" },
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addPartyRole(input);

      expect(result.partyRoleId).toBe("role-123");
      expect(result.roleTypeName).toBe("Customer");
    });

    it("should emit snake_case column names in the ON CONFLICT INSERT (regression)", async () => {
      // Regression guard: the raw $queryRaw INSERT targeted the DB columns by
      // camelCase names ("partyId", "roleTypeId", ...) even though the physical
      // columns are snake_case (party_id, role_type_id, ...). Prisma's typed
      // client hides this via @map, but raw SQL addresses the real columns, so
      // the query threw `column "partyId" of relation "party_role" does not
      // exist` at runtime. The mock below records the tagged-template SQL and
      // asserts the snake_case names are present and the camelCase ones are not.
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      };

      let capturedSql = "";
      const mockDb = {
        roleType: {
          findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const queryRawMock = vi.fn().mockResolvedValue([
            { partyRoleId: "role-123", fromDate: new Date(), thruDate: null },
          ]);
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: queryRawMock,
            partyRole: {
              findUnique: vi.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
                roleType: { name: "Customer", roleTypeId: "rt-customer" },
              }),
            },
          };
          const outcome = await fn(tx);
          // Tagged-template call: calls[0][0] is the TemplateStringsArray,
          // calls[0][1..] are the interpolated parameter values. Joining the
          // strings reconstitutes the SQL text (with ? placeholders) so we can
          // assert on the column names actually sent to the database.
          const firstCall = queryRawMock.mock.calls[0];
          if (firstCall && Array.isArray(firstCall[0])) {
            capturedSql = (firstCall[0] as readonly string[]).join("?");
          }
          return outcome;
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await partyService.addPartyRole(input);

      expect(capturedSql).toContain('"party_role"');
      expect(capturedSql).toContain('"party_id"');
      expect(capturedSql).toContain('"role_type_id"');
      expect(capturedSql).toContain('"from_date"');
      expect(capturedSql).toContain('AS "partyRoleId"');
      // The camelCase names that Prisma exposes on the typed client must NOT
      // appear as column references in the raw SQL. "fromDate"/"thruDate"/
      // "partyRoleId" legitimately reappear as RETURNING aliases, but the
      // pure column-name forms below are never aliased to and are the
      // clearest indicator of the original snake_case bug.
      expect(capturedSql).not.toContain('"partyId"');
      expect(capturedSql).not.toContain('"roleTypeId"');
    });

    it("should throw error for duplicate role", async () => {
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      };

      const mockDb = {
        roleType: {
          findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([]),
            partyRole: {
              findFirst: vi.fn().mockResolvedValue({
                partyRoleId: "existing-role",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addPartyRole(input)).rejects.toThrow(DuplicateEntityError);
    });

    it("should retry the transaction on ConcurrencyRetryError and succeed", async () => {
      // Regression: addPartyRole used to re-throw ConcurrencyRetryError
      // ("Transaction conflict — retry the operation.") straight to the caller
      // even though the comments promised an outer retry loop. A concurrent
      // add_party_role that lost the insert race therefore surfaced as an
      // internal error instead of retrying. Now the service retries the whole
      // transaction a bounded number of times.
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      };

      const transaction = vi
        .fn()
        // First attempt loses the insert race.
        .mockRejectedValueOnce(new ConcurrencyRetryError("Transaction conflict — retry the operation."))
        // Second attempt succeeds.
        .mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([{ partyRoleId: "role-123", fromDate: new Date(), thruDate: null }]),
            partyRole: {
              findUnique: vi.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
                roleType: { name: "Customer", roleTypeId: "rt-customer" },
              }),
            },
          };
          return fn(tx);
        });
      const mockDb = {
        roleType: { findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }) },
        $transaction: transaction,
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addPartyRole(input);

      expect(result.partyRoleId).toBe("role-123");
      expect(transaction).toHaveBeenCalledTimes(2);
    });

    it("should throw ConcurrencyConflictError after exhausting retry attempts", async () => {
      // Regression: when the transaction keeps losing the insert race, the
      // service must surface a DomainError with a retry hint instead of
      // leaking the internal ConcurrencyRetryError to the caller.
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      };

      const transaction = vi.fn().mockRejectedValue(new ConcurrencyRetryError("Transaction conflict — retry the operation."));
      const mockDb = {
        roleType: { findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }) },
        $transaction: transaction,
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      try {
        await partyService.addPartyRole(input);
        expect.fail("expected ConcurrencyConflictError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConcurrencyConflictError);
        const domainErr = err as ConcurrencyConflictError;
        expect(domainErr.suggestedTools).toContain("add_party_role");
      }
      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it("should not suggest the nonexistent 'update_party_role' tool", async () => {
      mockAdminTypes();
      // Regression guard: the duplicate-role error used to suggest
      // 'update_party_role' as a next action, but no such tool exists.
      // AI agents following the suggestion would loop on UNKNOWN_TOOL.
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      };

      const mockDb = {
        roleType: {
          findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([]),
            partyRole: {
              findFirst: vi.fn().mockResolvedValue({
                partyRoleId: "existing-role",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      try {
        await partyService.addPartyRole(input);
        expect.fail("expected DuplicateEntityError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateEntityError);
        const domainErr = err as DuplicateEntityError;
        expect(domainErr.suggestedTools).not.toContain("update_party_role");
        expect(domainErr.suggestedTools).toContain("get_party");
      }
    });

    it("should throw error for roleType exceeding max length", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "x".repeat(101),
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for invalid role type", async () => {
      mockAdminTypes({ roleTypeNull: true });
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "InvalidRole",
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw EntityNotFoundError when party does not exist", async () => {
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "00000000-0000-0000-0000-000000000000",
        roleType: "Customer",
      };

      const mockDb = {
        roleType: {
          findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue(null) },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addPartyRole(input)).rejects.toThrow(EntityNotFoundError);
    });

    it("should throw error for invalid fromDate format before DB lookup", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
        fromDate: "not-a-date",
      };

      // Should throw before any DB call
      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.addPartyRole(input)).rejects.toThrow("fromDate is not a valid ISO 8601 date");
    });

    it("should reject fromDate that Date accepts but is not ISO 8601", async () => {
      // new Date("Jan 1 2024") parses successfully, but it is not ISO 8601.
      // parseFromDate must enforce ISO (matching requireValidDate for
      // birthDate/registrationDate) instead of trusting new Date().
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
        fromDate: "Jan 1 2024",
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.addPartyRole(input)).rejects.toThrow("fromDate is not a valid ISO 8601 date");
    });

    it("should throw InvalidTypeValueError for invalid partyId format", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "not-a-uuid",
        roleType: "Customer",
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.addPartyRole(input)).rejects.toThrow("partyId");
    });

    it("should throw InvalidTypeValueError for empty roleType", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "",
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for whitespace-only roleType", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "   ",
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should trim roleType before lookup", async () => {
      mockAdminTypes();
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "  Customer  ",
      };

      const mockDb = {
        roleType: {
          findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([{ partyRoleId: "role-123", fromDate: new Date(), thruDate: null }]),
            partyRole: {
              findUnique: vi.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
                roleType: { name: "Customer", roleTypeId: "rt-customer" },
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addPartyRole(input);

      // Verify the trimmed value was used for the lookup (admin client, not tenant-scoped)
      expect(mockPrismaService.admin.roleType.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: "Customer" } })
      );
      expect(result.roleTypeName).toBe("Customer");
    });
  });

  describe("getParty edge cases", () => {
    it("should throw InvalidTypeValueError for empty tenantId", async () => {
      await expect(partyService.getParty("", "12345678-1234-1234-1234-123456789abc")).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw InvalidTypeValueError for tenantId exceeding max length", async () => {
      await expect(partyService.getParty("x".repeat(101), "12345678-1234-1234-1234-123456789abc")).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw EntityNotFoundError for valid UUID but non-existent party (ensure toPartyResult not called)", async () => {
      const mockDb = {
        party: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);
      await expect(
        partyService.getParty("tenant-1", "12345678-1234-1234-1234-123456789abc")
      ).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("searchParties edge cases", () => {
    it("should reject whitespace-only partyType filter", async () => {
      const input: SearchPartiesInput = {
        tenantId: "tenant-1",
        partyType: "   " as any,
      };
      await expect(partyService.searchParties(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should clamp limit to max when over limit", async () => {
      const mockDb = {
        party: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.searchParties({
        tenantId: "tenant-1",
        limit: 1001,
        offset: 0,
      });
      expect(result.limit).toBe(MAX_SEARCH_LIMIT);
    });

    it("should clamp negative offset to 0", async () => {
      const mockDb = {
        party: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.searchParties({
        tenantId: "tenant-1",
        name: "test",
        offset: -5,
      });
      expect(result.offset).toBe(0);
    });
  });

  describe("addPartyRole edge cases", () => {
    it("should reject fromDate exceeding max length", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
        fromDate: "x".repeat(31),
      };
      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should default fromDate to now when undefined", async () => {
      mockAdminTypes();
      const mockDb = {
        roleType: { findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }) },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([{ partyRoleId: "role-123", fromDate: new Date(), thruDate: null }]),
            partyRole: {
              findUnique: vi.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date(),
                thruDate: null,
                roleType: { name: "Customer", roleTypeId: "rt-customer" },
              }),
            },
          };
          return fn(tx);
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addPartyRole({
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
      });
      expect(result.roleTypeName).toBe("Customer");
    });

    it("should accept whitespace-padded fromDate after trim", async () => {
      mockAdminTypes();
      // Defense-in-depth: the pre-trim length check must not reject a
      // whitespace-padded date whose trimmed value is within the limit.
      const mockDb = {
        roleType: { findUnique: vi.fn().mockResolvedValue({ roleTypeId: "rt-customer" }) },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            $queryRaw: vi.fn().mockResolvedValue([{ partyRoleId: "role-123", fromDate: new Date("2024-06-15"), thruDate: null }]),
            partyRole: {
              findUnique: vi.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "12345678-1234-1234-1234-123456789abc",
                roleTypeId: "rt-customer",
                fromDate: new Date("2024-06-15"),
                thruDate: null,
                roleType: { name: "Customer", roleTypeId: "rt-customer" },
              }),
            },
          };
          return fn(tx);
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addPartyRole({
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "Customer",
        fromDate: "  2024-06-15T00:00:00.000Z  ",
      });
      expect(result.roleTypeName).toBe("Customer");
    });
  });

  describe("addContactMechanism", () => {
    it("should add postal address successfully", async () => {
      mockAdminTypes();
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "US",
        },
      };

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-postal" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
            },
            contactMechanism: {
              create: vi.fn().mockResolvedValue({
                contactMechanismId: "contact-123",
                contactMechanismTypeId: "cmt-postal",
                contactMechanismType: { name: "POSTAL_ADDRESS", contactMechanismTypeId: "cmt-postal" },
                postalAddress: {
                  addressLine1: "123 Main St",
                  addressLine2: null,
                  city: "Anytown",
                  stateProvince: null,
                  postalCode: null,
                  country: "US",
                },
                telecomNumber: null,
                emailAddress: null,
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addContactMechanism(input);

      expect(result.contactMechanismId).toBe("contact-123");
      expect(result.contactMechanismType).toBe("POSTAL_ADDRESS");
      expect(result.postalAddress?.addressLine1).toBe("123 Main St");
    });

    it("should validate required postal address fields", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS" as const,
        postalAddress: {
          city: "Anytown",
          country: "US",
        },
      } as any;

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should validate email format", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: {
          email: "invalid-email",
        },
      };

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-email" }),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw EntityNotFoundError when party does not exist (inside transaction)", async () => {
      mockAdminTypes();
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "00000000-0000-0000-0000-000000000000",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "US",
        },
      };

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-postal" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue(null),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(EntityNotFoundError);
    });

    it("should throw InvalidTypeValueError when city is missing for postal address", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS" as const,
        postalAddress: {
          addressLine1: "123 Main St",
          country: "US",
        },
      } as any;

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-postal" }),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw InvalidTypeValueError when country is missing for postal address", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS" as const,
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
        },
      } as any;

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-postal" }),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should add telecom number successfully", async () => {
      mockAdminTypes();
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          areaCode: "415",
          lineNumber: "5551234",
        },
      };

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-telecom" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
            },
            telecomNumber: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            contactMechanism: {
              create: vi.fn().mockResolvedValue({
                contactMechanismId: "contact-telecom-1",
                contactMechanismTypeId: "cmt-telecom",
                contactMechanismType: { name: "TELECOM_NUMBER", contactMechanismTypeId: "cmt-telecom" },
                postalAddress: null,
                telecomNumber: {
                  countryCode: "+1",
                  areaCode: "415",
                  lineNumber: "5551234",
                  extension: null,
                },
                emailAddress: null,
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addContactMechanism(input);

      expect(result.contactMechanismId).toBe("contact-telecom-1");
      expect(result.contactMechanismType).toBe("TELECOM_NUMBER");
      expect(result.telecomNumber?.areaCode).toBe("415");
      expect(result.postalAddress).toBeNull();
    });

    it("should add email address successfully", async () => {
      mockAdminTypes();
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: {
          email: "Test@Example.COM",
        },
      };

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-email" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
            },
            emailAddress: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            contactMechanism: {
              create: vi.fn().mockResolvedValue({
                contactMechanismId: "contact-email-1",
                contactMechanismTypeId: "cmt-email",
                contactMechanismType: { name: "EMAIL_ADDRESS", contactMechanismTypeId: "cmt-email" },
                postalAddress: null,
                telecomNumber: null,
                emailAddress: {
                  email: "test@example.com",
                },
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.addContactMechanism(input);

      expect(result.contactMechanismId).toBe("contact-email-1");
      expect(result.contactMechanismType).toBe("EMAIL_ADDRESS");
      expect(result.emailAddress?.email).toBe("test@example.com");
    });

    it("should strip HTML tags from email before storing (defense-in-depth)", async () => {
      mockAdminTypes();
      // Regression guard: the service is the last line of defense for
      // direct/internal callers that bypass the REST DTO's stricter
      // @IsEmail. EMAIL_REGEX permits '<' and '>', so without stripping,
      // tags embedded in the address would be stored verbatim (stored-XSS
      // surface if ever rendered). The MCP path already strips HTML; the
      // service must match it. A whole <script>...</script> payload is
      // removed entirely (and thus rejected as an empty local part), so we
      // use a tag pair that strips to a still-valid address.
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: {
          email: "<b>jane</b>.doe@Example.COM",
        },
      };

      const createSpy = vi.fn().mockResolvedValue({
        contactMechanismId: "contact-email-1",
        contactMechanismTypeId: "cmt-email",
        contactMechanismType: { name: "EMAIL_ADDRESS", contactMechanismTypeId: "cmt-email" },
        postalAddress: null,
        telecomNumber: null,
        emailAddress: { email: "jane.doe@example.com" },
      });
      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-email" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
            },
            emailAddress: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            contactMechanism: { create: createSpy },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await partyService.addContactMechanism(input);

      // The HTML tags must be stripped and the address lowercased before
      // being passed to the persistence layer.
      expect(createSpy).toHaveBeenCalledTimes(1);
      const created = createSpy.mock.calls[0]![0].data.emailAddress.create;
      expect(created.email).toBe("jane.doe@example.com");
    });

    it("should redact the local part of a duplicate email without leaking the '@' (short local part)", async () => {
      mockAdminTypes();
      // Regression guard: checkEmailDuplicate builds a masked preview of the
      // offending address for the DuplicateEntityError message + context. A
      // fixed `slice(0, 2)` preview spanned into the '@' for a single-char
      // local part ("a@x.com" → "a@***@x.com"), emitting a malformed address.
      // The preview is now clamped to `min(2, atIdx)` so the '@' is never
      // included, and the full address never reaches the error surface.
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "a@example.com" },
      };

      // Simulate an existing email already linked to THIS party (the duplicate
      // condition). partyContacts[0].partyId matches the request partyId.
      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-email" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
            },
            emailAddress: {
              findFirst: vi.fn().mockResolvedValue({
                email: "a@example.com",
                contactMechanism: {
                  partyContacts: [{ partyId: "12345678-1234-1234-1234-123456789abc" }],
                },
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      let caught: unknown;
      try {
        await partyService.addContactMechanism(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DuplicateEntityError);
      const err = caught as DuplicateEntityError;
      // The malformed 'a@***@example.com' must never appear — the '@' stays a
      // single time, separating the masked local part from the domain.
      expect(err.message).toContain("a***@example.com");
      expect(err.message).not.toContain("a@***@");
      // The same redaction is mirrored in the structured error context.
      expect(err.context.email).toBe("a***@example.com");
      // The full unmasked local part must never reach the error surface.
      expect(JSON.stringify(err)).not.toMatch(/a@example\.com/);
    });

    it("scopes the email duplicate check to the requesting party (no false positive for other parties)", async () => {
      mockAdminTypes();
      // Regression guard for round-30 scoping fix: the duplicate query must be
      // filtered by partyContacts.some({ partyId }) so an identical email
      // registered to a DIFFERENT party is not mistaken for a duplicate of the
      // requesting party.
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "11111111-1111-1111-1111-111111111111",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "shared@example.com" },
      };

      let capturedWhere: { contactMechanism?: unknown } | undefined;
      const captureWhere = vi.fn().mockImplementation((args: any) => {
        capturedWhere = args.where;
        // Only the requesting party owns this email — simulate the
        // scoped query returning no match for the requesting party.
        return Promise.resolve(null);
      });
      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-email" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn: any) => {
          const tx = {
            party: {
              findUnique: vi.fn().mockResolvedValue({ partyId: "11111111-1111-1111-1111-111111111111" }),
            },
            contactMechanism: {
              create: vi.fn().mockResolvedValue({
                contactMechanismId: "cm-new",
                contactMechanismTypeId: "cmt-email",
                tenantId: "tenant-1",
                emailAddress: { email: "shared@example.com" },
                contactMechanismType: { name: "EMAIL_ADDRESS" },
                postalAddress: null,
                telecomNumber: null,
              }),
            },
            emailAddress: { findFirst: captureWhere },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      // No DuplicateEntityError should be thrown because the existing match
      // (if any) belongs to a different party — the scope filter excludes it.
      await expect(partyService.addContactMechanism(input)).resolves.toBeDefined();

      // The query must have been scoped to the requesting party via the
      // partyContacts relation, not a tenant-wide findFirst.
      expect(capturedWhere).toBeDefined();
      expect(capturedWhere!.contactMechanism).toEqual(
        expect.objectContaining({
          tenantId: "tenant-1",
          partyContacts: { some: { partyId: "11111111-1111-1111-1111-111111111111" } },
        }),
      );
    });

    it("should throw InvalidTypeValueError when areaCode is missing for telecom", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER" as const,
        telecomNumber: {
          lineNumber: "5551234",
        },
      } as any;

      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-telecom" }),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw InvalidTypeValueError for invalid partyId format", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "not-a-uuid",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "US",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
      await expect(partyService.addContactMechanism(input)).rejects.toThrow("partyId");
    });

    it("should throw MissingSubtypeDataError for empty contactMechanismType", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "",
      } as any;

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw InvalidTypeValueError for unknown contactMechanismType", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "CARRIER_PIGEON" as any,
      };

      // Service now throws early before any DB access for unknown types
      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for country exceeding max length", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "TOOLONG",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for country shorter than the ISO 3166-1 minimum", async () => {
      // Defense-in-depth: the Zod schema and DTO enforce min length 2, but
      // the service is the last line of defense for MCP callers that bypass
      // those layers. A 1-char country like "U" must be rejected here too.
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "U",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(/country must be at least/);
    });

    it("should throw error for email exceeding max length", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: {
          email: `a@${"x".repeat(250)}.com`,
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for addressLine2 exceeding max length", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          addressLine2: "x".repeat(201),
          city: "Anytown",
          country: "US",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for stateProvince exceeding max length", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          stateProvince: "x".repeat(101),
          country: "US",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for postalCode exceeding max length", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          postalCode: "x".repeat(21),
          country: "US",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for countryCode exceeding max length for telecom", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          countryCode: "x".repeat(6),
          areaCode: "415",
          lineNumber: "5551234",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for extension exceeding max length for telecom", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          areaCode: "415",
          lineNumber: "5551234",
          extension: "x".repeat(11),
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should reject countryCode that is not an E.164 country code", async () => {
      // Length check alone accepts arbitrary 5-char strings. The E.164
      // format check rejects values like "abc" or "++++" so a malformed
      // value doesn't get stored verbatim.
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          countryCode: "abc",
          areaCode: "415",
          lineNumber: "5551234",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(/E\.164 country code/);
    });

    it("should reject countryCode that is not an E.164 country code (no + prefix)", async () => {
      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          countryCode: "1",
          areaCode: "415",
          lineNumber: "5551234",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should accept valid E.164 country codes", async () => {
      mockAdminTypes();
      // Real country codes (+1, +44, +81, +86) should all pass validation.
      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-telecom" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            telecomNumber: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            contactMechanism: {
              create: vi.fn().mockResolvedValue({
                contactMechanismId: "contact-telecom-1",
                contactMechanismType: { name: "TELECOM_NUMBER" },
                postalAddress: null,
                telecomNumber: { countryCode: "+44", areaCode: "20", lineNumber: "79461234", extension: null },
                emailAddress: null,
              }),
            },
          };
          return fn(tx);
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          countryCode: "+44",
          areaCode: "20",
          lineNumber: "79461234",
        },
      };

      const result = await partyService.addContactMechanism(input);
      expect(result.telecomNumber?.countryCode).toBe("+44");
    });

    it("should accept whitespace-padded countryCode after trim (defense-in-depth)", async () => {
      mockAdminTypes();
      mockAdminTypes();
      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-telecom" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            telecomNumber: { findFirst: vi.fn().mockResolvedValue(null) },
            contactMechanism: {
              create: vi.fn().mockResolvedValue({
                contactMechanismId: "contact-telecom-2",
                contactMechanismType: { name: "TELECOM_NUMBER" },
                postalAddress: null,
                telecomNumber: { countryCode: "+44", areaCode: "20", lineNumber: "79461234", extension: null },
                emailAddress: null,
              }),
            },
          };
          return fn(tx);
        }),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const input: AddContactMechanismInput = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: {
          countryCode: "  +44  ",
          areaCode: "20",
          lineNumber: "79461234",
        },
      };

      const result = await partyService.addContactMechanism(input);
      expect(result.telecomNumber?.countryCode).toBe("+44");
    });

    it("should scope the telecom duplicate check on countryCode (round-50 fix)", async () => {
      mockAdminTypes();
      // Regression: checkTelecomDuplicate previously matched only on
      // (areaCode, lineNumber), so "+1 555 1234" and "+44 555 1234"
      // collided as the same number. The duplicate check must now include
      // countryCode in the `where` so international numbers are distinguished.
      const captured: Array<Record<string, unknown>> = [];
      const capturedTx = {
        party: { findUnique: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
        telecomNumber: {
          findFirst: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
            captured.push(args.where);
            return null;
          }),
        },
        contactMechanism: {
          create: vi.fn().mockResolvedValue({
            contactMechanismId: "contact-telecom-cc",
            contactMechanismType: { name: "TELECOM_NUMBER" },
            postalAddress: null,
            telecomNumber: { countryCode: "+44", areaCode: "20", lineNumber: "79461234", extension: null },
            emailAddress: null,
          }),
        },
      };
      const mockDb = {
        contactMechanismType: {
          findUnique: vi.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-telecom" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(capturedTx)),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb as unknown as TenantScopedClient);

      await partyService.addContactMechanism({
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        contactMechanismType: "TELECOM_NUMBER",
        telecomNumber: { countryCode: "+44", areaCode: "20", lineNumber: "79461234" },
      });

      expect(captured.length).toBe(1);
      expect(captured[0]).toMatchObject({
        countryCode: "+44",
        areaCode: "20",
        lineNumber: "79461234",
      });
    });
  });

  describe("transaction error handling", () => {
    it("should map Prisma P2002 (unique constraint) to DuplicateEntityError", async () => {
      const mockDb = {
        $transaction: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "6.8.0",
            meta: { target: ["name", "tenantId"] },
          })
        ),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(
        partyService.createParty({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "John Doe",
          person: { firstName: "John", lastName: "Doe" },
        })
      ).rejects.toThrow(DuplicateEntityError);
    });

    it("should map Prisma P2003 (FK violation) to InvalidTypeValueError", async () => {
      const mockDb = {
        $transaction: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Foreign key constraint", {
            code: "P2003",
            clientVersion: "6.8.0",
            meta: { field_name: "partyTypeId" },
          })
        ),
      };
      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(
        partyService.createParty({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "John Doe",
          person: { firstName: "John", lastName: "Doe" },
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });
  });
});
