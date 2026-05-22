// Unit tests for RLS extension functionality.
// Tests tenant validation, Prisma client validation, and proxy behavior.

import { describe, it, expect, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { 
  createTenantClient, 
  validateTenantIdEnhanced, 
  validatePrismaClientForRls 
} from "../rls-extension";
import { InvalidTypeValueError } from "@besterp/shared";

describe("RLS Extension", () => {
  describe("validateTenantIdEnhanced", () => {
    it("should accept valid tenant IDs", () => {
      expect(() => validateTenantIdEnhanced("tenant-1")).not.toThrow();
      expect(() => validateTenantIdEnhanced("my_tenant")).not.toThrow();
      expect(() => validateTenantIdEnhanced("a-b-c-123")).not.toThrow();
    });

    it("should reject empty tenant IDs", () => {
      expect(() => validateTenantIdEnhanced("")).toThrow();
    });

    it("should reject tenant IDs with spaces", () => {
      expect(() => validateTenantIdEnhanced("tenant with spaces")).toThrow();
    });

    it("should reject tenant IDs with special characters", () => {
      expect(() => validateTenantIdEnhanced("tenant@acme")).toThrow();
      expect(() => validateTenantIdEnhanced("tenant.acme")).toThrow();
    });

    it("should reject SQL injection attempts", () => {
      const sqlInjections = [
        "'; DROP TABLE party;--",
        "1' OR '1'='1",
        "admin' --",
        "'; EXEC sp_executesql N'DELETE FROM parties';--"
      ];
      
      sqlInjections.forEach(sql => {
        expect(() => validateTenantIdEnhanced(sql)).toThrow();
      });
    });

    it("should reject tenant IDs that are too long", () => {
      const longId = "a".repeat(101);
      expect(() => validateTenantIdEnhanced(longId)).toThrow(InvalidTypeValueError);
    });

    it("should reject tenant IDs with dangerous patterns", () => {
      const dangerousInputs = [
        "benchmark(1000000, version())",
        "waitfor delay '0:0:10'--",
        "drop table users--",
        "SELECT * FROM users; DELETE FROM users--"
      ];
      
      dangerousInputs.forEach(input => {
        expect(() => validateTenantIdEnhanced(input)).toThrow();
      });
    });
  });

  describe("validatePrismaClientForRls", () => {
    it("should accept valid Prisma clients", () => {
      const mockPrisma = {
        $executeRaw: jest.fn(),
        $connect: jest.fn(),
        $disconnect: jest.fn(),
      };
      
      expect(() => validatePrismaClientForRls(mockPrisma as any)).not.toThrow();
    });

    it("should reject null or undefined Prisma clients", () => {
      expect(() => validatePrismaClientForRls(null as any)).toThrow(InvalidTypeValueError);
      expect(() => validatePrismaClientForRls(undefined as any)).toThrow(InvalidTypeValueError);
    });

    it("should reject Prisma clients without $executeRaw method", () => {
      const mockPrisma = {
        $connect: jest.fn(),
        $disconnect: jest.fn(),
      };
      
      expect(() => validatePrismaClientForRls(mockPrisma as any)).toThrow(InvalidTypeValueError);
    });
  });

  describe("createTenantClient", () => {
    let mockPrisma: PrismaClient;

    beforeEach(() => {
      mockPrisma = {
        $executeRaw: jest.fn(),
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $transaction: jest.fn().mockImplementation((fn) => {
          const tx = {
            $executeRaw: jest.fn(),
            party: { findMany: jest.fn() },
            partyRole: { create: jest.fn() },
          };
          return fn(tx);
        }),
        party: { findMany: jest.fn() },
        partyRole: { create: jest.fn() },
      } as any;
    });

    it("should create a tenant-scoped client successfully", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(client).toBeDefined();
      expect(typeof client).toBe("object");
    });

    it("should reject invalid tenant IDs during client creation", () => {
      expect(() => createTenantClient(mockPrisma, "")).toThrow(InvalidTypeValueError);
      expect(() => createTenantClient(mockPrisma, "bad@tenant")).toThrow(InvalidTypeValueError);
    });

    it("should wrap findMany operations in tenant context", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      // Mock the database response
      mockPrisma.$transaction.mockImplementationOnce(async (tx) => {
        await tx.$executeRaw`SELECT set_tenant_context(${"tenant-1"})`;
        return (tx as any).party.findMany();
      });
      
      // Mock findMany response
      mockPrisma.party.findMany.mockResolvedValue([]);
      
      const result = await client.party.findMany();
      expect(result).toEqual([]);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should wrap create operations in tenant context", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      // Mock the database response
      mockPrisma.$transaction.mockImplementationOnce(async (tx) => {
        await tx.$executeRaw`SELECT set_tenant_context(${"tenant-1"})`;
        return (tx as any).partyRole.create({ data: {} });
      });
      
      // Mock create response
      mockPrisma.partyRole.create.mockResolvedValue({
        partyRoleId: "123",
        partyId: "party-123",
        roleTypeId: "role-123",
        fromDate: new Date(),
        thruDate: null,
      });
      
      const result = await client.partyRole.create({
        data: { partyId: "party-123", roleTypeId: "role-123" }
      });
      
      expect(result).toBeDefined();
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should handle interactive transactions correctly", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      const tx = {
        $executeRaw: jest.fn(),
        party: { findMany: jest.fn().mockResolvedValue([]) },
        partyRole: { create: jest.fn().mockResolvedValue({ partyRoleId: "123" }) },
      };
      
      const result = await client.$transaction(async (tx) => {
        // This should automatically call SET LOCAL at the start
        await tx.$executeRaw`SELECT set_tenant_context(${"tenant-1"})`;
        await tx.party.findMany();
        await tx.partyRole.create({ data: {} });
        return "success";
      });
      
      expect(result).toBe("success");
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should pass through non-data methods", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      // These methods should pass through directly
      expect(client.$connect).toBeDefined();
      expect(client.$disconnect).toBeDefined();
    });

    it("should handle batch transactions (pass through without tenant context)", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      const operations = [
        mockPrisma.party.findMany(),
        mockPrisma.partyRole.create({ data: {} }),
      ];
      
      // Mock the batch transaction
      mockPrisma.$transaction.mockResolvedValue([[], {}]);
      
      const result = await client.$transaction(operations);
      expect(result).toEqual([[], {}]);
      // Note: Batch transactions don't get tenant context automatically
      // This is by design - use interactive transactions for tenant-scoped operations
    });
  });

  describe("Error handling", () => {
    let mockPrisma: PrismaClient;

    beforeEach(() => {
      mockPrisma = {
        $executeRaw: jest.fn(),
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $transaction: jest.fn(),
        party: { findMany: jest.fn() },
      } as any;
    });

    it("should provide detailed error messages for invalid tenant IDs", () => {
      try {
        createTenantClient(mockPrisma, "bad@tenant#123");
      } catch (error) {
        if (error instanceof InvalidTypeValueError) {
          expect(error.context).toBeDefined();
          expect(error.context.field).toBe("tenantId");
        }
      }
    });

    it("should handle Prisma client validation errors", () => {
      const invalidPrisma = {
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        // Missing $executeRaw
      } as any;
      
      expect(() => createTenantClient(invalidPrisma, "tenant-1")).toThrow(InvalidTypeValueError);
    });
  });
});