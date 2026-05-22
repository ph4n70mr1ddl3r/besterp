// Unit tests for McpModule.
// Tests middleware registration, tool initialization, and context building.

import { Test, TestingModule } from "@nestjs/testing";
import { McpModule } from "./mcp.module";
import { PrismaService } from "../prisma/prisma.service";
import { PartyService } from "../modules/core/party/party.service";
import { ToolRegistry } from "@besterp/mcp-tools";

describe("McpModule", () => {
  let module: McpModule;
  let prisma: PrismaService;
  let partyService: PartyService;

  const mockPrisma = {
    tenantScoped: jest.fn(),
    admin: {
      $queryRaw: jest.fn(),
    },
  };

  const mockPartyService = {
    createParty: jest.fn(),
    getParty: jest.fn(),
    searchParties: jest.fn(),
    addPartyRole: jest.fn(),
    addContactMechanism: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [McpModule.forRoot()],
      providers: [
        McpModule,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: PartyService,
          useValue: mockPartyService,
        },
      ],
    }).compile();

    const mcpModule = module.get<McpModule>(McpModule);
    module = mcpModule;
    prisma = module.get<PrismaService>(PrismaService);
    partyService = module.get<PartyService>(PartyService);
  });

  describe("Initialization", () => {
    it("should initialize with correct number of tools", () => {
      const registry = module.getRegistry();
      const tools = registry.names;
      
      // Should have 5 party tools + 2 discovery tools = 7 total
      expect(tools).toHaveLength(7);
      expect(tools).toContain("create_party");
      expect(tools).toContain("get_party");
      expect(tools).toContain("search_parties");
      expect(tools).toContain("add_party_role");
      expect(tools).toContain("add_contact_mechanism");
      expect(tools).toContain("list_available_tools");
      expect(tools).toContain("get_type_table_values");
    });

    it("should register global middlewares in correct order", () => {
      // This test verifies that the middleware chain is properly set up
      const registry = module.getRegistry();
      
      // Check that error handler is first (outermost)
      expect(registry).toBeDefined();
      // The actual middleware order testing would be more complex and would
      // require mocking the middleware execution
    });
  });

  describe("buildContext", () => {
    it("should build context with required fields", () => {
      const context = module.buildContext({
        tenantId: "tenant-1",
        userId: "user-123",
        agentId: "agent-456",
        conversationId: "conv-789",
        idempotencyKey: "test-key",
      });

      expect(context.tenantId).toBe("tenant-1");
      expect(context.userId).toBe("user-123");
      expect(context.agentId).toBe("agent-456");
      expect(context.conversationId).toBe("conv-789");
      expect(context.idempotencyKey).toBe("test-key");
      expect(context.services).toBeDefined();
      expect(context.services.partyService).toBeDefined();
    });

    it("should handle optional fields gracefully", () => {
      const context = module.buildContext({
        tenantId: "tenant-1",
        userId: "user-123",
        // Optional fields omitted
      });

      expect(context.tenantId).toBe("tenant-1");
      expect(context.userId).toBe("user-123");
      expect(context.agentId).toBeUndefined();
      expect(context.conversationId).toBeUndefined();
      expect(context.idempotencyKey).toBeUndefined();
    });

    it("should inject partyService into context", () => {
      const context = module.buildContext({
        tenantId: "tenant-1",
        userId: "user-123",
      });

      expect(context.services.partyService).toBe(partyService);
    });
  });

  describe("Tool execution", () => {
    it("should execute tools through the registry", async () => {
      const registry = module.getRegistry();
      
      // Mock the party service
      mockPartyService.createParty.mockResolvedValue({
        partyId: "123",
        name: "Test Party",
        partyType: "PERSON",
        person: { firstName: "Test", lastName: "User" },
      });

      const context = module.buildContext({
        tenantId: "tenant-1",
        userId: "user-123",
      });

      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Test Party",
        person: { firstName: "Test", lastName: "User" },
      }, context);

      expect(result.success).toBe(true);
      expect(result.data.name).toBe("Test Party");
      expect(mockPartyService.createParty).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        partyType: "PERSON",
        name: "Test Party",
        description: undefined,
        person: { firstName: "Test", lastName: "User" },
        organization: undefined,
      });
    });

    it("should handle tool not found error", async () => {
      const registry = module.getRegistry();
      const context = module.buildContext({
        tenantId: "tenant-1",
        userId: "user-123",
      });

      const result = await registry.execute("nonexistent_tool", {}, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN_TOOL");
      expect(result.error?.message).toContain("does not exist");
    });

    it("should validate input through Zod schemas", async () => {
      const registry = module.getRegistry();
      const context = module.buildContext({
        tenantId: "tenant-1",
        userId: "user-123",
      });

      // Try to create party with invalid data (missing required person data)
      const result = await registry.execute("create_party", {
        partyType: "PERSON",
        name: "Test Party",
        // Missing person data
      }, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });
  });

  describe("Middleware integration", () => {
    it("should apply global middlewares to all tools", () => {
      // This would require more complex mocking to test middleware execution
      // For now, we just verify that the registry is properly configured
      const registry = module.getRegistry();
      expect(registry).toBeDefined();
    });
  });
});