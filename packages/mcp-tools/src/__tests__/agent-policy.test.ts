// Unit tests for the agent-policy middleware.
//
// The agent registry stored `capabilities` and `isActive`, and the MCP tool
// descriptions PROMISED they were enforced — but nothing read them back. An
// agent registered with `capabilities: ["search_parties"]` could call
// `create_party`, and a DEACTIVATED agent could call every tool. These tests
// pin the enforcement that now exists.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentPolicyMiddleware } from "../middleware/agent-policy.js";
import type { ToolContext, ToolDefinition } from "../schema/tool-definition.js";

const mockDefinition = { name: "create_party" } as unknown as ToolDefinition;

const mockContext: ToolContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  services: {},
};

function createPrisma(agent: unknown) {
  return {
    agentRegistry: {
      findUnique: vi.fn().mockResolvedValue(agent),
    },
  } as any;
}

function successNext() {
  return vi.fn().mockResolvedValue({ success: true, data: "ok" });
}

describe("agentPolicyMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the call through when the context carries NO agent id", async () => {
    // A call made by a HUMAN (or a service) is not restricted by the agent
    // registry — the agent rules exist to REDUCE a caller's authority, never
    // to grant it.
    const prisma = createPrisma(null);
    const next = successNext();
    const result = await agentPolicyMiddleware(prisma)({}, mockContext, mockDefinition, next);

    expect(result.success).toBe(true);
    expect(next).toHaveBeenCalled();
    expect(prisma.agentRegistry.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an UNREGISTERED agent", async () => {
    const prisma = createPrisma(null);
    const next = successNext();
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "ghost-agent" },
      mockDefinition,
      next,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_NOT_REGISTERED");
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a DEACTIVATED agent", async () => {
    // `deactivate_agent`'s description promises "preventing it from making
    // tool calls" — this is the promise.
    const prisma = createPrisma({ agentId: "agent-1", isActive: false, capabilities: ["create_party"] });
    const next = successNext();
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      next,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_INACTIVE");
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a tool that is not in the agent's capabilities", async () => {
    const prisma = createPrisma({ agentId: "agent-1", isActive: true, capabilities: ["search_parties"] });
    const next = successNext();
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      next,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_CAPABILITY_DENIED");
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a tool that IS in the agent's capabilities", async () => {
    const prisma = createPrisma({ agentId: "agent-1", isActive: true, capabilities: ["create_party", "search_parties"] });
    const next = successNext();
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      next,
    );

    expect(result.success).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it("scopes the lookup to the caller's tenant", async () => {
    const prisma = createPrisma({ agentId: "agent-1", isActive: true, capabilities: ["create_party"] });
    await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1", tenantId: "tenant-9" },
      mockDefinition,
      successNext(),
    );

    expect(prisma.agentRegistry.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId_tenantId: { agentId: "agent-1", tenantId: "tenant-9" } },
      }),
    );
  });

  it("treats a malformed capabilities column as NO capabilities", async () => {
    // A malformed row must not silently grant access to everything.
    for (const capabilities of [null, "create_party", 42, { create_party: true }]) {
      const prisma = createPrisma({ agentId: "agent-1", isActive: true, capabilities });
      const next = successNext();
      const result = await agentPolicyMiddleware(prisma)(
        {},
        { ...mockContext, agentId: "agent-1" },
        mockDefinition,
        next,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("AGENT_CAPABILITY_DENIED");
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("FAILS CLOSED when the registry lookup throws", async () => {
    // The middleware cannot distinguish "not allowed" from "could not check",
    // and allowing the call on an unknown state would make the control
    // bypassable by making the database unavailable.
    const prisma = {
      agentRegistry: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
    } as any;
    const next = successNext();
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      next,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_POLICY_UNAVAILABLE");
    expect(next).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the Prisma client is unavailable", async () => {
    const next = successNext();
    const result = await agentPolicyMiddleware(undefined as never)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      next,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_POLICY_UNAVAILABLE");
    expect(next).not.toHaveBeenCalled();
  });

  it("only suggests tools the rejected agent is ACTUALLY allowed to call", async () => {
    // Regression: every rejection suggested `list_available_tools`, which the
    // seeded default agent does NOT have in its capabilities — so an agent
    // that followed the advice was rejected again with AGENT_CAPABILITY_DENIED
    // for the very tool it was told to call. The error message itself points
    // at 'describe_agent', which the seeded agent DOES have.
    const prisma = createPrisma({
      agentId: "agent-1",
      isActive: true,
      capabilities: ["list_agents", "describe_agent", "search_parties", "get_party"],
    });
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      successNext(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_CAPABILITY_DENIED");
    // Every suggestion must be callable by this agent.
    expect(result.error?.suggestedTools).toEqual(["describe_agent"]);
  });

  it("offers no suggestion when the agent may call neither recovery tool", async () => {
    const prisma = createPrisma({ agentId: "agent-1", isActive: true, capabilities: ["search_parties"] });
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "agent-1" },
      mockDefinition,
      successNext(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.suggestedTools).toEqual([]);
  });

  it("keeps the generic suggestion when the capability list is unknown", async () => {
    // The agent is not registered at all — there is no capability list to
    // check against, so the generic suggestion is the best the middleware
    // can do.
    const prisma = createPrisma(null);
    const result = await agentPolicyMiddleware(prisma)(
      {},
      { ...mockContext, agentId: "ghost-agent" },
      mockDefinition,
      successNext(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AGENT_NOT_REGISTERED");
    expect(result.error?.suggestedTools).toEqual(["list_available_tools"]);
  });
});
