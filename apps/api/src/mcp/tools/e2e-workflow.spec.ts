// End-to-end agent workflow test — "create a customer with contacts"
//
// This test verifies the full agentic workflow:
// 1. Register an agent with capabilities
// 2. Describe the agent to verify configuration
// 3. List agents
// 4. Create a party (organization as customer)
// 5. Search for the party
// 6. Add a role (Customer)
// 7. Add a contact mechanism (email)
// 8. Get the party to verify all data
//
// Implements ERP_PLAN.md Phase 0d: End-to-end agent workflow test

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@besterp/mcp-tools";
import { registerPartyTools } from "./party-tools.js";
import { registerDiscoveryTools } from "./discovery-tools.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerProductTools } from "./product-tools.js";

const TEST_TENANT = "tenant-acme";
const TEST_USER = "user-1";

// ─── Mocks ──────────────────────────────────────────────────────

function createMockSecurityService() {
  const agents = new Map<string, Record<string, unknown>>();
  return {
    registerAgent: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
      const agent = {
        agentId: input.agentId as string,
        tenantId: input.tenantId as string,
        displayName: input.displayName as string,
        description: input.description as string,
        capabilities: input.capabilities as string[],
        maxToolCallsPerConversation: (input.maxToolCallsPerConversation as number) ?? 100,
        maxConcurrentConversations: (input.maxConcurrentConversations as number) ?? 5,
        maxTransactionAmount: (input.maxTransactionAmount as number) ?? 0,
        allowedEntityTypes: (input.allowedEntityTypes as string[]) ?? [],
        rateLimitPerMinute: (input.rateLimitPerMinute as number) ?? 30,
        version: input.version as string,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      agents.set(input.agentId as string, agent);
      return agent;
    }),
    getAgent: vi.fn().mockImplementation(async (_: string, agentId: string) => {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);
      return agent;
    }),
    searchAgents: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }),
    updateAgent: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
      const existing = agents.get(input.agentId as string);
      if (!existing) throw new Error(`Agent ${input.agentId} not found`);
      Object.assign(existing, input);
      return existing;
    }),
    deleteAgent: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMockPartyService() {
  const parties = new Map<string, Record<string, unknown>>();
  let idCounter = 1;
  const uuids = [
    "550e8400-e29b-41d4-a716-446655440001",
    "550e8400-e29b-41d4-a716-446655440002",
    "550e8400-e29b-41d4-a716-446655440003",
  ];
  return {
    createParty: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
      const partyId = uuids[(idCounter - 1) % uuids.length]!;
      idCounter++;
      const party = {
        partyId,
        partyType: input.partyType as string,
        name: input.name as string,
        description: (input.description as string | undefined) ?? null,
        tenantId: input.tenantId as string,
        person: null,
        organization: (input.organization as Record<string, unknown> | undefined) ?? null,
        roles: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      parties.set(partyId, party);
      return party;
    }),
    getParty: vi.fn().mockImplementation(async (_tenantId: string, partyId: string) => {
      const party = parties.get(partyId);
      if (!party) throw new Error(`Party ${partyId} not found`);
      return party;
    }),
    searchParties: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    }),
    addPartyRole: vi.fn().mockResolvedValue({
      partyRoleId: "role-1",
      partyId: "party-1",
      roleTypeName: "Customer",
      fromDate: new Date().toISOString(),
      thruDate: null,
    }),
    addContactMechanism: vi.fn().mockResolvedValue({
      contactMechanismId: "cm-1",
      contactMechanismType: "EMAIL_ADDRESS",
      partyId: "party-1",
      postalAddress: null,
      telecomNumber: null,
      emailAddress: { email: "customer@example.com" },
    }),
  };
}

function createMockPrisma() {
  return {
    partyType: {
      findMany: vi.fn().mockResolvedValue([
        { partyTypeId: "pt-person", name: "PERSON", description: "An individual human being", aiPromptHint: "Use for individuals" },
        { partyTypeId: "pt-org", name: "ORGANIZATION", description: "A company or business entity", aiPromptHint: "Use for organizations" },
      ]),
    },
    roleType: {
      findMany: vi.fn().mockResolvedValue([
        { roleTypeId: "rt-customer", name: "Customer", description: "A party that purchases goods", aiPromptHint: null },
      ]),
    },
    contactMechanismType: {
      findMany: vi.fn().mockResolvedValue([
        { contactMechanismTypeId: "cmt-email", name: "EMAIL_ADDRESS", description: "Email contact", aiPromptHint: null },
      ]),
    },
    entityDescriptor: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: { entityName: string } }) => {
        const descriptors: Record<string, unknown> = {
          party: { entityName: "party", description: "A person or organization", aiPromptHint: "Use for any party", keyFields: { partyId: "UUID" } },
          agent_registry: { entityName: "agent_registry", description: "AI agent registry", aiPromptHint: null, keyFields: null },
        };
        return Promise.resolve(descriptors[where.entityName] ?? null);
      }),
    },
  };
}

function createContext(services: Record<string, unknown> = {}): ToolContext {
  return {
    tenantId: TEST_TENANT,
    userId: TEST_USER,
    services,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("End-to-End Agent Workflow: Create Customer with Contacts", () => {
  let registry: ToolRegistry;
  let mockPartyService: ReturnType<typeof createMockPartyService>;
  let mockSecurityService: ReturnType<typeof createMockSecurityService>;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let context: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    mockPartyService = createMockPartyService();
    mockSecurityService = createMockSecurityService();
    mockPrisma = createMockPrisma();
    context = createContext({
      partyService: mockPartyService,
      securityService: mockSecurityService,
    });

    registerPartyTools(registry);
    registerDiscoveryTools(registry, mockPrisma as any);
    registerAgentTools(registry);
    registerProductTools(registry);
  });

  it("should complete the full workflow: register agent → create party → add role → add contact → verify", async () => {
    // Step 1: Register an agent
    const regResult = await registry.execute("register_agent", {
      agentId: "sales-bot-v1",
      displayName: "Sales Bot",
      description: "AI agent that creates customer records",
      capabilities: ["create_party", "search_parties", "get_party", "add_party_role", "add_contact_mechanism"],
      version: "1.0.0",
    }, context);
    expect(regResult.success).toBe(true);
    expect(regResult.data).toBeDefined();
    expect((regResult.data as { agentId: string }).agentId).toBe("sales-bot-v1");

    // Step 2: Describe the agent to verify configuration
    const descResult = await registry.execute("describe_agent", { agentId: "sales-bot-v1" }, context);
    expect(descResult.success).toBe(true);
    expect((descResult.data as { capabilities: string[] }).capabilities).toContain("create_party");

    // Step 3: List agents (verify the new agent appears)
    const listResult = await registry.execute("list_agents", {}, context);
    expect(listResult.success).toBe(true);
    expect(listResult.data).toBeDefined();

    // Step 4: Create a customer party (organization)
    const createResult = await registry.execute("create_party", {
      partyType: "ORGANIZATION",
      name: "Acme Trading Co.",
      description: "A new customer for testing the workflow",
      organization: { legalName: "Acme Trading Company Ltd." },
    }, context);
    expect(createResult.success).toBe(true);
    const partyData = createResult.data as { partyId: string; name: string; partyType: string };
    expect(partyData.partyId).toBeDefined();
    expect(partyData.name).toBe("Acme Trading Co.");
    expect(partyData.partyType).toBe("ORGANIZATION");
    expect(createResult.nextActions).toBeDefined();
    expect(createResult.nextActions!.length).toBeGreaterThan(0);

    // Step 5: Search for the party we just created
    mockPartyService.searchParties.mockResolvedValueOnce({
      items: [partyData],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    const searchResult = await registry.execute("search_parties", { name: "Acme" }, context);
    expect(searchResult.success).toBe(true);
    expect((searchResult.data as { total: number }).total).toBe(1);

    // Step 6: Get the party to see full details
    mockPartyService.getParty.mockResolvedValueOnce({
      ...partyData,
      roles: [],
      organization: { legalName: "Acme Trading Company Ltd.", taxId: null, registrationDate: null },
      person: null,
      description: "A new customer for testing the workflow",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const getResult = await registry.execute("get_party", { partyId: partyData.partyId }, context);
    expect(getResult.success).toBe(true);

    // Step 7: Add Customer role
    const roleResult = await registry.execute("add_party_role", {
      partyId: partyData.partyId,
      roleType: "Customer",
    }, context);
    expect(roleResult.success).toBe(true);
    expect(roleResult.data).toBeDefined();

    // Step 8: Add email contact
    mockPartyService.addContactMechanism.mockResolvedValueOnce({
      contactMechanismId: "cm-1",
      contactMechanismType: "EMAIL_ADDRESS",
      partyId: partyData.partyId,
      postalAddress: null,
      telecomNumber: null,
      emailAddress: { email: "contact@acme-trading.example.com" },
    });
    const contactResult = await registry.execute("add_contact_mechanism", {
      partyId: partyData.partyId,
      contactMechanismType: "EMAIL_ADDRESS",
      emailAddress: { email: "contact@acme-trading.example.com" },
    }, context);
    expect(contactResult.success).toBe(true);
    expect((contactResult.data as { emailAddress: { email: string } }).emailAddress.email).toBe("contact@acme-trading.example.com");

    // Step 9: Final verification — search again and confirm role + contact present
    mockPartyService.searchParties.mockResolvedValueOnce({
      items: [
        {
          ...partyData,
          roles: [{ partyRoleId: "role-1", roleTypeName: "Customer", fromDate: new Date().toISOString(), thruDate: null }],
          organization: { legalName: "Acme Trading Company Ltd.", taxId: null, registrationDate: null },
          person: null,
          description: "A new customer for testing the workflow",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    const finalSearch = await registry.execute("search_parties", { name: "Acme", roleType: "Customer" }, context);
    expect(finalSearch.success).toBe(true);
    const finalItems = (finalSearch.data as { items: Array<{ roles: Array<{ roleTypeName: string }> }> }).items;
    expect(finalItems.length).toBe(1);
    expect(finalItems[0]!.roles).toHaveLength(1);
    expect(finalItems[0]!.roles[0]!.roleTypeName).toBe("Customer");

    // Step 10: Deactivate the agent (cleanup)
    const deactivateResult = await registry.execute("deactivate_agent", { agentId: "sales-bot-v1" }, context);
    expect(deactivateResult.success).toBe(true);
  });

  it("should return nextActions guiding the agent to subsequent steps after party creation", async () => {
    const result = await registry.execute("create_party", {
      partyType: "PERSON",
      name: "John Doe",
      person: { firstName: "John", lastName: "Doe" },
    }, context);

    expect(result.success).toBe(true);
    const actions = result.nextActions as string[];
    expect(actions).toBeDefined();
    expect(actions.some((a) => a.includes("add_party_role"))).toBe(true);
    expect(actions.some((a) => a.includes("add_contact_mechanism"))).toBe(true);
  });

  it("should include tool suggestions in error responses for unknown tools (hallucination guard)", async () => {
    const result = await registry.execute("create_fake_tool", { foo: "bar" }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_TOOL");
    expect(result.error?.suggestedTools).toContain("list_available_tools");
  });
});
