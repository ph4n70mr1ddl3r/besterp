// Unit tests for PartyService
// Tests business logic for party operations with various scenarios

import { describe, it, expect, beforeEach, jest } from "vitest";
import { PartyService } from "./party.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { CreatePartyInput, SearchPartiesInput } from "./party.types.js";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyError,
} from "@besterp/shared";

// Mock PrismaService
const mockPrismaService = {
  tenantScoped: jest.fn(),
} as any;

describe("PartyService", () => {
  let partyService: PartyService;

  beforeEach(() => {
    jest.clearAllMocks();
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
          findFirst: jest.fn().mockResolvedValue({ partyTypeId: "pt-person" }),
        },
        $transaction: jest.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              create: jest.fn().mockResolvedValue({
                partyId: "party-123",
                partyTypeId: "pt-person",
                tenantId: "tenant-1",
                name: "John Doe",
                person: { firstName: "John", lastName: "Doe" },
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);

      expect(result.partyId).toBe("party-123");
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
          findFirst: jest.fn().mockResolvedValue({ partyTypeId: "pt-org" }),
        },
        $transaction: jest.fn().mockImplementation(async (fn) => {
          const tx = {
            party: {
              create: jest.fn().mockResolvedValue({
                partyId: "org-123",
                partyTypeId: "pt-org",
                tenantId: "tenant-1",
                name: "Acme Corp",
                organization: { legalName: "Acme Corporation" },
              }),
            },
          };
          return fn(tx);
        }),
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.createParty(input);

      expect(result.partyId).toBe("org-123");
      expect(result.name).toBe("Acme Corp");
      expect(result.organization?.legalName).toBe("Acme Corporation");
    });

    it("should throw error for missing person data", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        // Missing person data
      };

      await expect(partyService.createParty(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error for missing organization data", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        // Missing organization data
      };

      await expect(partyService.createParty(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error for invalid party type", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "INVALID_TYPE",
        name: "Test Party",
      };

      const mockDb = {
        partyType: {
          findFirst: jest.fn().mockResolvedValue(null), // Party type not found
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

    it("should validate required person fields", async () => {
      const input: CreatePartyInput = {
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: {
          firstName: "",
          lastName: "Doe",
        }, // Empty first name
      };

      await expect(partyService.createParty(input)).rejects.toThrow(MissingSubtypeDataError);
    });
  });

  describe("getParty", () => {
    it("should return party when found", async () => {
      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue({
            partyId: "party-123",
            partyTypeId: "pt-person",
            tenantId: "tenant-1",
            name: "John Doe",
            person: { firstName: "John", lastName: "Doe" },
          }),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.getParty("tenant-1", "party-123");

      expect(result.partyId).toBe("party-123");
      expect(result.name).toBe("John Doe");
    });

    it("should throw error when party not found", async () => {
      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue(null), // Party not found
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.getParty("tenant-1", "nonexistent")).rejects.toThrow(EntityNotFoundError);
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
          count: jest.fn().mockResolvedValue(2),
          findMany: jest.fn().mockResolvedValue([
            {
              partyId: "party-1",
              partyTypeId: "pt-person",
              tenantId: "tenant-1",
              name: "John Doe",
              person: { firstName: "John", lastName: "Doe" },
            },
            {
              partyId: "party-2",
              partyTypeId: "pt-person",
              tenantId: "tenant-1",
              name: "John Smith",
              person: { firstName: "John", lastName: "Smith" },
            },
          ]),
        },
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
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
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
        limit: 1000, // Exceeds max
        offset: -1, // Invalid offset
      };

      const mockDb = {
        party: {
          count: jest.fn().mockResolvedValue(1),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      const result = await partyService.searchParties(input);

      expect(result.limit).toBe(500); // Should be clamped to max
      expect(result.offset).toBe(0); // Should be set to 0
    });
  });

  describe("addPartyRole", () => {
    it("should add role to party successfully", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "party-123",
        roleType: "Customer",
      };

      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue({ partyId: "party-123" }),
        },
        roleType: {
          findFirst: jest.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        partyRole: {
          findFirst: jest.fn().mockResolvedValue(null), // No existing role
        },
        $transaction: jest.fn().mockImplementation(async (fn) => {
          const tx = {
            partyRole: {
              create: jest.fn().mockResolvedValue({
                partyRoleId: "role-123",
                partyId: "party-123",
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

      const result = await partyService.addPartyRole(input);

      expect(result.partyRoleId).toBe("role-123");
      expect(result.roleTypeName).toBe("Customer");
    });

    it("should throw error for duplicate role", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "party-123",
        roleType: "Customer",
      };

      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue({ partyId: "party-123" }),
        },
        roleType: {
          findFirst: jest.fn().mockResolvedValue({ roleTypeId: "rt-customer" }),
        },
        partyRole: {
          findFirst: jest.fn().mockResolvedValue({
            partyRoleId: "existing-role",
            partyId: "party-123",
            roleTypeId: "rt-customer",
            fromDate: new Date(),
            thruDate: null, // Active role
          }),
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addPartyRole(input)).rejects.toThrow(DuplicateEntityError);
    });

    it("should throw error for invalid role type", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "party-123",
        roleType: "InvalidRole",
      };

      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue({ partyId: "party-123" }),
        },
        roleType: {
          findFirst: jest.fn().mockResolvedValue(null), // Role type not found
        },
      };

      mockPrismaService.tenantScoped.mockReturnValue(mockDb);

      await expect(partyService.addPartyRole(input)).rejects.toThrow(InvalidTypeValueError);
    });
  });

  describe("addContactMechanism", () => {
    it("should add postal address successfully", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "party-123",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          city: "Anytown",
          country: "US",
        },
      };

      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue({ partyId: "party-123" }),
        },
        contactMechanismType: {
          findFirst: jest.fn().mockResolvedValue({ contactMechanismTypeId: "cmt-postal" }),
        },
        $transaction: jest.fn().mockImplementation(async (fn) => {
          const tx = {
            contactMechanism: {
              create: jest.fn().mockResolvedValue({
                contactMechanismId: "contact-123",
                contactMechanismTypeId: "cmt-postal",
                postalAddress: {
                  addressLine1: "123 Main St",
                  city: "Anytown",
                  country: "US",
                },
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
        partyId: "party-123",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          // Missing required fields
          city: "Anytown",
          country: "US",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should validate email format", async () => {
      const input = {
        tenantId: "tenant-1",
        partyId: "party-123",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: {
          email: "invalid-email",
        },
      };

      await expect(partyService.addContactMechanism(input)).rejects.toThrow(InvalidTypeValueError);
    });
  });
});