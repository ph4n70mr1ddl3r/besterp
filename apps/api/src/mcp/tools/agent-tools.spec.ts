// Unit tests for Agent MCP Tools

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@besterp/mcp-tools";
import { registerAgentTools } from "./agent-tools.js";

const TEST_TENANT = "tenant-acme";
const TEST_AGENT_ID = "sales-assistant-v1";

function createMockSecurityService() {
  return {
    registerAgent: vi.fn().mockResolvedValue({
      agentId: TEST_AGENT_ID,
      tenantId: TEST_TENANT,
      displayName: "Sales Assistant",
      description: "Helps with sales operations",
      capabilities: ["create_party", "search_parties"],
      maxToolCallsPerConversation: 100,
      maxConcurrentConversations: 5,
      maxTransactionAmount: 10000,
      allowedEntityTypes: ["party", "order"],
      rateLimitPerMinute: 30,
      version: "1.0.0",
      isActive: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
    getAgent: vi.fn().mockResolvedValue({
      agentId: TEST_AGENT_ID,
      tenantId: TEST_TENANT,
      displayName: "Sales Assistant",
      description: "Helps with sales operations",
      capabilities: ["create_party", "search_parties"],
      maxToolCallsPerConversation: 100,
      maxConcurrentConversations: 5,
      maxTransactionAmount: 10000,
      allowedEntityTypes: ["party", "order"],
      rateLimitPerMinute: 30,
      version: "1.0.0",
      isActive: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
    searchAgents: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    }),
    updateAgent: vi.fn().mockResolvedValue({
      agentId: TEST_AGENT_ID,
      tenantId: TEST_TENANT,
      displayName: "Updated Agent",
      description: "Helps with sales operations",
      capabilities: ["create_party"],
      maxToolCallsPerConversation: 100,
      maxConcurrentConversations: 5,
      maxTransactionAmount: null,
      allowedEntityTypes: [],
      rateLimitPerMinute: 30,
      version: "1.1.0",
      isActive: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
    deleteAgent: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createContext(services: Record<string, unknown> = {}): ToolContext {
  return {
    tenantId: TEST_TENANT,
    userId: "user-1",
    services,
  };
}

describe("Agent MCP Tools", () => {
  let registry: ToolRegistry;
  let mockSecurityService: ReturnType<typeof createMockSecurityService>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    mockSecurityService = createMockSecurityService();
    registerAgentTools(registry);
  });

  describe("registration", () => {
    it("should register all five agent tools", () => {
      expect(registry.names).toContain("register_agent");
      expect(registry.names).toContain("list_agents");
      expect(registry.names).toContain("describe_agent");
      expect(registry.names).toContain("update_agent");
      expect(registry.names).toContain("deactivate_agent");
    });
  });

  describe("register_agent", () => {
    it("should register an agent with valid input", async () => {
      const result = await registry.execute("register_agent", {
        agentId: TEST_AGENT_ID,
        displayName: "Sales Assistant",
        description: "Helps with sales operations",
        capabilities: ["create_party", "search_parties"],
        version: "1.0.0",
      }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockSecurityService.registerAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT,
          agentId: TEST_AGENT_ID,
          capabilities: ["create_party", "search_parties"],
        })
      );
    });

    it("should reject missing agentId", async () => {
      const result = await registry.execute("register_agent", {
        displayName: "Sales Assistant",
        description: "Helps with sales operations",
        capabilities: ["create_party"],
        version: "1.0.0",
      }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should reject empty capabilities array", async () => {
      const result = await registry.execute("register_agent", {
        agentId: TEST_AGENT_ID,
        displayName: "Sales Assistant",
        description: "Helps with sales operations",
        capabilities: [],
        version: "1.0.0",
      }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should trim and strip HTML from displayName", async () => {
      await registry.execute("register_agent", {
        agentId: TEST_AGENT_ID,
        displayName: "  <script>alert(1)</script>Sales Assistant  ",
        description: "Helps with sales",
        capabilities: ["create_party"],
        version: "1.0.0",
      }, createContext({ securityService: mockSecurityService }));

      expect(mockSecurityService.registerAgent).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Sales Assistant" })
      );
    });

    it("should accept optional rate limits", async () => {
      await registry.execute("register_agent", {
        agentId: TEST_AGENT_ID,
        displayName: "Sales Assistant",
        description: "Helps with sales",
        capabilities: ["create_party"],
        version: "1.0.0",
        maxToolCallsPerConversation: 500,
        rateLimitPerMinute: 60,
        maxTransactionAmount: 50000,
      }, createContext({ securityService: mockSecurityService }));

      expect(mockSecurityService.registerAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          maxToolCallsPerConversation: 500,
          rateLimitPerMinute: 60,
          maxTransactionAmount: 50000,
        })
      );
    });
  });

  describe("list_agents", () => {
    it("should list agents with no filters", async () => {
      const result = await registry.execute("list_agents", {}, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockSecurityService.searchAgents).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TEST_TENANT })
      );
    });

    it("should filter by agentId", async () => {
      await registry.execute("list_agents", { agentId: TEST_AGENT_ID }, createContext({ securityService: mockSecurityService }));

      expect(mockSecurityService.searchAgents).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: TEST_AGENT_ID })
      );
    });

    it("should filter by isActive", async () => {
      await registry.execute("list_agents", { isActive: true }, createContext({ securityService: mockSecurityService }));

      expect(mockSecurityService.searchAgents).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true })
      );
    });
  });

  describe("describe_agent", () => {
    it("should describe an agent by ID", async () => {
      const result = await registry.execute("describe_agent", { agentId: TEST_AGENT_ID }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockSecurityService.getAgent).toHaveBeenCalledWith(TEST_TENANT, TEST_AGENT_ID);
    });

    it("should reject empty agentId", async () => {
      const result = await registry.execute("describe_agent", { agentId: "" }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("update_agent", () => {
    it("should update an agent", async () => {
      const result = await registry.execute("update_agent", {
        agentId: TEST_AGENT_ID,
        displayName: "Updated Sales Assistant",
        version: "2.0.0",
      }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(true);
      expect(mockSecurityService.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT,
          agentId: TEST_AGENT_ID,
          displayName: "Updated Sales Assistant",
          version: "2.0.0",
        })
      );
    });

    it("should reject update with no changes", async () => {
      const result = await registry.execute("update_agent", {
        agentId: TEST_AGENT_ID,
      }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("deactivate_agent", () => {
    it("should deactivate an agent", async () => {
      const result = await registry.execute("deactivate_agent", { agentId: TEST_AGENT_ID }, createContext({ securityService: mockSecurityService }));

      expect(result.success).toBe(true);
      expect(mockSecurityService.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TEST_TENANT, agentId: TEST_AGENT_ID, isActive: false })
      );
    });
  });

  describe("security service validation", () => {
    it("should throw when securityService is missing", async () => {
      await expect(
        registry.execute("register_agent", {
          agentId: TEST_AGENT_ID,
          displayName: "Test",
          description: "Test agent",
          capabilities: ["create_party"],
          version: "1.0.0",
        }, createContext())
      ).rejects.toThrow("SecurityService not available");
    });
  });
});
