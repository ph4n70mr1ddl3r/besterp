// Unit tests for PartyService.
// Tests business logic, validation, error handling, and edge cases.
// Uses mocked PrismaService to avoid database dependencies.

import { Test, TestingModule } from "@nestjs/testing";
import { PartyService } from "./party.service";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  MissingSubtypeDataError,
  InvalidTypeValueError,
  DuplicateEntityError,
  EntityNotFoundError,
} from "@besterp/shared";

describe("PartyService", () => {
  let service: PartyService;
  let prisma: PrismaService;

  const mockPrisma = {
    tenantScoped: jest.fn(),
    admin: {
      roleType: { findFirst: jest.fn() },
      contactMechanismType: { findFirst: jest.fn() },
      partyType: { findFirst: jest.fn() },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartyService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<PartyService>(PartyService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("createParty", () => {
    it("should create a person party successfully", async () => {
      const mockDb = {
        partyType: { findFirst: jest.fn().mockResolvedValue({ partyTypeId: "1" }) },
        $transaction: jest.fn().mockImplementation((fn) => fn(mockDb)),
        party: {
          create: jest.fn().mockResolvedValue({
            partyId: "123",
            name: "John Doe",
            partyType: { name: "PERSON" },
            person: { firstName: "John", lastName: "Doe" },
            roles: [],
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.createParty({
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "John Doe",
        person: { firstName: "John", lastName: "Doe" },
      });

      expect(result.name).toBe("John Doe");
      expect(result.person?.firstName).toBe("John");
      mockDb.party.create.mockCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "John Doe",
            person: expect.objectContaining({ firstName: "John", lastName: "Doe" }),
          }),
        })
      );
    });

    it("should create an organization party successfully", async () => {
      const mockDb = {
        partyType: { findFirst: jest.fn().mockResolvedValue({ partyTypeId: "2" }) },
        $transaction: jest.fn().mockImplementation((fn) => fn(mockDb)),
        party: {
          create: jest.fn().mockResolvedValue({
            partyId: "456",
            name: "Acme Corp",
            partyType: { name: "ORGANIZATION" },
            organization: { legalName: "Acme Corporation" },
            roles: [],
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.createParty({
        tenantId: "tenant-1",
        partyType: "ORGANIZATION",
        name: "Acme Corp",
        organization: { legalName: "Acme Corporation" },
      });

      expect(result.name).toBe("Acme Corp");
      expect(result.organization?.legalName).toBe("Acme Corporation");
    });

    it("should throw error when partyType is PERSON but person data is missing", async () => {
      await expect(
        service.createParty({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "John Doe",
          // Missing person data
        })
      ).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error when partyType is ORGANIZATION but organization data is missing", async () => {
      await expect(
        service.createParty({
          tenantId: "tenant-1",
          partyType: "ORGANIZATION",
          name: "Acme Corp",
          // Missing organization data
        })
      ).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error when name is empty", async () => {
      await expect(
        service.createParty({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "",
          person: { firstName: "John", lastName: "Doe" },
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error when firstName is empty for person", async () => {
      await expect(
        service.createParty({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "John Doe",
          person: { firstName: "", lastName: "Doe" },
        })
      ).rejects.toThrow(MissingSubtypeDataError);
    });

    it("should throw error when lastName is empty for person", async () => {
      await expect(
        service.createParty({
          tenantId: "tenant-1",
          partyType: "PERSON",
          name: "John Doe",
          person: { firstName: "John", lastName: "" },
        })
      ).rejects.toThrow(MissingSubtypeDataError);
    });
  });

  describe("searchParties", () => {
    it("should search parties with filters", async () => {
      const mockDb = {
        party: {
          findMany: jest.fn().mockResolvedValue([
            { partyId: "123", name: "Test Party", partyType: { name: "PERSON" }, roles: [] },
          ]),
          count: jest.fn().mockResolvedValue(1),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.searchParties({
        tenantId: "tenant-1",
        name: "Test",
        partyType: "PERSON",
        limit: 10,
        offset: 0,
      });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it("should handle pagination limits correctly", async () => {
      const mockDb = {
        party: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(100),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.searchParties({
        tenantId: "tenant-1",
        limit: 600, // Should be clamped to 500
        offset: 0,
      });

      expect(result.limit).toBe(500); // Should be clamped
    });

    it("should handle negative offset correctly", async () => {
      const mockDb = {
        party: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.searchParties({
        tenantId: "tenant-1",
        limit: 10,
        offset: -5, // Should be normalized to 0
      });

      expect(result.offset).toBe(0);
    });
  });

  describe("addPartyRole", () => {
    it("should add a role to a party successfully", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue({ partyId: "123" }) },
        roleType: { findFirst: jest.fn().mockResolvedValue({ roleTypeId: "1" }) },
        $transaction: jest.fn().mockImplementation((fn) => fn(mockDb)),
        partyRole: {
          create: jest.fn().mockResolvedValue({
            partyRoleId: "role-123",
            partyId: "123",
            roleType: { name: "Customer" },
            fromDate: new Date(),
            thruDate: null,
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.addPartyRole({
        tenantId: "tenant-1",
        partyId: "123",
        roleType: "Customer",
      });

      expect(result.roleTypeName).toBe("Customer");
      expect(result.partyId).toBe("123");
    });

    it("should throw error when roleType is empty", async () => {
      await expect(
        service.addPartyRole({
          tenantId: "tenant-1",
          partyId: "123",
          roleType: "",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error when party does not exist", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      await expect(
        service.addPartyRole({
          tenantId: "tenant-1",
          partyId: "999",
          roleType: "Customer",
        })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("should throw error when role type does not exist", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue({ partyId: "123" }) },
        roleType: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      await expect(
        service.addPartyRole({
          tenantId: "tenant-1",
          partyId: "123",
          roleType: "InvalidRole",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error when party already has active role", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue({ partyId: "123" }) },
        roleType: { findFirst: jest.fn().mockResolvedValue({ roleTypeId: "1" }) },
        partyRole: {
          findFirst: jest.fn().mockResolvedValue({
            partyRoleId: "existing-role",
            thruDate: null,
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      await expect(
        service.addPartyRole({
          tenantId: "tenant-1",
          partyId: "123",
          roleType: "Customer",
        })
      ).rejects.toThrow(DuplicateEntityError);
    });
  });

  describe("addContactMechanism", () => {
    it("should add a postal address successfully", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue({ partyId: "123" }) },
        contactMechanismType: { findFirst: jest.fn().mockResolvedValue({ contactMechanismTypeId: "1" }) },
        $transaction: jest.fn().mockImplementation((fn) => fn(mockDb)),
        contactMechanism: {
          create: jest.fn().mockResolvedValue({
            contactMechanismId: "addr-123",
            contactMechanismType: { name: "POSTAL_ADDRESS" },
            postalAddress: {
              addressLine1: "123 Main St",
              addressLine2: "Apt 4",
              city: "Anytown",
              stateProvince: "CA",
              postalCode: "12345",
              country: "US",
            },
            partyContacts: { create: { partyId: "123" } },
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.addContactMechanism({
        tenantId: "tenant-1",
        partyId: "123",
        contactMechanismType: "POSTAL_ADDRESS",
        postalAddress: {
          addressLine1: "123 Main St",
          addressLine2: "Apt 4",
          city: "Anytown",
          stateProvince: "CA",
          postalCode: "12345",
          country: "US",
        },
      });

      expect(result.contactMechanismType).toBe("POSTAL_ADDRESS");
      expect(result.postalAddress?.addressLine1).toBe("123 Main St");
    });

    it("should add an email address successfully", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue({ partyId: "123" }) },
        contactMechanismType: { findFirst: jest.fn().mockResolvedValue({ contactMechanismTypeId: "2" }) },
        $transaction: jest.fn().mockImplementation((fn) => fn(mockDb)),
        contactMechanism: {
          create: jest.fn().mockResolvedValue({
            contactMechanismId: "email-123",
            contactMechanismType: { name: "EMAIL_ADDRESS" },
            emailAddress: { email: "test@example.com" },
            partyContacts: { create: { partyId: "123" } },
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.addContactMechanism({
        tenantId: "tenant-1",
        partyId: "123",
        contactMechanismType: "EMAIL_ADDRESS",
        emailAddress: { email: "test@example.com" },
      });

      expect(result.contactMechanismType).toBe("EMAIL_ADDRESS");
      expect(result.emailAddress?.email).toBe("test@example.com");
    });

    it("should throw error when email format is invalid", async () => {
      await expect(
        service.addContactMechanism({
          tenantId: "tenant-1",
          partyId: "123",
          contactMechanismType: "EMAIL_ADDRESS",
          emailAddress: { email: "invalid-email" },
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("should throw error when required postal address fields are missing", async () => {
      await expect(
        service.addContactMechanism({
          tenantId: "tenant-1",
          partyId: "123",
          contactMechanismType: "POSTAL_ADDRESS",
          postalAddress: {
            addressLine1: "", // Empty should cause error
            city: "Anytown",
            country: "US",
          },
        })
      ).rejects.toThrow(MissingSubtypeDataError);
    });
  });

  describe("getParty", () => {
    it("should get a party by ID successfully", async () => {
      const mockDb = {
        party: {
          findFirst: jest.fn().mockResolvedValue({
            partyId: "123",
            name: "Test Party",
            partyType: { name: "PERSON" },
            person: { firstName: "John", lastName: "Doe" },
            roles: [],
          }),
        },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      const result = await service.getParty("tenant-1", "123");

      expect(result.partyId).toBe("123");
      expect(result.name).toBe("Test Party");
    });

    it("should throw error when party is not found", async () => {
      const mockDb = {
        party: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      mockPrisma.tenantScoped.mockReturnValue(mockDb);

      await expect(
        service.getParty("tenant-1", "999")
      ).rejects.toThrow(EntityNotFoundError);
    });
  });
});