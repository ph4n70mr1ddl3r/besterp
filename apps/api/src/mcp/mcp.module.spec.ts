import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpService } from "./mcp.service.js";
import { DomainError, InvalidTypeValueError, InvalidTenantIdError } from "@besterp/shared";

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
  const mockSecurityService = {} as any;
  const mockProductService = {} as any;

  const service = new McpService(mockPrisma, mockPartyService, mockSecurityService, mockProductService);

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
      // typeof null === "object", so validateTenantIdEnhanced throws InvalidTenantIdError.
      expect(() =>
        mcpService.buildContext({
          tenantId: null as unknown as string,
          userId: "user-123",
        })
      ).toThrow(InvalidTenantIdError);
      expect(() =>
        mcpService.buildContext({
          tenantId: null as unknown as string,
          userId: "user-123",
        })
      ).toThrow(/Tenant ID must be a non-empty string/);
    });

    it("should reject empty tenant ID", () => {
      // Pin the same contract as the null case above: "".trim() is "" which
      // fails the non-empty check as InvalidTenantIdError, not any error.
      expect(() =>
        mcpService.buildContext({
          tenantId: "",
          userId: "user-123",
        })
      ).toThrow(InvalidTenantIdError);
      expect(() =>
        mcpService.buildContext({
          tenantId: "",
          userId: "user-123",
        })
      ).toThrow(/Tenant ID must be a non-empty string/);
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
      ).toThrow("'userId' must not be empty or whitespace-only");
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
      ).toThrow(/'userId' must be a string/);
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
      ).toThrow("'userId' must not be empty or whitespace-only");
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
      ).toThrow("'userId' exceeds maximum length of");
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
          userId: "user\nname",
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

    it("should return raw identity values unchanged (length-validated, never rewritten) and sanitize reasoning", () => {
      // userId/agentId/conversationId are length-validated at the buildContext
      // boundary but NOT rewritten there — values that survive the length
      // gate pass through verbatim, and sanitization runs at the durable sinks
      // (audit-log, idempotency) so identity fields remain usable for
      // correlation while any secret-shaped content is still scrubbed before
      // Pattern validation for userId uses OPTIONAL_ID_PATTERN, consistent with
      // JwtAuthGuard and TenantGuard. This allows real-world identifiers like
      // "john.doe" or "user+role" that TENANT_ID_PATTERN would reject.
      // There is NO HTML-stripping step for identity fields: a value
      // containing control characters is REJECTED by the pattern check
      // (control chars are excluded by OPTIONAL_ID_PATTERN), while printable
      // ASCII passes through verbatim for the registry to evaluate.
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "us-sk_live_realsecret123",
        agentId: "agent.a-password-hidden",
        conversationId: "conv_123_session-token",
        reasoning: "r<iframe src=evil>",
      });
      // Identity fields are returned raw (length-validated, not sanitized)
      // so downstream tool-registry.validateContextIdentity can still match
      // its charset; the durable sinks scrub them before persistence.
      expect(ctx.userId).toBe("us-sk_live_realsecret123");
      expect(ctx.agentId).toBe("agent.a-password-hidden");
      expect(ctx.conversationId).toBe("conv_123_session-token");
      // reasoning is content (not identity), so it IS sanitized at buildContext.
      expect(ctx.reasoning).not.toContain("<iframe>");
    });

    it("should accept any non-control-character agentId/conversationId and delegate pattern validation to the registry", () => {
      // buildContext validates length but NOT character pattern for agentId and
      // conversationId: the authoritative charset gate is ToolRegistry.validateContextIdentity
      // (OPTIONAL_ID_PATTERN), which intentionally accommodates real-world
      // identifiers like "john.doe" or "user+role". Applying a stricter
      // TENANT_ID_PATTERN check in buildContext would silently drop values
      // the registry accepts — an inconsistent construction-vs-execution path.
      // buildContext's role is length-cap + whitespace trimming; the registry
      // enforces the final charset contract at execution time.
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        agentId: "agent.doe+role",
        conversationId: "conv-1.0",
      });
      expect(ctx.agentId).toBe("agent.doe+role");
      expect(ctx.conversationId).toBe("conv-1.0");
    });

    it("should reject agentId and conversationId exceeding max length at buildContext", () => {
      // buildContext still enforces length caps for agentId and conversationId
      // so oversized values never reach the registry. Pattern validation is
      // handled by ToolRegistry; length is handled here for early failure.
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
          conversationId: "x".repeat(201),
        })
      ).toThrow(InvalidTypeValueError);
    });

    it("should reject userId with invalid characters before sanitization", () => {
      // Pattern check runs BEFORE sanitization, so a userId containing
      // control characters is rejected outright rather than being silently
      // accepted after sanitization rewrites the value.
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user\tname",
        })
      ).toThrow("'userId' contains invalid characters");
    });

    it("should accept real-world userId formats like dots and plus signs", () => {
      // OPTIONAL_ID_PATTERN matches JwtAuthGuard and TenantGuard, allowing
      // identifiers like "john.doe" or "user+role" that TENANT_ID_PATTERN would reject.
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "john.doe",
      });
      expect(ctx.userId).toBe("john.doe");
      const ctx2 = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user+role",
      });
      expect(ctx2.userId).toBe("user+role");
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

    it("should preserve token-shaped mixed-case idempotency keys verbatim (never mangle into [REDACTED_TOKEN])", () => {
      // Regression: buildContext previously ran the key through
      // sanitizeForLogOutput, which collapsed valid mixed-case alphanumeric
      // keys into [REDACTED_TOKEN]. That breaks idempotency dedup (distinct
      // requests would share one record) — the key must survive verbatim.
      const mixedCaseKey = "req-aB3xY9zW1qR7cV2mN5pL8tJ4kH6fG9sD";
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: mixedCaseKey,
      });
      expect(ctx.idempotencyKey).toBe(mixedCaseKey);
      expect(ctx.idempotencyKey).not.toBe("[REDACTED_TOKEN]");
    });

    it("should preserve idempotency keys containing SAFE_IDEMPOTENCY_KEY punctuation (must not HTML-strip)", () => {
      // SAFE_IDEMPOTENCY_KEY = /^[!-~]+$/ explicitly permits `<`, `>`, `/`.
      // buildContext must not run stripHtmlTags over the key, otherwise a
      // valid key such as "invoice<42>/v1" would be rewritten and dedup broken.
      const punctKey = "invoice<42>/v1";
      const ctx = mcpService.buildContext({
        tenantId: "tenant-1",
        userId: "user-1",
        idempotencyKey: punctKey,
      });
      expect(ctx.idempotencyKey).toBe(punctKey);
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
      ).toThrow("'agentId' cannot be whitespace-only");
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
      ).toThrow("'conversationId' cannot be whitespace-only");
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
      ).toThrow("'idempotencyKey' exceeds maximum length of 500 characters.");
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
      ).toThrow("'idempotencyKey' cannot be whitespace-only");
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
      ).toThrow("'agentId' exceeds maximum length of 200 characters.");
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
      ).toThrow("'conversationId' exceeds maximum length of 200 characters.");
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
      ).toThrow(/'agentId' must be a string/);
    });

    it("should reject non-string idempotencyKey with a structured error", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          idempotencyKey: { not: "a string" } as unknown as string,
        })
      ).toThrow(/'idempotencyKey' must be a string/);
    });

    it("should reject non-string conversationId with a structured error", () => {
      expect(() =>
        mcpService.buildContext({
          tenantId: "tenant-1",
          userId: "user-1",
          conversationId: true as unknown as string,
        })
      ).toThrow(/'conversationId' must be a string/);
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
        expect(callWithType).toThrow(/'reasoning' must be a string/);
      });

      it("should reject reasoning exceeding max length", () => {
        const callWithLongReasoning = () =>
          mcpService.buildContext({
            tenantId: "tenant-1",
            userId: "user-1",
            reasoning: "x".repeat(2001),
          });
        expect(callWithLongReasoning).toThrow(InvalidTypeValueError);
        expect(callWithLongReasoning).toThrow("'reasoning' exceeds maximum length of 2000 characters.");
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
        ).toThrow("'reasoning' cannot be whitespace-only");
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

describe("McpService.onModuleInit — the production tool registration", () => {
  // Every other McpService test MOCKS OUT `onModuleInit` — the very method
  // that performs the production wiring. That made the following
  // regressions undetectable by the suite:
  //   * deleting `registerUserTools(this.registry)` silently removes
  //     `create_user` / `get_user` from production — the ONLY write path to
  //     the table that stores `password_hash`;
  //   * reordering the middleware chain (which the source comments say is
  //     semantically critical);
  //   * a tool-name typo or duplicate — `ToolRegistry.register` THROWS on
  //     both, so the app would fail to boot in production.
  //
  // These tests call the real method.
  function createService() {
    const mockPrisma = {
      admin: {
        aiActionLog: { create: vi.fn().mockResolvedValue({}) },
        idempotencyRecord: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        confirmationGate: {
          findMany: vi.fn().mockResolvedValue([]),
          // The gate middleware reads the row for the tool being called.
          findUnique: vi.fn().mockResolvedValue({ toolName: "test_tool", enabled: true, description: "gated" }),
        },
        agentRegistry: { findUnique: vi.fn().mockResolvedValue(null) },
      },
      tenantScoped: vi.fn(),
    } as any;
    return new McpService(mockPrisma, {} as any, {} as any, {} as any);
  }

  beforeEach(() => {
    // The suite above installs a spy on `McpService.prototype.onModuleInit`
    // (to skip the wiring in the buildContext tests). That spy lives on the
    // PROTOTYPE and is not restored between tests, so it would still be in
    // place here and the real wiring would never run. Restore every spy so
    // the REAL method executes.
    vi.restoreAllMocks();
  });

  it("registers every production tool", async () => {
    const service = createService();
    await service.onModuleInit();

    const names = service.getRegistry().names;
    expect(names).toHaveLength(25);
    // The user tools are the only write path to `user.password_hash`.
    expect(names).toContain("create_user");
    expect(names).toContain("get_user");
    // The agent registry tools are the enforcement surface.
    expect(names).toContain("register_agent");
    expect(names).toContain("deactivate_agent");
    // The discovery tools back the `GET /api/mcp/tools` payload.
    expect(names).toContain("list_available_tools");
    expect(names).toContain("explain_error");
  });

  it("registers the middlewares in the documented order", async () => {
    // errorHandler → auditLog → agentPolicy → confirmationGate → idempotency
    //
    // The order is semantically critical:
    //   * errorHandler must be OUTERMOST so every thrown error becomes a
    //     structured ToolResult;
    //   * auditLog must wrap the guards so a rejected call is still audited;
    //   * agentPolicy must run before confirmationGate so an agent that may
    //     not call a tool at all cannot "unlock" it with a confirmation;
    //   * confirmationGate must run before idempotency so a confirmation
    //     rejection does not consume the caller's idempotency key.
    //
    // The middleware factories return anonymous closures, so the order is
    // asserted BEHAVIOURALLY: each captured middleware is invoked on its own
    // and identified by what it does.
    const service = createService();
    const registry = service.getRegistry();
    const captured: any[] = [];
    const originalAdd = registry.addGlobalMiddleware.bind(registry);
    vi.spyOn(registry, "addGlobalMiddleware").mockImplementation((mw: any, name?: string) => {
      captured.push(mw);
      return originalAdd(mw, name);
    });

    await service.onModuleInit();

    expect(captured).toHaveLength(5);

    const definition = { name: "test_tool", riskLevel: "high" } as any;
    const baseContext = { tenantId: "tenant-1", userId: "user-1", services: {} } as any;

    // 1) errorHandler: converts a thrown error into a structured result.
    const thrown = new Error("boom");
    const errorHandlerResult = await captured[0]({}, baseContext, definition, () => { throw thrown; });
    expect(errorHandlerResult.success).toBe(false);
    expect(errorHandlerResult.error?.code).toBeDefined();

    // 2) auditLog: passes the call through AND records an audit row.
    const auditNext = vi.fn().mockResolvedValue({ success: true, data: "ok" });
    const auditResult = await captured[1]({}, baseContext, definition, auditNext);
    expect(auditResult.success).toBe(true);
    expect(auditNext).toHaveBeenCalled();

    // 3) agentPolicy: rejects an agent that is not registered.
    const policyNext = vi.fn().mockResolvedValue({ success: true, data: "ok" });
    const policyResult = await captured[2](
      {},
      { ...baseContext, agentId: "not-registered" },
      definition,
      policyNext,
    );
    expect(policyResult.success).toBe(false);
    expect(policyResult.error?.code).toBe("AGENT_NOT_REGISTERED");
    expect(policyNext).not.toHaveBeenCalled();

    // 4) confirmationGate: rejects a gated tool with no confirmation.
    const gateNext = vi.fn().mockResolvedValue({ success: true, data: "ok" });
    const gateResult = await captured[3]({}, baseContext, definition, gateNext);
    expect(gateResult.success).toBe(false);
    expect(gateResult.error?.code).toBe("CONFIRMATION_REQUIRED");
    expect(gateNext).not.toHaveBeenCalled();

    // 5) idempotency: rejects a malformed idempotency key.
    const idemNext = vi.fn().mockResolvedValue({ success: true, data: "ok" });
    const idemResult = await captured[4](
      {},
      { ...baseContext, idempotencyKey: "" },
      definition,
      idemNext,
    );
    expect(idemResult.success).toBe(false);
    expect(idemResult.error?.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(idemNext).not.toHaveBeenCalled();
  });

  it("builds the discovery payload with the confirmation flags", async () => {
    const service = createService();
    await service.onModuleInit();

    const payload = await service.getDiscoveryPayload();
    expect(payload.totalAvailable).toBe(25);
    expect(payload.tools.length).toBe(25);
    for (const tool of payload.tools) {
      expect(tool).toHaveProperty("confirmationRequired");
      expect(typeof tool.confirmationRequired).toBe("boolean");
    }
  });
});
