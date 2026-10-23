// Unit tests for SecurityService
// Tests business logic for user and agent registry operations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SecurityService } from "./security.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  DuplicateEntityError,
  MAX_ALLOWED_ENTITY_TYPES_LENGTH,
} from "@besterp/shared";

/** A canonical party UUID — `partyId` is `Party`'s UUID primary key. */
const PARTY_ID = "12345678-1234-1234-1234-123456789abc";

// A syntactically valid bcrypt digest ($2b$ + cost + 53 base64 chars).
// `create_user` validates the SHAPE of the hash, so the fixtures must use a
// real digest rather than an arbitrary string.
const BCRYPT_HASH = "$2b$12$01234567890123456789012345678901234567890123456789012";
// A syntactically valid argon2id digest.
const ARGON2_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

function createMockPrisma() {
  // The agent registry is a TENANT-SCOPED table with RLS enabled, so it is
  // accessed through the tenant-scoped client — the SAME delegate instances
  // are exposed under `admin` so the existing assertions keep working, and
  // `tenantScoped` is a spy so a test can assert WHICH client was used.
  const agentRegistry = {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  };
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
      agentRegistry,
    }),
    admin: {
      agentRegistry,
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
        service.createUser({ tenantId: "", partyId: PARTY_ID, passwordHash: "hash" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("validates partyId format", async () => {
      await expect(
        service.createUser({ tenantId: "t1", partyId: "", passwordHash: "hash" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a partyId that is not a UUID", async () => {
      // `partyId` is `Party`'s UUID primary key. The column is TEXT, so the
      // database would accept a malformed value and every lookup would simply
      // miss — the caller has to get the actionable "must be a valid UUID"
      // error instead of a confusing ENTITY_NOT_FOUND.
      await expect(
        service.createUser({ tenantId: "t1", partyId: "not-a-uuid", passwordHash: "hash" })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed partyId in queries", async () => {
      const mockTenantClient = {
        party: { findUnique: vi.fn().mockResolvedValue({ tenantId: "t1" }) },
        user: { create: vi.fn().mockResolvedValue({ userId: "u1", partyId: PARTY_ID, tenantId: "t1", lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() }) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await service.createUser({ tenantId: "t1", partyId: ` ${PARTY_ID} `, passwordHash: BCRYPT_HASH });
      expect(mockTenantClient.party.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { partyId: PARTY_ID } })
      );
    });

    it("rejects a PLAINTEXT password instead of persisting it as the hash", async () => {
      // `create_user` is the ONLY write path to `user.password_hash` — the
      // only credential store in the schema — and it accepted any non-empty
      // string up to 255 characters. A mistaken or prompt-injected agent
      // could therefore persist "hunter2" verbatim into the credential
      // column and the tool still reported `success: true`.
      const mockTenantClient = {
        party: { findUnique: vi.fn().mockResolvedValue({ tenantId: "t1" }) },
        user: { create: vi.fn() },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await expect(
        service.createUser({ tenantId: "t1", partyId: PARTY_ID, passwordHash: "hunter2" })
      ).rejects.toThrow(InvalidTypeValueError);
      expect(mockTenantClient.user.create).not.toHaveBeenCalled();
    });

    it("accepts an argon2 digest", async () => {
      const mockTenantClient = {
        party: { findUnique: vi.fn().mockResolvedValue({ tenantId: "t1" }) },
        user: { create: vi.fn().mockResolvedValue({ userId: "u1", partyId: PARTY_ID, tenantId: "t1", lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() }) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await expect(
        service.createUser({ tenantId: "t1", partyId: PARTY_ID, passwordHash: ARGON2_HASH })
      ).resolves.toBeDefined();
    });

    it("maps P2002 to appropriate error", async () => {
      const err = { code: "P2002" };
      prisma.tenantScoped.mockReturnValue({
        party: { findUnique: vi.fn().mockResolvedValue({ tenantId: "t1" }) },
        user: { create: vi.fn().mockRejectedValue(err) },
      });

      await expect(
        service.createUser({ tenantId: "t1", partyId: PARTY_ID, passwordHash: BCRYPT_HASH })
      ).rejects.toThrow();
    });
  });

  describe("getUser", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.getUser("", PARTY_ID)
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed partyId in queries", async () => {
      const mockTenantClient = {
        user: { findUnique: vi.fn().mockResolvedValue({ userId: "u1", partyId: PARTY_ID, tenantId: "t1", lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() }) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await service.getUser("t1", ` ${PARTY_ID} `);
      expect(mockTenantClient.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId_partyId: { tenantId: "t1", partyId: PARTY_ID } } })
      );
    });

    it("returns EntityNotFoundError when user not found", async () => {
      const mockTenantClient = {
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      const err = await service.getUser("t1", PARTY_ID).catch((e) => e);
      expect(err).toBeInstanceOf(EntityNotFoundError);
      expect(err.suggestedTools).toEqual(["get_user", "search_parties"]);
    });

    it("maps DB errors via handleTransactionError", async () => {
      const dbErr = { code: "P2025" };
      const mockTenantClient = {
        user: { findUnique: vi.fn().mockRejectedValue(dbErr) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      // P2025 should map to EntityNotFoundError, not be swallowed
      await expect(service.getUser("t1", PARTY_ID))
        .rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("updateLastLogin", () => {
    it("validates tenantId format", async () => {
      await expect(
        service.updateLastLogin("", PARTY_ID)
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("uses trimmed partyId in queries", async () => {
      const mockTenantClient = {
        user: { update: vi.fn().mockResolvedValue(undefined) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await service.updateLastLogin("t1", ` ${PARTY_ID} `);
      expect(mockTenantClient.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId_partyId: { tenantId: "t1", partyId: PARTY_ID } } })
      );
    });

    it("does not throw on DB errors (non-fatal)", async () => {
      const mockTenantClient = {
        user: { update: vi.fn().mockRejectedValue(new Error("db error")) },
      };
      prisma.tenantScoped.mockReturnValue(mockTenantClient);

      await expect(service.updateLastLogin("t1", PARTY_ID)).resolves.toBeUndefined();
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

    it("reports a Decimal maxTransactionAmount as a number", async () => {
      // Regression: the column is a Prisma `Decimal?`, which the driver
      // returns as an OBJECT. The old `typeof value === "number"` check was
      // therefore never true and EVERY agent result reported
      // `maxTransactionAmount: null` — the agent could not verify that a
      // financial restriction had been applied.
      prisma.admin.agentRegistry.create.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: ["read"], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5,
        maxTransactionAmount: { toNumber: () => 250.5, toString: () => "250.5" },
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      const agent = await service.registerAgent({
        agentId: "a1", tenantId: "t1", displayName: "Agent",
        description: "Desc", capabilities: ["read"], version: "1.0.0",
      });

      expect(agent.maxTransactionAmount).toBe(250.5);
    });

    it("rejects an allowedEntityTypes array that exceeds the cap", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
          capabilities: ["read"], version: "1.0.0",
          allowedEntityTypes: Array.from({ length: MAX_ALLOWED_ENTITY_TYPES_LENGTH + 1 }, (_, i) => `entity-${i}`),
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("maps P2002 to DuplicateEntityError", async () => {      prisma.admin.agentRegistry.create.mockRejectedValue({ code: "P2002", meta: { target: ["agent_id", "tenant_id"] } });

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

    it("rejects out-of-range maxConcurrentConversations on register", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["read"], version: "1.0.0",
          maxConcurrentConversations: 0,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a maxConcurrentConversations above 100 on register", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["read"], version: "1.0.0",
          maxConcurrentConversations: 101,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a negative maxTransactionAmount on register", async () => {
      await expect(
        service.registerAgent({
          agentId: "a1", tenantId: "t1", displayName: "Agent",
          description: "Desc", capabilities: ["read"], version: "1.0.0",
          maxTransactionAmount: -1,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("suggests register_agent for out-of-range maxConcurrentConversations on register", async () => {
      const err = await service.registerAgent({
        agentId: "a1", tenantId: "t1", displayName: "Agent",
        description: "Desc", capabilities: ["read"], version: "1.0.0",
        maxConcurrentConversations: 0,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect(err.suggestedTools).toEqual(["register_agent"]);
    });

    it("suggests register_agent for negative maxTransactionAmount on register", async () => {
      const err = await service.registerAgent({
        agentId: "a1", tenantId: "t1", displayName: "Agent",
        description: "Desc", capabilities: ["read"], version: "1.0.0",
        maxTransactionAmount: -1,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect(err.suggestedTools).toEqual(["register_agent"]);
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
        expect.objectContaining({ where: { agentId_tenantId: { agentId: "a1", tenantId: "t1" } } })
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

    it("rejects non-string capability elements on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", capabilities: [1 as unknown as string],
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects whitespace-only capability elements on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", capabilities: ["  "],
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects non-string allowedEntityType elements on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", allowedEntityTypes: [null as unknown as string],
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects out-of-range maxToolCallsPerConversation on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", maxToolCallsPerConversation: 0,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects out-of-range rateLimitPerMinute on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", rateLimitPerMinute: 2000,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("suggests update_agent for invalid capability type on update", async () => {
      const err = await service.updateAgent({
        agentId: "a1", tenantId: "t1", capabilities: [1 as unknown as string],
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect(err.suggestedTools).toEqual(["update_agent"]);
    });

    it("suggests update_agent for out-of-range maxToolCallsPerConversation on update", async () => {
      const err = await service.updateAgent({
        agentId: "a1", tenantId: "t1", maxToolCallsPerConversation: 0,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect(err.suggestedTools).toEqual(["update_agent"]);
    });

    it("allows updating maxToolCallsPerConversation without touching rateLimitPerMinute", async () => {
      prisma.admin.agentRegistry.update.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: ["read"], maxToolCallsPerConversation: 50,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 30, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      // Previously the ?? 0 default on the unprovided field caused a false
      // range failure (0 < 1). This test verifies the fix.
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", maxToolCallsPerConversation: 50,
        })
      ).resolves.toBeDefined();
    });

    it("allows updating rateLimitPerMinute without touching maxToolCallsPerConversation", async () => {
      prisma.admin.agentRegistry.update.mockResolvedValue({
        agentId: "a1", tenantId: "t1", displayName: "Agent", description: "Desc",
        capabilities: ["read"], maxToolCallsPerConversation: 100,
        maxConcurrentConversations: 5, maxTransactionAmount: 0,
        allowedEntityTypes: [], rateLimitPerMinute: 60, version: "1.0.0",
        isActive: true, createdAt: new Date(),
      });

      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", rateLimitPerMinute: 60,
        })
      ).resolves.toBeDefined();
    });

    it("rejects out-of-range maxConcurrentConversations on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", maxConcurrentConversations: 0,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a maxConcurrentConversations above 100 on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", maxConcurrentConversations: 101,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("rejects a negative maxTransactionAmount on update", async () => {
      await expect(
        service.updateAgent({
          agentId: "a1", tenantId: "t1", maxTransactionAmount: -1,
        })
      ).rejects.toThrow(InvalidTypeValueError);
    });

    it("suggests update_agent for out-of-range maxConcurrentConversations on update", async () => {
      const err = await service.updateAgent({
        agentId: "a1", tenantId: "t1", maxConcurrentConversations: 0,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect(err.suggestedTools).toEqual(["update_agent"]);
    });

    it("suggests update_agent for negative maxTransactionAmount on update", async () => {
      const err = await service.updateAgent({
        agentId: "a1", tenantId: "t1", maxTransactionAmount: -1,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect(err.suggestedTools).toEqual(["update_agent"]);
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
        where: { agentId_tenantId: { agentId: "a1", tenantId: "t1" } },
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
        where: { agentId_tenantId: { agentId: "a1", tenantId: "t1" } },
      });
    });

    it("returns EntityNotFoundError when agent not found", async () => {
      prisma.admin.agentRegistry.findUnique.mockResolvedValue(null);

      const err = await service.getAgent("t1", "a1").catch((e) => e);
      expect(err).toBeInstanceOf(EntityNotFoundError);
      expect(err.suggestedTools).toEqual(["describe_agent", "list_agents"]);
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

describe("SecurityService — agent registry uses the RLS-enforced client", () => {
  it("reads and writes agent_registry through the tenant-scoped client", async () => {
    // Regression guard: `agent_registry` is a tenant-scoped table with RLS
    // enabled and forced (rls-setup.sql) and it is listed among the tables
    // whose RLS the boot-time verification checks. Accessing it through the
    // ADMIN (superuser) client bypasses RLS entirely, so its tenant
    // isolation rested only on the explicit `tenantId` filter at each call
    // site — while the SAME file used the tenant-scoped client for the other
    // tenant tables (`party`, `user`).
    const prisma = createMockPrisma();
    const service = new SecurityService(prisma as unknown as import("../../../prisma/prisma.service.js").PrismaService);

    prisma.tenantScoped.mockReturnValue({
      party: { findUnique: vi.fn() },
      user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      agentRegistry: {
        create: vi.fn().mockResolvedValue({
          agentId: "a1", tenantId: "t1", displayName: "Agent", description: "An agent",
          capabilities: [], maxToolCallsPerConversation: 100, maxConcurrentConversations: 5,
          maxTransactionAmount: 0, allowedEntityTypes: [], rateLimitPerMinute: 30,
          version: "1", isActive: true, createdAt: new Date("2026-01-01"),
        }),
        update: vi.fn(),
        delete: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
    });

    await service.registerAgent({
      agentId: "a1",
      tenantId: "t1",
      displayName: "Agent",
      description: "An agent",
      capabilities: ["list_agents"],
      version: "1",
    });

    expect(prisma.tenantScoped).toHaveBeenCalledWith("t1");
  });
});
