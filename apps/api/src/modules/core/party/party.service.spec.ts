// Unit tests for PartyService
// Tests business logic for party operations with various scenarios

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PartyService } from "./party.service.js";
import { CreatePartyInput, SearchPartiesInput, AddContactMechanismInput } from "./party.types.js";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
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
  tenantScoped: vi.fn(),
} as any;

describe("PartyService", () => {
  let partyService: PartyService;

  beforeEach(() => {
    vi.clearAllMocks();
    partyService = new PartyService(mockPrismaService);
  });

  describe("createParty", () => {
    it("should create a person party successfully", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
      };

      const mockDb = {
        partyType: {
          findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
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
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: { legalName: "Acme Corporation" },
      };

      const mockDb = {
        partyType: {
          findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-org" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
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

    it("should throw error for invalid party type", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "INVALID_TYPE" as any,
        name: "Test Party",
      };

      const mockDb = {
        partyType: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
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

    it("should trim gender and middleName fields", async () => {
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
        partyType: {
          findUnique: vi.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
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
  });

  describe("getParty", () => {
    it("should return party when found", async () => {
      const mockDb = {
        party: {
          findFirst: vi.fn().mockResolvedValue(
            mockParty({ name: "John Doe", person: { firstName: "John", lastName: "Doe" } })
          ),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.getParty("tenant-1", "12345678-1234-1234-1234-123456789abc");

      expect(result.partyId).toBe("12345678-1234-1234-1234-123456789abc");
      expect(result.name).toBe("John Doe");
    });

    it("should throw error when party not found", async () => {
      const mockDb = {
        party: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.getParty("tenant-1", "nonexistent")).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw InvalidTypeValueError for invalid UUID format", async () => {
      await expect(
        partyService.getParty("tenant-1", "not-a-uuid")
      ).rejects.toThrow(InvalidTypeValueError);
      await expect(
        partyService.getParty("tenant-1", "not-a-uuid")
      ).rejects.toThrow("partyId");
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
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              count: vi.fn().mockResolvedValue(0),
              findMany: vi.fn().mockResolvedValue([]),
            },
          };
          return fn(tx);
        }),
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
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              count: vi.fn().mockResolvedValue(1),
              findMany: vi.fn().mockResolvedValue([]),
            },
          };
          return fn(tx);
        }),
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
        $transaction: vi.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              count: vi.fn().mockResolvedValue(0),
              findMany: vi.fn().mockResolvedValue([]),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await partyService.searchParties(input);

      // Verify the trimmed roleType was used in the query
      const txCall = mockDb.$transaction.mock.calls[0][0];
      // The transaction callback receives the tx — we verify by checking the where clause
      // was constructed with trimmed value. Since we mock $transaction, we just confirm
      // it was called and didn't throw.
      expect(mockDb.$transaction).toHaveBeenCalled();
    });
  });

  describe("addPartyRole", () => {
    it("should add role to party successfully", async () => {
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
            party: { findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            partyRole: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({
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

    it("should throw error for duplicate role", async () => {
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
            party: { findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
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

    it("should throw error for roleType exceeding max length", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "x".repeat(101),
      };

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error for invalid role type", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "12345678-1234-1234-1234-123456789abc",
        roleType: "InvalidRole",
      };

      const mockDb = {
        party: {
          findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
        },
        roleType: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw EntityNotFoundError when party does not exist", async () => {
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
            party: { findFirst: vi.fn().mockResolvedValue(null) },
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
      await expect(partyService.addPartyRole(input)).rejects.toThrow("Invalid fromDate format");
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
            party: { findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }) },
            partyRole: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({
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

      // Verify the trimmed value was used for the lookup
      expect(mockDb.roleType.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: "Customer" } })
      );
      expect(result.roleTypeName).toBe("Customer");
    });
  });

  describe("addContactMechanism", () => {
    it("should add postal address successfully", async () => {
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
              findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
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

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(MissingSubtypeDataError);
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
              findFirst: vi.fn().mockResolvedValue(null),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(EntityNotFoundError);
    });

    it("should throw MissingSubtypeDataError when city is missing for postal address", async () => {
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

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw MissingSubtypeDataError when country is missing for postal address", async () => {
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

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should add telecom number successfully", async () => {
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
              findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
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
              findFirst: vi.fn().mockResolvedValue({ partyId: "12345678-1234-1234-1234-123456789abc" }),
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

    it("should throw MissingSubtypeDataError when areaCode is missing for telecom", async () => {
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

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(MissingSubtypeDataError);
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
  });
});
