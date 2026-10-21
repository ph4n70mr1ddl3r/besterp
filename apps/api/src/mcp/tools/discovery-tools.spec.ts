// Unit tests for Discovery MCP Tools — list_available_tools, get_type_table_values, describe_entity, and get_valid_transitions
// Tests Zod schema validation, entity filtering, delegate access, HTML sanitization, and transition lookup

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@besterp/mcp-tools";
import { registerDiscoveryTools } from "./discovery-tools.js";
import type { PrismaClient } from "@prisma/client";

const mockContext: ToolContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  services: {},
};

// ─── Mock Prisma admin client ───────────────────────────────────

function createMockPrisma() {
  const partyTypeRows = [
    { partyTypeId: "pt-1", name: "Customer", description: "A paying customer", aiPromptHint: "Use for customers" },
    { partyTypeId: "pt-2", name: "Supplier", description: "<b>Trusted</b> supplier partner", aiPromptHint: "<script>alert(1)</script>Use for suppliers" },
  ];
  const roleTypeRows = [
    { roleTypeId: "rt-1", name: "Admin", description: null, aiPromptHint: null },
  ];
  const contactMechanismTypeRows = [
    { contactMechanismTypeId: "cm-1", name: "EMAIL_ADDRESS", description: "Email contact", aiPromptHint: null },
  ];
  const productTypeRows = [
    { productTypeId: "pt-good", name: "GOOD", description: "A physical good", aiPromptHint: "Use for goods" },
  ];
  const entityDescriptorRows = [
    { entityName: "party", description: "A person or organization", aiPromptHint: "Use for any party", keyFields: { partyId: "UUID" } },
    { entityName: "order", description: "A sales or purchase order", aiPromptHint: null, keyFields: null },
  ];

  return {
    partyType: {
      findMany: vi.fn().mockResolvedValue(partyTypeRows),
    },
    roleType: {
      findMany: vi.fn().mockResolvedValue(roleTypeRows),
    },
    contactMechanismType: {
      findMany: vi.fn().mockResolvedValue(contactMechanismTypeRows),
    },
    productType: {
      findMany: vi.fn().mockResolvedValue(productTypeRows),
    },
    entityDescriptor: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: { entityName: string } }) => {
        const row = entityDescriptorRows.find((r) => r.entityName === where.entityName);
        return Promise.resolve(row ?? null);
      }),
    },
    confirmationGate: {
      findMany: vi.fn().mockResolvedValue([
        // `create_party` is a HIGH-risk tool (the gate middleware only
        // enforces high/critical risk levels), so it is reported as
        // requiring a confirmation.
        { toolName: "create_party" },
        // `describe_entity` is a NONE-risk read-only tool. A gate row for it
        // is NOT enforced by the middleware, so it must NOT be advertised as
        // requiring a confirmation.
        { toolName: "describe_entity" },
      ]),
    },
  } as unknown as PrismaClient;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Discovery MCP Tools", () => {
  let registry: ToolRegistry;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    mockPrisma = createMockPrisma();
    registerDiscoveryTools(registry, mockPrisma);
  });

  describe("list_available_tools", () => {
    it("should list all tools when no entity filter is provided", async () => {
      const result = await registry.execute("list_available_tools", {}, mockContext);

      expect(result.success).toBe(true);
      expect((result.data as { tools: unknown[]; totalAvailable: number }).tools.length).toBeGreaterThan(0);
      expect((result.data as { totalAvailable: number }).totalAvailable).toBeGreaterThan(0);
    });

    it("should report which tools require an agent confirmation", async () => {
      // The tool description promises "confirmation requirements" — the
      // discovery payload must actually carry them, sourced from the
      // database-backed confirmation_gate table.
      const result = await registry.execute("list_available_tools", {}, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as { tools: Array<{ name: string; confirmationRequired: boolean }> };
      const gated = data.tools.filter((t) => t.confirmationRequired);
      // Only HIGH/CRITICAL-risk gated tools are reported: the gate middleware
      // does not enforce medium/low-risk tools, so advertising them would
      // promise a requirement the pipeline does not apply. Every tool
      // registered in this spec is a read-only discovery tool (risk "none"),
      // so NONE of them is reported — even `describe_entity`, which HAS a
      // gate row.
      expect(gated).toEqual([]);
      expect(data.tools.every((t) => typeof t.confirmationRequired === "boolean")).toBe(true);
      expect(data.tools.find((t) => t.name === "describe_entity")?.confirmationRequired).toBe(false);
    });

    it("should report no confirmation requirement when the gate table is unavailable", async () => {
      const mockGate = (mockPrisma as unknown as Record<string, { findMany: { mockRejectedValueOnce: (e: unknown) => void } } | undefined>).confirmationGate;
      expect(mockGate).toBeDefined();
      mockGate?.findMany.mockRejectedValueOnce(new Error("db down"));

      const result = await registry.execute("list_available_tools", {}, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as { tools: Array<{ confirmationRequired: boolean }> };
      expect(data.tools.every((t) => t.confirmationRequired === false)).toBe(true);
    });

    it("should filter tools by entity name (case-insensitive)", async () => {
      const result = await registry.execute(
        "list_available_tools",
        { entity: "party" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { tools: Array<{ entity?: string }> };
      expect(data.tools.every((t) => (t.entity ?? "").toLowerCase() === "party")).toBe(true);
    });

    it("should return empty list for non-matching entity", async () => {
      const result = await registry.execute(
        "list_available_tools",
        { entity: "nonexistent_entity" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { tools: unknown[]; totalAvailable: number };
      expect(data.tools).toEqual([]);
      expect(data.totalAvailable).toBe(0);
    });

    it("should accept whitespace-only entity as no filter", async () => {
      // optionalFilteredString normalises whitespace-only to undefined, which
      // means "no filter" — not a match-everything empty string.
      const resultWithSpaces = await registry.execute(
        "list_available_tools",
        { entity: "   " },
        mockContext,
      );
      const resultWithoutFilter = await registry.execute(
        "list_available_tools",
        {},
        mockContext,
      );

      expect(resultWithSpaces.success).toBe(true);
      expect(resultWithoutFilter.success).toBe(true);
      const d1 = resultWithSpaces.data as { totalAvailable: number };
      const d2 = resultWithoutFilter.data as { totalAvailable: number };
      expect(d1.totalAvailable).toBe(d2.totalAvailable);
    });

    it("should reject entity exceeding max length", async () => {
      const result = await registry.execute(
        "list_available_tools",
        { entity: "x".repeat(65) },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("get_type_table_values", () => {
    it("should return PARTY_TYPE values", async () => {
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "PARTY_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: Array<{ name: string; description: string | null; aiPromptHint: string | null }>; totalAvailable: number };
      expect(data.typeName).toBe("PARTY_TYPE");
      expect(data.values.length).toBe(2);
      expect(data.values[0]!.name).toBe("Customer");
      expect(data.values[1]!.name).toBe("Supplier");
      expect((mockPrisma.partyType as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { name: "asc" } }),
      );
    });

    it("should return ROLE_TYPE values", async () => {
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "ROLE_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: Array<{ name: string }>; totalAvailable: number };
      expect(data.typeName).toBe("ROLE_TYPE");
      expect(data.values.length).toBe(1);
      expect(data.values[0]!.name).toBe("Admin");
    });

    it("should return CONTACT_MECHANISM_TYPE values", async () => {
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "CONTACT_MECHANISM_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: unknown[]; totalAvailable: number };
      expect(data.typeName).toBe("CONTACT_MECHANISM_TYPE");
      expect(data.values.length).toBe(1);
    });

    it("should return PRODUCT_TYPE values", async () => {
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "PRODUCT_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: Array<{ name: string; description: string | null }>; totalAvailable: number };
      expect(data.typeName).toBe("PRODUCT_TYPE");
      expect(data.values.length).toBe(1);
      expect(data.values[0]!.name).toBe("GOOD");
      expect(data.values[0]!.description).toBe("A physical good");
    });

    it("should strip HTML from description and aiPromptHint", async () => {
      // The Supplier row has HTML in its description; the aiPromptHint of the
      // first PartyType row has a <script> payload that must be stripped.
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "PARTY_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: Array<{ name: string; description: string | null; aiPromptHint: string | null }>; totalAvailable: number };
      const supplier = data.values.find((v) => v.name === "Supplier");
      expect(supplier!.description).not.toContain("<b>");
      expect(supplier!.description).toContain("Trusted");
      expect(supplier!.aiPromptHint).not.toContain("<script>");
      expect(supplier!.aiPromptHint).not.toContain("alert");
    });

    it("should return null for null description/aiPromptHint fields", async () => {
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "ROLE_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { values: Array<{ description: null; aiPromptHint: null }> };
      expect(data.values[0]!.description).toBeNull();
      expect(data.values[0]!.aiPromptHint).toBeNull();
    });

    it("should include totalAvailable count", async () => {
      const result = await registry.execute(
        "get_type_table_values",
        { typeName: "PARTY_TYPE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { totalAvailable: number };
      expect(data.totalAvailable).toBe(2);
    });
  });

  describe("describe_entity", () => {
    it("should return descriptor for a known entity", async () => {
      const result = await registry.execute(
        "describe_entity",
        { entityName: "party" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { entityName: string; description: string | null; aiPromptHint: string | null; keyFields: Record<string, string> | null };
      expect(data.entityName).toBe("party");
      expect(data.description).toBe("A person or organization");
      expect(data.aiPromptHint).toBe("Use for any party");
      expect(data.keyFields).toEqual({ partyId: "UUID" });
    });

    it("should return ENTITY_NOT_FOUND for unknown entity", async () => {
      const result = await registry.execute(
        "describe_entity",
        { entityName: "nonexistent_entity" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
      expect(result.error?.message).toContain("nonexistent_entity");
    });

    it("should normalize entityName to lowercase", async () => {
      // The handler trims and lowercases the input before querying.
      const result = await registry.execute(
        "describe_entity",
        { entityName: "  PARTY  " },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { entityName: string };
      expect(data.entityName).toBe("party");
    });

    it("should reject entityName exceeding max length", async () => {
      const result = await registry.execute(
        "describe_entity",
        { entityName: "x".repeat(65) },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should strip HTML from description and aiPromptHint", async () => {
      // Re-mock with HTML in the descriptor.
      const htmlPrisma = {
        ...mockPrisma,
        entityDescriptor: {
          findFirst: vi.fn().mockResolvedValue({
            entityName: "party",
            description: "<b>HTML description</b>",
            aiPromptHint: "<script>alert(1)</script>hint",
            keyFields: null,
          }),
        },
      } as unknown as PrismaClient;

      const htmlRegistry = new ToolRegistry();
      registerDiscoveryTools(htmlRegistry, htmlPrisma);

      const result = await htmlRegistry.execute(
        "describe_entity",
        { entityName: "party" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { description: string | null; aiPromptHint: string | null };
      expect(data.description).not.toContain("<b>");
      expect(data.description).toContain("HTML description");
      expect(data.aiPromptHint).not.toContain("<script>");
      expect(data.aiPromptHint).not.toContain("alert");
    });
  });

  describe("get_valid_transitions", () => {
    it("should NOT advertise transitions for entities without a status field", async () => {
      // The transition registry used to list `party` (whose model has NO
      // status column) and `order`/`invoice` (tables that do not exist in
      // this schema at all). A hallucination-guarding tool that itself
      // injected a hallucination: the agent was told a status-transition API
      // existed for entities that have no status field and no transition tool.
      for (const entity of ["party", "order", "invoice"]) {
        const result = await registry.execute(
          "get_valid_transitions",
          { entity },
          mockContext,
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
        expect(result.error?.message).toContain(entity);
      }
    });

    it("should return ENTITY_NOT_FOUND for unknown entity", async () => {
      const result = await registry.execute(
        "get_valid_transitions",
        { entity: "nonexistent" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
      expect(result.error?.message).toContain("nonexistent");
      expect(result.error?.suggestedTools).toContain("describe_entity");
    });

    it("should normalize entity name to lowercase", async () => {
      const result = await registry.execute(
        "get_valid_transitions",
        { entity: "  Party  " },
        mockContext,
      );

      // Normalisation still happens (the error message echoes the lower-cased
      // entity), but `party` has no registered transitions.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
      expect(result.error?.message).toContain("party");
    });

    it("should reject entity exceeding max length", async () => {
      const result = await registry.execute(
        "get_valid_transitions",
        { entity: "x".repeat(65) },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("registration safety", () => {
    it("should register all six discovery tools without throwing", () => {
      expect(registry.names).toContain("list_available_tools");
      expect(registry.names).toContain("get_type_table_values");
      expect(registry.names).toContain("describe_entity");
      expect(registry.names).toContain("get_valid_transitions");
      expect(registry.names).toContain("search_across_entities");
      expect(registry.names).toContain("explain_error");
    });

    it("should include all discovery tools in getDiscoveryInfo", () => {
      const info = registry.getDiscoveryInfo();
      const names = info.map((d) => d.name);
      expect(names).toContain("list_available_tools");
      expect(names).toContain("get_type_table_values");
      expect(names).toContain("describe_entity");
      expect(names).toContain("get_valid_transitions");
      expect(names).toContain("search_across_entities");
      expect(names).toContain("explain_error");
    });
  });

  describe("search_across_entities", () => {
    it("should reject unknown entity type at schema level", async () => {
      const result = await registry.execute(
        "search_across_entities",
        { query: "Acme", entity: "nonexistent" as any },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject empty query", async () => {
      const result = await registry.execute(
        "search_across_entities",
        { query: "   " },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should accept valid pagination params", async () => {
      const result = await registry.execute(
        "search_across_entities",
        { query: "test", limit: 10, offset: 5 },
        mockContext,
      );

      // Should not fail validation — result depends on service availability
      expect(result.success !== false || result.error?.code !== "INVALID_INPUT").toBe(true);
    });

    it("should report a structured failure when every entity search fails", async () => {
      // A rejected branch must not be reported as "no results" — a database
      // outage or a DomainError is otherwise indistinguishable from a
      // genuinely empty result.
      const failing = {
        searchParties: vi.fn().mockRejectedValue(new Error("db down")),
        searchProducts: vi.fn().mockRejectedValue(new Error("db down")),
      };

      const result = await registry.execute(
        "search_across_entities",
        { query: "Acme" },
        { ...mockContext, services: { partyService: failing, productService: failing } },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error?.context?.failures).toHaveLength(2);
    });

    it("should report a failure when a search service is NOT wired in", async () => {
      // A missing service used to resolve to `null`, which the caller read as
      // "no results" — the agent could not distinguish "this tenant has no
      // parties named Acme" from "the party search service is unavailable",
      // and the tool reported `success: true` with no failure marker.
      const result = await registry.execute(
        "search_across_entities",
        { query: "Acme" },
        { ...mockContext, services: {} },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error?.context?.failures).toHaveLength(2);
    });

    it("should report a partial failure when one entity search fails", async () => {
      const result = await registry.execute(
        "search_across_entities",
        { query: "Acme" },
        {
          ...mockContext,
          services: {
            partyService: { searchParties: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
            productService: { searchProducts: vi.fn().mockRejectedValue(new Error("db down")) },
          },
        },
      );

      expect(result.success).toBe(true);
      const data = result.data as { results: { party: unknown; product: unknown }; partialFailure?: boolean; failures?: unknown[] };
      expect(data.results.party).not.toBeNull();
      expect(data.results.product).toBeNull();
      expect(data.partialFailure).toBe(true);
      expect(data.failures).toHaveLength(1);
    });
  });

  describe("explain_error", () => {
    it("should explain a known error code", async () => {
      const result = await registry.execute(
        "explain_error",
        { errorCode: "INVALID_TYPE_VALUE" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { errorCode: string; message: string; suggestedTools: string[] };
      expect(data.errorCode).toBe("INVALID_TYPE_VALUE");
      expect(data.message).toContain("does not match any valid option");
      expect(data.suggestedTools).toContain("get_type_table_values");
    });

    it("should explain the error codes the MCP pipeline actually emits", async () => {
      // The map used to contain only the domain codes and the raw Prisma
      // codes — but the Prisma codes are NEVER surfaced to the agent (the
      // error handler translates P2002 → DUPLICATE_ENTITY, P2025 →
      // ENTITY_NOT_FOUND, P2034 → CONCURRENCY_CONFLICT). The codes agents
      // actually see — INVALID_INPUT (the most frequent failure of all),
      // CONFIRMATION_REQUIRED, REFERENCE_ERROR, … — were missing, so
      // `explain_error({ errorCode: "INVALID_INPUT" })` returned
      // UNKNOWN_ERROR_CODE for the tool whose whole purpose is to explain
      // unfamiliar error codes.
      for (const code of [
        "INVALID_INPUT",
        "CONFIRMATION_REQUIRED",
        "INVALID_CONFIRMATION",
        "IDEMPOTENCY_KEY_MISMATCH",
        "REQUEST_IN_PROGRESS",
        "SERVICE_UNAVAILABLE",
        "REFERENCE_ERROR",
        "DATABASE_ERROR",
        "INTERNAL_ERROR",
        "UNKNOWN_TOOL",
      ]) {
        const result = await registry.execute("explain_error", { errorCode: code }, mockContext);
        expect(result.success, `expected an explanation for ${code}`).toBe(true);
        const data = result.data as { errorCode: string; message: string };
        expect(data.errorCode).toBe(code);
        expect(data.message.length).toBeGreaterThan(0);
      }
    });

    it("should explain a Prisma error code", async () => {
      const result = await registry.execute(
        "explain_error",
        { errorCode: "P2002" },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { errorCode: string; message: string };
      expect(data.errorCode).toBe("P2002");
      expect(data.message).toContain("unique constraint");
    });

    it("should return ENTITY_NOT_FOUND for unknown error code", async () => {
      const result = await registry.execute(
        "explain_error",
        { errorCode: "NONEXISTENT_CODE" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN_ERROR_CODE");
      expect(result.error?.message).toContain("NONEXISTENT_CODE");
    });

    it("should normalize error code to uppercase", async () => {
      const result = await registry.execute(
        "explain_error",
        { errorCode: "  invalid_type_value  " },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { errorCode: string };
      expect(data.errorCode).toBe("INVALID_TYPE_VALUE");
    });

    it("should reject excessively long error code", async () => {
      const result = await registry.execute(
        "explain_error",
        { errorCode: "x".repeat(51) },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should include context on unknown error code soft-failure", async () => {
      const result = await registry.execute(
        "explain_error",
        { errorCode: "MY_CUSTOM_CODE" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN_ERROR_CODE");
      expect(result.error?.context).toEqual({ errorCode: "MY_CUSTOM_CODE" });
    });

    it("should sanitize user input in entity descriptor not-found message", async () => {
      const result = await registry.execute(
        "describe_entity",
        { entityName: "<script>evil</script>nonexistent_entity" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("ENTITY_NOT_FOUND");
      expect(result.error?.message).not.toContain("<script>");
      expect(result.error?.message).not.toContain("evil");
      expect(result.error?.context?.entityName).not.toContain("<script>");
    });

    it("should return SERVICE_UNAVAILABLE when party service is missing", async () => {
      const result = await registry.execute(
        "search_across_entities",
        { query: "Acme", entity: "party" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error?.context).toEqual({ service: "partyService" });
    });

    it("should return SERVICE_UNAVAILABLE when product service is missing", async () => {
      const result = await registry.execute(
        "search_across_entities",
        { query: "Acme", entity: "product" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error?.context).toEqual({ service: "productService" });
    });

    it("should include context on missing entity descriptor delegate", async () => {
      const brokenPrisma = {
        ...mockPrisma,
        entityDescriptor: null,
      } as unknown as PrismaClient;

      const brokenRegistry = new ToolRegistry();
      registerDiscoveryTools(brokenRegistry, brokenPrisma);

      const result = await brokenRegistry.execute(
        "describe_entity",
        { entityName: "party" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error?.context?.reason).toBe("entityDescriptor delegate missing or malformed");
    });
  });
});

describe("list_available_tools — confirmation gate reporting", () => {
  it("reports a HIGH-risk gated tool as requiring confirmation", async () => {
    // The gate middleware enforces only high/critical-risk tools, so a gate
    // row for such a tool must be advertised to the agent.
    const registry = new ToolRegistry();
    const mockPrisma = createMockPrisma();
    (mockPrisma as unknown as { confirmationGate: { findMany: { mockResolvedValue: (v: unknown) => void } } })
      .confirmationGate.findMany.mockResolvedValue([{ toolName: "risky_write" }]);
    registerDiscoveryTools(registry, mockPrisma);
    registry.register({
      name: "risky_write",
      description: "A high-risk write tool used to verify gate reporting.",
      inputSchema: { safeParse: (input: unknown) => ({ success: true, data: input }) } as never,
      riskLevel: "high",
      entity: "test",
      handler: async () => ({ success: true, data: "ok" }),
    });

    const result = await registry.execute("list_available_tools", {}, mockContext);
    expect(result.success).toBe(true);
    const data = result.data as { tools: Array<{ name: string; confirmationRequired: boolean }> };
    expect(data.tools.find((t) => t.name === "risky_write")?.confirmationRequired).toBe(true);
    expect(data.tools.find((t) => t.name === "describe_entity")?.confirmationRequired).toBe(false);
  });
});
