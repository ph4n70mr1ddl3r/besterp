// Unit tests for Discovery MCP Tools — list_available_tools, get_type_table_values
// Tests tool definitions, registry integration, and type table queries

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@besterp/mcp-tools";
import { registerDiscoveryTools } from "./discovery-tools.js";

// ─── Mock PrismaClient ──────────────────────────────────────────

function createMockPrisma() {
  return {
    partyType: {
      findMany: vi.fn().mockResolvedValue([
        { partyTypeId: "pt-person", name: "PERSON", description: "An individual", aiPromptHint: "Use for people" },
        { partyTypeId: "pt-org", name: "ORGANIZATION", description: "A company", aiPromptHint: "Use for companies" },
      ]),
    },
    roleType: {
      findMany: vi.fn().mockResolvedValue([
        { roleTypeId: "rt-customer", name: "Customer", description: "Buys goods", aiPromptHint: "For buyers" },
      ]),
    },
    contactMechanismType: {
      findMany: vi.fn().mockResolvedValue([
        { contactMechanismTypeId: "cmt-email", name: "EMAIL_ADDRESS", description: "Email", aiPromptHint: "For email" },
      ]),
    },
  } as any;
}

function createContext(): ToolContext {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    services: {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Discovery MCP Tools", () => {
  let registry: ToolRegistry;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    mockPrisma = createMockPrisma();
    registerDiscoveryTools(registry, mockPrisma);
  });

  describe("list_available_tools", () => {
    it("should list all registered tools", async () => {
      const result = await registry.execute("list_available_tools", {}, createContext());

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("tools");
      expect(result.data).toHaveProperty("totalAvailable");
      const data = result.data as { tools: unknown[]; totalAvailable: number };
      expect(data.tools.length).toBeGreaterThan(0);
      expect(data.totalAvailable).toBe(data.tools.length);
    });

    it("should filter tools by entity", async () => {
      const result = await registry.execute("list_available_tools", { entity: "tool" }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { tools: { entity: string }[] };
      expect(data.tools.every((t) => t.entity === "tool")).toBe(true);
    });

    it("should return empty list for non-matching entity", async () => {
      const result = await registry.execute("list_available_tools", { entity: "nonexistent" }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { tools: unknown[]; totalAvailable: number };
      expect(data.tools).toHaveLength(0);
      expect(data.totalAvailable).toBe(0);
    });

    it("should normalize whitespace-only entity to no filter (regression guard, round 113)", async () => {
      // Before round 113, whitespace-only input passed the schema, was trimmed
      // to "", and compared as "" === (t.entity ?? "") — which never matches,
      // silently returning ZERO tools. Per the round-107 convention (see
      // optionalFilteredString), whitespace-only optional filters mean "no
      // filter", same as omitting the field entirely.
      const result = await registry.execute("list_available_tools", { entity: "   " }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { tools: unknown[] };
      expect(data.tools.length).toBeGreaterThan(0);
    });

    it("should trim whitespace around entity before filtering", async () => {
      const result = await registry.execute("list_available_tools", { entity: "  tool  " }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { tools: { entity: string }[] };
      expect(data.tools.every((t) => t.entity === "tool")).toBe(true);
    });

    it("should include discovery note", async () => {
      const result = await registry.execute("list_available_tools", {}, createContext());

      const data = result.data as { note: string };
      expect(data.note).toContain("get_type_table_values");
    });
  });

  describe("get_type_table_values", () => {
    it("should return PARTY_TYPE values", async () => {
      const result = await registry.execute("get_type_table_values", { typeName: "PARTY_TYPE" }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: unknown[]; totalAvailable: number };
      expect(data.typeName).toBe("PARTY_TYPE");
      expect(data.values).toHaveLength(2);
      expect(data.totalAvailable).toBe(2);
      expect(mockPrisma.partyType.findMany).toHaveBeenCalled();
    });

    it("should request deterministic ordering (orderBy name asc) for every type table (regression guard, round 143)", async () => {
      // Regression: the type-table query had no ORDER BY, so Postgres returned
      // rows in unspecified (heap/insertion) order — the same "valid values"
      // call could present the vocabulary in a different order per call, and
      // the durable audit snapshot could differ. name is @unique (never null),
      // so ascending name order is total and stable.
      const cases: Array<{ typeName: "PARTY_TYPE" | "ROLE_TYPE" | "CONTACT_MECHANISM_TYPE"; delegate: "partyType" | "roleType" | "contactMechanismType" }> = [
        { typeName: "PARTY_TYPE", delegate: "partyType" },
        { typeName: "ROLE_TYPE", delegate: "roleType" },
        { typeName: "CONTACT_MECHANISM_TYPE", delegate: "contactMechanismType" },
      ];

      for (const { typeName, delegate } of cases) {
        const result = await registry.execute("get_type_table_values", { typeName }, createContext());
        expect(result.success).toBe(true);
        expect(mockPrisma[delegate].findMany).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: { name: "asc" } })
        );
      }
    });

    it("should return ROLE_TYPE values", async () => {
      const result = await registry.execute("get_type_table_values", { typeName: "ROLE_TYPE" }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: unknown[] };
      expect(data.typeName).toBe("ROLE_TYPE");
      expect(data.values).toHaveLength(1);
      expect(mockPrisma.roleType.findMany).toHaveBeenCalled();
    });

    it("should return CONTACT_MECHANISM_TYPE values", async () => {
      const result = await registry.execute("get_type_table_values", { typeName: "CONTACT_MECHANISM_TYPE" }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { typeName: string; values: unknown[] };
      expect(data.typeName).toBe("CONTACT_MECHANISM_TYPE");
      expect(data.values).toHaveLength(1);
      expect(mockPrisma.contactMechanismType.findMany).toHaveBeenCalled();
    });

    it("should reject invalid typeName", async () => {
      const result = await registry.execute("get_type_table_values", { typeName: "INVALID_TABLE" }, createContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should format rows with id, name, description, aiPromptHint", async () => {
      const result = await registry.execute("get_type_table_values", { typeName: "PARTY_TYPE" }, createContext());

      const data = result.data as { values: { id: string; name: string; description: string | null; aiPromptHint: string | null }[] };
      const first = data.values[0];
      expect(first).toBeDefined();
      expect(first!).toHaveProperty("id");
      expect(first!).toHaveProperty("name");
      expect(first!).toHaveProperty("description");
      expect(first!).toHaveProperty("aiPromptHint");
      expect(typeof first!.id).toBe("string");
      expect(typeof first!.name).toBe("string");
    });

    it("should sanitize description and aiPromptHint before reflecting to the agent (regression guard, round 124)", async () => {
      // Type table description/aiPromptHint are admin-authored global reference
      // data, but they flow to the AI agent via the tool result and are
      // persisted to the cross-tenant durable audit sink — the same surfaces
      // that scrub every other string leaf. A corrupt or attacker-influenced
      // value in the type table must not reach the agent or the audit row
      // verbatim. SanitizeForLogOutput collapses URLs/paths/secrets and
      // strips control chars; the test confirms it runs on both fields.
      const controlInjectedPrisma = {
        partyType: {
          findMany: vi.fn().mockResolvedValue([
            { partyTypeId: "pt-person", name: "PERSON", description: "http://evil.com?key=sk_live_abc123", aiPromptHint: "<script>alert(1)</script>" },
          ]),
        },
        roleType: { findMany: vi.fn().mockResolvedValue([]) },
        contactMechanismType: { findMany: vi.fn().mockResolvedValue([]) },
      } as any;

      const controlRegistry = new ToolRegistry();
      registerDiscoveryTools(controlRegistry, controlInjectedPrisma);

      const result = await controlRegistry.execute("get_type_table_values", { typeName: "PARTY_TYPE" }, createContext());

      expect(result.success).toBe(true);
      const data = result.data as { values: { description: string | null; aiPromptHint: string | null }[] };
      const row = data.values[0]!;
      expect(row.description).not.toContain("sk_live_abc123");
      expect(row.description).not.toContain("evil.com");
      expect(row.aiPromptHint).not.toContain("<script>");
      expect(row.aiPromptHint).not.toContain("alert");
    });
  });

  describe("tool metadata", () => {
    it("list_available_tools should have discovery tags", () => {
      const info = registry.getDiscoveryInfo();
      const listTools = info.find((t) => t.name === "list_available_tools");
      expect(listTools).toBeDefined();
      expect(listTools!.tags).toContain("discovery");
    });

    it("get_type_table_values should have type-table tags", () => {
      const info = registry.getDiscoveryInfo();
      const typeTable = info.find((t) => t.name === "get_type_table_values");
      expect(typeTable).toBeDefined();
      expect(typeTable!.tags).toContain("type-table");
    });
  });
});
