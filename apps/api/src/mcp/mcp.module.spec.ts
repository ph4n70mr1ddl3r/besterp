// Unit tests for McpModule — buildContext validation
// Tests tenant ID validation, userId validation, and service injection

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpModule } from "./mcp.module.js";
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
      ).toThrow(InvalidTypeValueError);
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
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "   ",
        })
      ).toThrow("userId is required");
    });

    it("should reject overly long userId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "x".repeat(201),
        })
      ).toThrow("userId is too long");
    });

    it("should accept userId at max length", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "x".repeat(200),
      });
      expect(ctx.userId).toBe("x".repeat(200));
    });

    it("should trim userId before storing", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "  user-1  ",
      });
      expect(ctx.userId).toBe("user-1");
    });

    it("should reject whitespace-only agentId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "   ",
        })
      ).toThrow("agentId cannot be whitespace-only");
    });

    it("should reject whitespace-only conversationId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "   ",
        })
      ).toThrow("conversationId cannot be whitespace-only");
    });

    it("should normalise empty-string agentId to undefined", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "",
      });
      expect(ctx.agentId).toBeUndefined();
    });

    it("should normalise empty-string conversationId to undefined", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        conversationId: "",
      });
      expect(ctx.conversationId).toBeUndefined();
    });

    it("should normalise empty-string idempotencyKey to undefined", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: "",
      });
      expect(ctx.idempotencyKey).toBeUndefined();
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
      ).toThrow(InvalidTypeValueError);
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

    it("should trim idempotency key before storing", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: "  my-key  ",
      });
      expect(ctx.idempotencyKey).toBe("my-key");
    });

    it("should reject whitespace-only idempotencyKey", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "   ",
        })
      ).toThrow("idempotencyKey cannot be whitespace-only");
    });

    it("should reject overly long agentId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
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

    it("should trim agentId before storing", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "  my-agent  ",
      });
      expect(ctx.agentId).toBe("my-agent");
    });

    it("should reject overly long conversationId", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
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

    it("should trim conversationId before storing", () => {
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        conversationId: "  my-conv  ",
      });
      expect(ctx.conversationId).toBe("my-conv");
    });

    it("should reject non-string agentId with a structured error", () => {
      // Defensive: a forged or malformed request could pass a number,
      // boolean, or object instead of a string. Without the typeof guard,
      // .trim() would throw a raw TypeError and surface as INTERNAL_ERROR.
      // The type guard returns the structured INVALID_TYPE_VALUE instead.
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: 42 as unknown as string,
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: 42 as unknown as string,
        })
      ).toThrow(/agentId must be a string/);
    });

    it("should reject non-string idempotencyKey with a structured error", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: { not: "a string" } as unknown as string,
        })
      ).toThrow(/idempotencyKey must be a string/);
    });

    it("should reject non-string conversationId with a structured error", () => {
      expect(() =>
        mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: true as unknown as string,
        })
      ).toThrow(/conversationId must be a string/);
    });

    it("should normalise null agentId to undefined", () => {
      // JavaScript callers might pass null instead of undefined; treat
      // both as "not provided" so downstream code never sees a null agentId.
      const ctx = mcpModule.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: null as unknown as string,
      });
      expect(ctx.agentId).toBeUndefined();
    });

    describe("reasoning field", () => {
      it("should accept a valid reasoning string", () => {
        const ctx = mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "Because the user requested it",
        });
        expect(ctx.reasoning).toBe("Because the user requested it");
      });

      it("should reject non-string reasoning with a structured error", () => {
        expect(() =>
          mcpModule.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: 42 as unknown as string,
          })
        ).toThrow(InvalidTypeValueError);
        expect(() =>
          mcpModule.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: 42 as unknown as string,
          })
        ).toThrow(/reasoning must be a string/);
      });

      it("should reject reasoning exceeding max length", () => {
        expect(() =>
          mcpModule.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: "x".repeat(2001),
          })
        ).toThrow(InvalidTypeValueError);
        expect(() =>
          mcpModule.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: "x".repeat(2001),
          })
        ).toThrow("reasoning is too long");
      });

      it("should normalise whitespace-only reasoning to undefined", () => {
        const ctx = mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "   ",
        });
        expect(ctx.reasoning).toBeUndefined();
      });

      it("should trim reasoning before storing", () => {
        const ctx = mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "  my reasoning  ",
        });
        expect(ctx.reasoning).toBe("my reasoning");
      });

      it("should normalise null reasoning to undefined", () => {
        const ctx = mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: null as unknown as string,
        });
        expect(ctx.reasoning).toBeUndefined();
      });

      it("should accept reasoning at max length", () => {
        const ctx = mcpModule.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "x".repeat(2000),
        });
        expect(ctx.reasoning).toBe("x".repeat(2000));
      });
    });

    describe("getRegistry", () => {
      it("should return a ToolRegistry instance", () => {
        const registry = mcpModule.getRegistry();
        expect(registry).toBeDefined();
        expect(registry.names).toBeDefined();
      });
    });
  });
});
