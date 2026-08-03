import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpService } from "./mcp.service.js";
import { DomainError, InvalidTypeValueError } from "@besterp/shared";

function createMcpService() {
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

  const service = new McpService(mockPrisma, mockPartyService);

  return service;
}

describe("McpService", () => {
  let mcpService: McpService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(McpService.prototype, "onModuleInit").mockImplementation(() => Promise.resolve());
    mcpService = createMcpService();
  });

  describe("buildContext", () => {
    it("should build context with valid inputs", () => {
      const ctx = mcpService.buildContext({
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
        mcpService.buildContext({
          tenantId: "invalid@tenant",
          userId: "user-123",
        })
      ).toThrow();
    });

    it("should reject null tenant ID", () => {
      // typeof null === "object", so the string check catches it before trim.
      expect(() =>
        mcpService.buildContext({
          tenantId: null as unknown as string,
          userId: "user-123",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: null as unknown as string,
          userId: "user-123",
        })
      ).toThrow(/tenantId must be a string/);
    });

    it("should reject empty tenant ID", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "",
          userId: "user-123",
        })
      ).toThrow();
    });

    it("should reject SQL injection in tenant ID", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "'; DROP TABLE party;--",
          userId: "user-123",
        })
      ).toThrow();
    });

    it("should reject overly long tenant ID", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "a".repeat(101),
          userId: "user-123",
        })
      ).toThrow(DomainError);
    });

    it("should reject missing userId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "",
        })
      ).toThrow("userId must not be empty or whitespace-only");
    });

    it("should reject null userId", () => {
      // typeof null === "object", so the string check catches it before trim.
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: null as unknown as string,
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: null as unknown as string,
        })
      ).toThrow(/userId must be a string/);
    });

    it("should reject whitespace-only userId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "   ",
        })
      ).toThrow("userId must not be empty or whitespace-only");
    });

    it("should reject overly long userId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "x".repeat(201),
        })
      ).toThrow("userId is too long");
    });

    it("should reject userId with invalid characters (security guard)", () => {
      // Regression: userId must be validated for character set at the MCP auth
      // boundary so payloads like "user; DROP TABLE..." never reach durable
      // sinks, matching the same guard in TenantGuard and ToolRegistry.
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user;DROP TABLE",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user@evil",
        })
      ).toThrow(InvalidTypeValueError);
    });

    it("should accept userId at max length", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "x".repeat(200),
      });
      expect(ctx.userId).toBe("x".repeat(200));
    });

    it("should trim userId before storing", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "  user-1  ",
      });
      expect(ctx.userId).toBe("user-1");
    });

    it("should strip HTML and preserve raw identity values (sanitization happens at durable-sink surfaces)", () => {
      // userId/agentId/conversationId are format-validated at the buildContext
      // boundary but NOT sanitized there — sanitization runs at the durable
      // sinks (audit-log, idempotency) so the identity fields remain usable
      // for correlation/auditing while secrets are still scrubbed before
      // persistence. `buildContext` only strips HTML to prevent stored-XSS
      // in the raw identity value; secret redaction is deferred to the sinks.
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "us-sk_live_realsecret123",
        agentId: "agent-a-password-hidden",
        conversationId: "conv_123_session-token",
        reasoning: "r<iframe src=evil>",
      });
      // userId is returned raw (validated, not sanitized) so downstream
      // tool-registry.validateContextIdentity can still match its charset.
      expect(ctx.userId).toBe("us-sk_live_realsecret123");
      // agentId is HTML-stripped but not secret-sanitized at buildContext.
      expect(ctx.agentId).toBe("agent-a-password-hidden");
      // conversationId is HTML-stripped but not secret-sanitized at buildContext.
      expect(ctx.conversationId).toBe("conv_123_session-token");
      // reasoning is content (not identity), so it IS sanitized at buildContext.
      expect(ctx.reasoning).not.toContain("<iframe>");
    });

    it("should reject agentId with invalid characters before sanitization", () => {
      // agentId must match TENANT_ID_PATTERN at the auth boundary so control
      // chars or injected payloads never reach durable sinks. Invalid chars
      // are rejected BEFORE sanitizeForLogOutput runs (matching userId).
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "agent; DROP TABLE",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "agent<42>",
        })
      ).toThrow(InvalidTypeValueError);
    });

    it("should reject conversationId with invalid characters before sanitization", () => {
      // Same charset gate as userId and agentId — prevents control chars or
      // injected payloads from reaching durable sinks via conversationId.
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "conv; DROP TABLE",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "conv<42>",
        })
      ).toThrow(InvalidTypeValueError);
    });

    it("should reject userId with invalid characters before sanitization", () => {
      // Pattern check runs BEFORE sanitization, so a userId containing < >
      // (which stripHtmlTags would remove) is rejected outright rather than
      // being silently accepted after sanitization rewrites the value.
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user<42>api",
        })
      ).toThrow("userId contains invalid characters");
    });

    it("should preserve ULID identity IDs (must not mangle them into [REDACTED_TOKEN])", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "usr_01H3X8Q5Y2GX4K1A2B3C4D5E6F",
        agentId: "agent_01H3X8Q5Y2GX4K1A2B3C4D5E6F",
        conversationId: "01H3X8Q5Y2GX4K1A2B3C4D5E6F",
        idempotencyKey: "key_01H3X8Q5Y2GX4K1A2B3C4D5E6F",
      });
      expect(ctx.userId).toBe("usr_01H3X8Q5Y2GX4K1A2B3C4D5E6F");
      expect(ctx.agentId).toBe("agent_01H3X8Q5Y2GX4K1A2B3C4D5E6F");
      expect(ctx.conversationId).toBe("01H3X8Q5Y2GX4K1A2B3C4D5E6F");
      expect(ctx.idempotencyKey).toBe("key_01H3X8Q5Y2GX4K1A2B3C4D5E6F");
    });

    it("should redact secret shapes in reasoning at the boundary (not just downstream)", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        reasoning: "connect to postgres://u:p@db:5432/x?api_key=sk_live_abc123",
      });
      expect(ctx.reasoning).not.toContain("sk_live_abc123");
      expect(ctx.reasoning).not.toContain("postgres://");
      expect(ctx.reasoning).not.toContain("api_key");
      expect(ctx.reasoning).toMatch(/\[DATABASE_URL\]|\[REDACTED\]/);
    });

    it("should reject whitespace-only agentId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "   ",
        })
      ).toThrow("agentId cannot be whitespace-only");
    });

    it("should reject whitespace-only conversationId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "   ",
        })
      ).toThrow("conversationId cannot be whitespace-only");
    });

    it("should normalise empty-string agentId to undefined", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "",
      });
      expect(ctx.agentId).toBeUndefined();
    });

    it("should normalise empty-string conversationId to undefined", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        conversationId: "",
      });
      expect(ctx.conversationId).toBeUndefined();
    });

    it("should normalise empty-string idempotencyKey to undefined", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: "",
      });
      expect(ctx.idempotencyKey).toBeUndefined();
    });

    it("should accept optional fields as undefined", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
      });

      expect(ctx.agentId).toBeUndefined();
      expect(ctx.conversationId).toBeUndefined();
      expect(ctx.idempotencyKey).toBeUndefined();
    });

    it("should reject overly long idempotency key", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "x".repeat(501),
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "x".repeat(501),
        })
      ).toThrow("idempotencyKey is too long");
    });

    it("should accept idempotency key at max length", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: "x".repeat(500),
      });
      expect(ctx.idempotencyKey).toBe("x".repeat(500));
    });

    it("should trim idempotency key before storing", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: "  my-key  ",
      });
      expect(ctx.idempotencyKey).toBe("my-key");
    });

    it("should reject a non-printable-ASCII idempotency key at the boundary", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "key\nwith\tnewline",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "key-with-émoji",
        })
      ).toThrow(/idempotencyKey must contain only printable ASCII/);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "key-with-émoji",
        })
      ).toThrow(InvalidTypeValueError);
    });

    it("should reject whitespace-only idempotencyKey", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "   ",
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: "   ",
        })
      ).toThrow("idempotencyKey cannot be whitespace-only");
    });

    it("should reject overly long agentId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "x".repeat(201),
        })
      ).toThrow("agentId is too long");
    });

    it("should accept agentId at max length", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "x".repeat(200),
      });
      expect(ctx.agentId).toBe("x".repeat(200));
    });

    it("should trim agentId before storing", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "  my-agent  ",
      });
      expect(ctx.agentId).toBe("my-agent");
    });

    it("should reject overly long conversationId", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: "x".repeat(201),
        })
      ).toThrow("conversationId is too long");
    });

    it("should accept conversationId at max length", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        conversationId: "x".repeat(200),
      });
      expect(ctx.conversationId).toBe("x".repeat(200));
    });

    it("should trim conversationId before storing", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        conversationId: "  my-conv  ",
      });
      expect(ctx.conversationId).toBe("my-conv");
    });

    it("should reject non-string agentId with a structured error", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: 42 as unknown as string,
        })
      ).toThrow(InvalidTypeValueError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: 42 as unknown as string,
        })
      ).toThrow(/agentId must be a string/);
    });

    it("should reject non-string idempotencyKey with a structured error", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: { not: "a string" } as unknown as string,
        })
      ).toThrow(/idempotencyKey must be a string/);
    });

    it("should reject non-string conversationId with a structured error", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: true as unknown as string,
        })
      ).toThrow(/conversationId must be a string/);
    });

    it("should normalise null agentId to undefined", () => {
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: null as unknown as string,
      });
      expect(ctx.agentId).toBeUndefined();
    });

    describe("reasoning field", () => {
      it("should accept a valid reasoning string", () => {
        const ctx = mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "Because the user requested it",
        });
        expect(ctx.reasoning).toBe("Because the user requested it");
      });

      it("should reject non-string reasoning with a structured error", () => {
        const callWithType = () =>
          mcpService.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: 42 as unknown as string,
          });
        expect(callWithType).toThrow(InvalidTypeValueError);
        expect(callWithType).toThrow(/reasoning must be a string/);
      });

      it("should reject reasoning exceeding max length", () => {
        const callWithLongReasoning = () =>
          mcpService.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: "x".repeat(2001),
          });
        expect(callWithLongReasoning).toThrow(InvalidTypeValueError);
        expect(callWithLongReasoning).toThrow("reasoning is too long");
      });

      it("should reject whitespace-only reasoning", () => {
        expect(() =>
          mcpService.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: "   ",
          })
        ).toThrow(InvalidTypeValueError);
        expect(() =>
          mcpService.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: "   ",
          })
        ).toThrow("reasoning cannot be whitespace-only");
      });

      it("should trim reasoning before storing", () => {
        const ctx = mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "  my reasoning  ",
        });
        expect(ctx.reasoning).toBe("my reasoning");
      });

      it("should normalise null reasoning to undefined", () => {
        const ctx = mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: null as unknown as string,
        });
        expect(ctx.reasoning).toBeUndefined();
      });

      it("should accept reasoning at max length", () => {
        const ctx = mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          reasoning: "x".repeat(2000),
        });
        expect(ctx.reasoning).toBe("x".repeat(2000));
      });
    });
  });

  describe("getRegistry", () => {
    it("should return a ToolRegistry instance", () => {
      const registry = mcpService.getRegistry();
      expect(registry).toBeDefined();
      expect(registry.names).toBeDefined();
    });
  });
});
