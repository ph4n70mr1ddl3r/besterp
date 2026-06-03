// Unit tests for McpModule — buildContext validation
// Tests tenant ID validation, userId validation, and service injection

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpModule } from "../../../../apps/api/src/mcp/mcp.module.js";
import { InvalidTypeValueError } from "@besterp/shared";

// McpModule depends on PrismaService + PartyService.
// We mock them minimally so onModuleInit doesn't crash.
function createMcpModule() {
  const mockPrisma = {
    admin: {},
    tenantScoped: vi.fn(),
    appClient: { $connect: vi.fn() },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    onModuleInit: vi.fn(),
    onModuleDestroy: vi.fn(),
  } as any;

  const mockPartyService = {} as any;

  // We can't easily instantiate McpModule directly because of NestJS DI,
  // so we test buildContext logic by instantiating with constructor args.
  // McpModule's constructor takes (prisma, partyService).
  const module = new McpModule(mockPrisma, mockPartyService);

  // Suppress onModuleInit logging
  vi.spyOn(module as any, "logger", "get").mockReturnValue({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

  return module;
}

describe("McpModule", () => {
  let mcpModule: McpModule;

  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress onModuleInit from running registry logic
    vi.spyOn(McpModule.prototype, "onModuleInit").mockImplementation(() => {});
    mcpModule = createMcpModule();
  });

  describe("buildContext", () => {
    it("should build context with valid inputs", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-abc",
        userId: "user-123",
        agentId: "agent-1",
        conversationId: "conv-1",
        idempotencyKey: "key-1",
      });

      expect(ctx.tenantId).toBe("tenant-abc");
      expect(ctx.userId).toBe("user-123");
      expect(ctx.agentId).toBe("agent-1");
      expect(ctx.conversationId).toBe("conv-1");
      expect(ctx.idempotencyKey).toBe("key-1");
      expect(ctx.services).toHaveProperty("partyService");
    });

    it("should reject invalid tenant ID", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "invalid@tenant",
          userId: "user-123",
        })
      ).toThrow();
    });

    it("should reject empty tenant ID", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "",
          userId: "user-123",
        })
      ).toThrow();
    });

    it("should reject SQL injection in tenant ID", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "'; DROP TABLE party;--",
          userId: "user-123",
        })
      ).toThrow();
    });

    it("should reject overly long tenant ID", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "a".repeat(101),
          userId: "user-123",
        })
      ).toThrow(InvalidTypeValueError);
    });

    it("should reject missing userId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "",
        })
      ).toThrow("userId is required");
    });

    it("should reject whitespace-only userId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "   ",
        })
      ).toThrow("userId is required");
    });

    it("should accept optional fields as undefined", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
      });

      expect(ctx.agentId).toBeUndefined();
      expect(ctx.conversationId).toBeUndefined();
      expect(ctx.idempotencyKey).toBeUndefined();
    });

    it("should reject overly long idempotency key", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "x".repeat(501),
        })
      ).toThrow("idempotencyKey is too long");
    });

    it("should accept idempotency key at max length", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: "x".repeat(500),
      });
      expect(ctx.idempotencyKey).toBe("x".repeat(500));
    });

    it("should reject overly long agentId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "x".repeat(201),
        })
      ).toThrow("agentId is too long");
    });

    it("should accept agentId at max length", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "x".repeat(200),
      });
      expect(ctx.agentId).toBe("x".repeat(200));
    });

    it("should reject overly long conversationId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "x".repeat(201),
        })
      ).toThrow("conversationId is too long");
    });

    it("should accept conversationId at max length", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        conversationId: "x".repeat(200),
      });
      expect(ctx.conversationId).toBe("x".repeat(200));
    });
  });
});
