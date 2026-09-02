// Unit tests for SecurityService
// Tests business logic for user and agent registry operations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SecurityService } from "./security.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  DuplicateEntityError,
} from "@besterp/shared";

function createMockPrisma() {
  return {
    tenantScoped: vi.fn().mockReturnValue({
      party: {
        findUnique: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    }),
    admin: {
      agentRegistry: {
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
    },
  };
}

describe("SecurityService", () => {
  let service: SecurityService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new SecurityService(prisma as unknown as import("../../../prisma/prisma.service.js").PrismaService);
  });

  describe("createUser", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.createUser({ tenantId: "", partyId: "p1", passwordHash: "hash" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates partyId format", async () => {
      await expect(
        service.createUser({ tenantId: "t1", partyId: "", passwordHash: "hash" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed partyId in queries", async () => {
      const mockTenantClient = {
        party: { findUnique: vi.fn().mockResolvedValue({ tenantId: "t1" }) },
        user: { create: vi.fn().mockResolvedValue({ userId: "u1", partyId: "p1", tenantId: "t1", lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() }) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await service.createUser({ tenantId: "t1", partyId: " p1 ", passwordHash: "hash" });
      expect(mockTenantClient.party.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { partyId: "p1" } })
      );
    });

    it("maps P2002 to appropriate error", async () => {
      const err = { code: "P2002" };
      prisma.tenantScoped.mockReturnValue({
        party: { findUnique: vi.fn().mockResolvedValue({ tenantId: "t1" }) },
        user: { create: vi.fn().mockRejectedValue(err) },
      });

      await expect(
        service.createUser({ tenantId: "t1", partyId: "p1", passwordHash: "hash" })
      ).rejects.toThrow();
    });
  });

  describe("getUser", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.getUser("", "p1")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed partyId in queries", async () => {
      const mockTenantClient = {
        user: { findUnique: vi.fn().mockResolvedValue({ userId: "u1", partyId: "p1", tenantId: "t1", lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() }) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await service.getUser("t1", " p1 ");
      expect(mockTenantClient.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId_partyId: { tenantId: "t1", partyId: "p1" } } })
      );
    });

    it("returns EntityNotFoundError when user not found", async () => {
      const mockTenantClient = {
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await expect(service.getUser("t1", "p1"))
        .rejects.toThrow(EntityNotFoundError);
    });

    it("maps DB errors via handleTransactionError", async () => {
      const dbErr = { code: "P2025" };
      const mockTenantClient = {
        user: { findUnique: vi.fn().mockRejectedValue(dbErr) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      // P2025 should map to EntityNotFoundError, not be swallowed
      await expect(service.getUser("t1", "p1"))
        .rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("updateLastLogin", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.updateLastLogin("", "p1")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed partyId in queries", async () => {
      const mockTenantClient = {
        user: { update: vi.fn().mockResolvedValue(undefined) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await service.updateLastLogin("t1", " p1 ");
      expect(mockTenantClient.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId_partyId: { tenantId: "t1", partyId: "p1" } } })
      );
    });

    it("does not throw on DB errors (non-fatal)", async () => {
      const mockTenantClient = {
        user: { update: vi.fn().mockRejectedValue(new Error("db error")) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await expect(service.updateLastLogin("t1", "p1")).resolves.toBeUndefined();
    });
  });

  describe("registerAgent", () => {
    it("validates agentId format", async () => {
      await expect(
        service.registerAgent({
          agentId: "", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["read"], version: "1.0.0",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates tenantId format", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "", displayName: "Agent",
          description: "Desc", capabilities: ["read"], version: "1.0.0",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed values in create query", async () => {
      prisma.admin.agentRegistry.create.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: ["read"], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await service.registerAgent({
        agentId: " a1 ", tenantId: " t1 ", displayName: "Agent",
        description: "Desc", capabilities: ["read"], version: "1.0.0",
      });

      expect(prisma.admin.agentRegistry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentId: "a1", tenantId: "t1" }),
        })
      );
    });

    it("maps P2002 to DuplicateEntityError", async () => {
      prisma.admin.agentRegistry.create.mockRejectedValue({ code: "P2002", meta: { target: ["agent_id"] } });

      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["read"], version: "1.0.0",
        })
      ).rejects.toThrow(DuplicateEntityError);
    });

    it("rejects non-string capability elements", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: [1 as unknown as string], version: "1.0.0",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects whitespace-only capability elements", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["  "], version: "1.0.0",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-string allowedEntityType elements", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["read"], allowedEntityTypes: [null as unknown as string], version: "1.0.0",
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });
  });

  describe("updateAgent", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.updateAgent({ agentId: "a1", tenantId: "", displayName: "Updated" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed agentId in queries", async () => {
      prisma.admin.agentRegistry.update.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Updated", description: "Desc",
        capabilities: ["read"], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await service.updateAgent({ agentId: " a1 ", tenantId: "t1", displayName: "Updated" });
      expect(prisma.admin.agentRegistry.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agentId: "a1", tenantId: "t1" } })
      );
    });

    it("maps P2025 to EntityNotFoundError", async () => {
      prisma.admin.agentRegistry.update.mockRejectedValue({ code: "P2025" });

      await expect(
        service.updateAgent({ agentId: "a1", tenantId: "t1", displayName: "Updated" })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("sanitizes HTML in displayName", async () => {
      prisma.admin.agentRegistry.update.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: [], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await service.updateAgent({ agentId: "a1", tenantId: "t1", displayName: "<script>x</script>Agent" });
      expect(prisma.admin.agentRegistry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ displayName: "Agent" }),
        })
      );
    });

    it("sanitizes HTML in description", async () => {
      prisma.admin.agentRegistry.update.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: [], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await service.updateAgent({ agentId: "a1", tenantId: "t1", description: "<b>desc</b>" });
      expect(prisma.admin.agentRegistry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ description: "desc" }),
        })
      );
    });

    it("sanitizes HTML in version", async () => {
      prisma.admin.agentRegistry.update.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: [], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await service.updateAgent({ agentId: "a1", tenantId: "t1", version: "<b>v1.0.0</b>" });
      expect(prisma.admin.agentRegistry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: "v1.0.0" }),
        })
      );
    });
  });

  describe("deleteAgent", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.deleteAgent("", "a1")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed agentId in queries", async () => {
      prisma.admin.agentRegistry.delete.mockResolvedValue(undefined);

      await service.deleteAgent("t1", " a1 ");
      expect(prisma.admin.agentRegistry.delete).toHaveBeenCalledWith({
        where: { agentId: "a1", tenantId: "t1" },
      });
    });

    it("maps P2025 to EntityNotFoundError", async () => {
      prisma.admin.agentRegistry.delete.mockRejectedValue({ code: "P2025" });

      await expect(service.deleteAgent("t1", "a1"))
        .rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("getAgent", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.getAgent("", "a1")
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed agentId in queries", async () => {
      prisma.admin.agentRegistry.findUnique.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: ["read"], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await service.getAgent("t1", " a1 ");
      expect(prisma.admin.agentRegistry.findUnique).toHaveBeenCalledWith({
        where: { agentId: "a1", tenantId: "t1" },
      });
    });

    it("returns EntityNotFoundError when agent not found", async () => {
      prisma.admin.agentRegistry.findUnique.mockResolvedValue(null);

      await expect(service.getAgent("t1", "a1"))
        .rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("searchAgents", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.searchAgents({ tenantId: "" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("clamps limit and offset", async () => {
      prisma.admin.agentRegistry.count.mockResolvedValue(5);
      prisma.admin.agentRegistry.findMany.mockResolvedValue([]);

      const result = await service.searchAgents({ tenantId: "t1", limit: 999, offset: 99999 });
      expect(result.limit).toBe(500);
      // offset 99999 clamped to MAX_SEARCH_OFFSET (10000)
      expect(result.offset).toBe(10000);
      expect(result.hasMore).toBe(false);
      expect(prisma.admin.agentRegistry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10000, take: 500 })
      );
    });

    it("uses validated pagination in queries", async () => {
      prisma.admin.agentRegistry.count.mockResolvedValue(10);
      prisma.admin.agentRegistry.findMany.mockResolvedValue([]);

      await service.searchAgents({ tenantId: "t1", limit: 10, offset: 5 });
      expect(prisma.admin.agentRegistry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 10 })
      );
    });

    it("runs count before findMany (sequential, not parallel)", async () => {
      const countFn = prisma.admin.agentRegistry.count;
      const findManyFn = prisma.admin.agentRegistry.findMany;
      countFn.mockResolvedValue(5);
      findManyFn.mockResolvedValue([]);

      await service.searchAgents({ tenantId: "t1" });
      // Verify sequential: count should have been called before findMany
      expect(countFn).toHaveBeenCalledBefore(findManyFn);
    });

    it("rejects NaN limit with InvalidTypeValueError", async () => {
      await expect(
        service.searchAgents({ tenantId: "t1", limit: NaN, offset: 0 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-integer limit with InvalidTypeValueError", async () => {
      await expect(
        service.searchAgents({ tenantId: "t1", limit: 12.5, offset: 0 })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects Infinity offset with InvalidTypeValueError", async () => {
      await expect(
        service.searchAgents({ tenantId: "t1", limit: 10, offset: Infinity })
      ).rejects.toThrow(InvalidTypeValueError);
    });
  });
});
