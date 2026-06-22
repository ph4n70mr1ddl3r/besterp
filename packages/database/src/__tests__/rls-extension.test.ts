// Unit tests for RLS extension functionality.
// Tests tenant validation, Prisma client validation, and proxy behavior.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTenantClient,
  validateTenantIdEnhanced,
  validatePrismaClientForRls
} from "../rls-extension.js";
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
      
      for (const sql of sqlInjections) {
        expect(() => validateTenantIdEnhanced(sql)).toThrow();
      }
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
      
      for (const input of dangerousInputs) {
        expect(() => validateTenantIdEnhanced(input)).toThrow();
      }
    });
  });

  describe("validatePrismaClientForRls", () => {
    it("should accept valid Prisma clients", () => {
      const mockPrisma = {
        $executeRaw: vi.fn(),
        $connect: vi.fn(),
        $disconnect: vi.fn(),
      };
      
      expect(() => validatePrismaClientForRls(mockPrisma as any)).not.toThrow();
    });

    it("should reject null or undefined Prisma clients", () => {
      expect(() => validatePrismaClientForRls(null as any)).toThrow(InvalidTypeValueError);
      expect(() => validatePrismaClientForRls(undefined as any)).toThrow(InvalidTypeValueError);
    });

    it("should reject Prisma clients without $executeRaw method", () => {
      const mockPrisma = {
        $connect: vi.fn(),
        $disconnect: vi.fn(),
      };
      
      expect(() => validatePrismaClientForRls(mockPrisma as any)).toThrow(InvalidTypeValueError);
    });
  });

  describe("createTenantClient", () => {
    let mockPrisma: any;

    beforeEach(() => {
      const tx = {
        $queryRaw: vi.fn(),
        party: { findMany: vi.fn() },
        partyRole: { create: vi.fn() },
      };
      mockPrisma = {
        $executeRaw: vi.fn(),
        $connect: vi.fn(),
        $disconnect: vi.fn(),
        $transaction: vi.fn().mockImplementation((fn, _opts?) => {
          // Must return the result of fn(tx) so wrapping callers
          // (e.g. the proxy's standalone query path) see a real value.
          // Tests that need specific behavior override with
          // mockImplementationOnce — the beforeEach default is a
          // minimal pass-through that returns undefined.
          if (typeof fn === "function") return fn(tx);
          return undefined;
        }),
        party: { findMany: vi.fn() },
        partyRole: { create: vi.fn() },
      } as any;
    });

    it("should create a tenant-scoped client successfully", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(client).toBeDefined();
      expect(typeof client).toBe("object");
    });

    it("should reject invalid tenant IDs during client creation", () => {
      expect(() => createTenantClient(mockPrisma, "")).toThrow();
      expect(() => createTenantClient(mockPrisma, "bad@tenant")).toThrow();
    });

    it("should wrap findMany operations in tenant context", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      // The proxy wraps model ops in $transaction. Mock it to simulate
      // the flow: set tenant context, then delegate to the model.
      mockPrisma.$transaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          party: { findMany: vi.fn().mockResolvedValue([{ partyId: "p1" }]) },
        };
        return fn(tx);
      });
      
      const result = await client.party.findMany();
      expect(result).toEqual([{ partyId: "p1" }]);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should wrap create operations in tenant context", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      mockPrisma.$transaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          partyRole: { create: vi.fn().mockResolvedValue({ partyRoleId: "123", partyId: "party-123", roleTypeId: "role-123", fromDate: new Date(), thruDate: null }) },
        };
        return fn(tx);
      });
      
      const result = await client.partyRole.create({
        data: { partyId: "party-123", roleTypeId: "role-123" }
      });
      
      expect(result).toBeDefined();
      expect(result.partyRoleId).toBe("123");
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should handle interactive transactions correctly", async () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      // The proxy wraps $transaction to inject SET LOCAL before the callback.
      // The callback should NOT need to call $queryRaw itself — the proxy does it.
      mockPrisma.$transaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          party: { findMany: vi.fn().mockResolvedValue([]) },
          partyRole: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });
      
      const result = await client.$transaction(async (tx) => {
        await tx.party.findMany();
        await tx.partyRole.create({ data: {} });
        return "success";
      });
      
      expect(result).toBe("success");
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should block dangerous methods on tenant-scoped client", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      
      // These methods are blocked to prevent connection lifecycle changes
      // and RLS bypass via raw SQL on the tenant-scoped proxy
      expect(() => client.$connect).toThrow(/Cannot call/);
      expect(() => client.$disconnect).toThrow(/Cannot call/);
      expect(() => client.$queryRaw).toThrow(/Cannot call/);
      expect(() => client.$executeRaw).toThrow(/Cannot call/);
      expect(() => client.$queryRawUnsafe).toThrow(/Cannot call/);
      expect(() => client.$executeRawUnsafe).toThrow(/Cannot call/);
      // Unknown $ methods should also be blocked
      expect(() => (client as any).$metrics).toThrow(/Cannot call/);
    });

    it("should block underscore-prefixed internal properties", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(() => (client as any)._dmmf).toThrow(/Cannot access/);
      expect(() => (client as any)._engineConfig).toThrow(/Cannot access/);
    });

    it("should block property assignment on tenant-scoped client", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(() => { (client as any).party = {}; }).toThrow(/Cannot set/);
    });

    it("should block property deletion on tenant-scoped client", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(() => delete (client as any).party).toThrow(/Cannot delete/);
    });

    it("should block property assignment on a model delegate (e.g. db.party)", () => {
      // Inner Proxy traps: without set/deleteProperty on the model delegate,
      // `scoped.party.someField = "x"` would silently mutate the underlying
      // shared model delegate (since all tenant-scoped clients share the
      // same _appClient). This polluted the delegate across tenants.
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(() => { (client.party as any).someField = "x"; }).toThrow(
        /Cannot set 'someField' on model 'party'/
      );
    });

    it("should block property deletion on a model delegate", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");
      expect(() => { delete (client.party as any).findMany; }).toThrow(
        /Cannot delete 'findMany' on model 'party'/
      );
    });

    it("should reject batch transactions on tenant-scoped client", () => {
      const client = createTenantClient(mockPrisma, "tenant-1");

      const operations = [
        mockPrisma.party.findMany(),
        mockPrisma.partyRole.create({ data: {} }),
      ];

      expect(() => client.$transaction(operations)).toThrow(
        /Batch \$transaction\(\[\.\.\.promises\]\) is not supported/
      );
    });
  });

  describe("Error handling", () => {
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        $executeRaw: vi.fn(),
        $connect: vi.fn(),
        $disconnect: vi.fn(),
        $transaction: vi.fn(),
        party: { findMany: vi.fn() },
      } as any;
    });

    it("should provide detailed error messages for invalid tenant IDs", () => {
      expect.assertions(3);
      expect(() => createTenantClient(mockPrisma, "bad@tenant#123")).toThrow(InvalidTypeValueError);
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
        $connect: vi.fn(),
        $disconnect: vi.fn(),
        // Missing $executeRaw
      } as any;
      
      expect(() => createTenantClient(invalidPrisma, "tenant-1")).toThrow(InvalidTypeValueError);
    });
  });
});