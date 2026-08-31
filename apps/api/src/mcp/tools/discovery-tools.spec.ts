// Unit tests for Discovery MCP Tools — list_available_tools and get_type_table_values
// Tests Zod schema validation, entity filtering, delegate access, and HTML sanitization

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

  describe("registration safety", () => {
    it("should register both discovery tools without throwing", () => {
      // Verify the registration itself does not crash — the tools are
      // registered in registerDiscoveryTools and should be immediately
      // executable after registration.
      expect(registry.names).toContain("list_available_tools");
      expect(registry.names).toContain("get_type_table_values");
    });

    it("should include discovery tools in getDiscoveryInfo", () => {
      const info = registry.getDiscoveryInfo();
      const names = info.map((d) => d.name);
      expect(names).toContain("list_available_tools");
      expect(names).toContain("get_type_table_values");
    });
  });
});
