// Agent MCP Tools — Tool definitions for the agent registry domain.
//
// These tools let AI agents and admins register, discover, and manage
// AI agent identities within a tenant. Implements AGENTIC_AI_DESIGN.md §8.1.

import { z } from "zod";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
} from "@besterp/mcp-tools";
import {
  InvalidTypeValueError,
  stripHtmlTags,
  MAX_AGENT_ID_LENGTH,
  MAX_PARTY_NAME_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
} from "@besterp/shared";
import type {
  RegisterAgentInput,
  UpdateAgentInput,
  AgentResult,
  SearchAgentsInput,
} from "../../modules/core/security/security.types.js";

interface SecurityServices {
  securityService: {
    registerAgent(input: RegisterAgentInput): Promise<AgentResult>;
    getAgent(tenantId: string, agentId: string): Promise<AgentResult>;
    searchAgents(input: SearchAgentsInput): Promise<{ items: AgentResult[]; total: number; limit: number; offset: number; hasMore: boolean }>;
    updateAgent(input: UpdateAgentInput): Promise<AgentResult>;
    deleteAgent(tenantId: string, agentId: string): Promise<{ success: boolean }>;
  };
}

function getSecurityService(ctx: ToolContext) {
  const svc = ctx.services.securityService;
  if (svc === undefined || svc === null || typeof svc !== "object") {
    throw new InvalidTypeValueError(
      "SecurityService not available in ToolContext.services",
      { context: { field: "securityService" } }
    );
  }
  const requiredMethods: (keyof SecurityServices["securityService"])[] = [
    "registerAgent", "getAgent", "searchAgents", "updateAgent", "deleteAgent",
  ];
  for (const method of requiredMethods) {
    if (typeof (svc as SecurityServices["securityService"])[method] !== "function") {
      throw new InvalidTypeValueError(
        `SecurityService in ToolContext.services is missing required method '${method}'`,
        { context: { field: "securityService", missingMethod: method } }
      );
    }
  }
  return svc as SecurityServices["securityService"];
}

function agentIdParam(description: string) {
  return z.string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(MAX_AGENT_ID_LENGTH).describe(description));
}

function agentNameParam(description: string) {
  return z.string()
    .transform((s) => stripHtmlTags(s.trim()))
    .pipe(z.string().min(1).max(MAX_PARTY_NAME_LENGTH).describe(description));
}

// ─── Tool: register_agent ────────────────────────────────────────

const registerAgentSchema = z.strictObject({
  agentId: agentIdParam("Unique identifier for this agent (e.g., 'sales-assistant-v1')"),
  displayName: agentNameParam("Display name for the agent (e.g., 'Sales Assistant')"),
  description: z.string()
    .transform((s) => stripHtmlTags(s.trim()))
    .pipe(z.string().min(1).max(1000))
    .describe("AI-readable description of this agent's purpose and capabilities"),
  capabilities: z.array(z.string().min(1).max(100))
    .min(1)
    .max(50)
    .describe("List of tool names this agent is allowed to call (e.g., ['create_party', 'search_parties'])"),
  version: z.string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(64))
    .describe("Semantic version string (e.g., '1.0.0')"),
  maxToolCallsPerConversation: z.number().int().min(1).max(10000).optional()
    .describe("Max tool calls per conversation (default: 100)"),
  maxConcurrentConversations: z.number().int().min(1).max(100).optional()
    .describe("Max concurrent conversations (default: 5)"),
  maxTransactionAmount: z.number().min(0).optional()
    .describe("Per-operation financial limit in tenant base currency (default: 0 = unlimited)"),
  allowedEntityTypes: z.array(z.string().min(1).max(64)).optional()
    .describe("Entity types this agent can interact with (e.g., ['party', 'order'])"),
  rateLimitPerMinute: z.number().int().min(1).max(1000).optional()
    .describe("Max tool calls per minute (default: 30)"),
});

type RegisterAgentInput_z = z.infer<typeof registerAgentSchema>;

const registerAgent: ToolDefinition = {
  name: "register_agent",
  description: `Register a new AI agent in the tenant's agent registry.

Use this to create an agent identity that can be used with MCP tools.
The agent registry enforces capabilities, rate limits, and financial restrictions.

Example: Register a sales assistant agent
  register_agent({
    agentId: "sales-assistant-v1",
    displayName: "Sales Assistant",
    description: "Helps sales team create quotes and orders",
    capabilities: ["create_party", "search_parties", "get_party"],
    version: "1.0.0"
  })`,

  inputSchema: registerAgentSchema,

  riskLevel: "high",
  entity: "agent_registry",
  tags: ["security", "agent", "create"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as RegisterAgentInput_z;
    const svc = getSecurityService(context);
    const agent = await svc.registerAgent({
      tenantId: context.tenantId,
      agentId: input.agentId,
      displayName: input.displayName,
      description: input.description,
      capabilities: input.capabilities,
      maxToolCallsPerConversation: input.maxToolCallsPerConversation,
      maxConcurrentConversations: input.maxConcurrentConversations,
      maxTransactionAmount: input.maxTransactionAmount ?? 0,
      allowedEntityTypes: input.allowedEntityTypes,
      rateLimitPerMinute: input.rateLimitPerMinute,
      version: input.version,
    });
    return {
      success: true,
      data: agent,
      nextActions: [
        "Use 'list_agents' to see all registered agents.",
        "Use the registered agentId in future tool calls via the agentId context field.",
      ],
    };
  },
};

// ─── Tool: list_agents ────────────────────────────────────────────

const listAgentsSchema = z.strictObject({
  agentId: agentIdParam("Filter by specific agent ID").optional(),
  isActive: z.boolean().optional().describe("Filter by active status"),
  limit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT),
  offset: z.number().int().min(MIN_SEARCH_OFFSET).max(MAX_SEARCH_OFFSET).optional().default(0),
});

type ListAgentsInput_z = z.infer<typeof listAgentsSchema>;

const listAgents: ToolDefinition = {
  name: "list_agents",
  description: `List AI agents registered in the current tenant.

Returns paginated results. Use this to discover available agents or verify
agent configuration before using them in tool calls.`,

  inputSchema: listAgentsSchema,

  riskLevel: "none",
  entity: "agent_registry",
  tags: ["security", "agent", "read"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as ListAgentsInput_z;
    const svc = getSecurityService(context);
    const result = await svc.searchAgents({
      tenantId: context.tenantId,
      agentId: input.agentId,
      isActive: input.isActive,
      limit: input.limit,
      offset: input.offset,
    });
    return {
      success: true,
      data: result,
      nextActions: [
        "Use 'describe_agent' with an agentId to see full details.",
        "Use 'register_agent' to create a new agent.",
      ],
    };
  },
};

// ─── Tool: describe_agent ─────────────────────────────────────────

const describeAgentSchema = z.strictObject({
  agentId: agentIdParam("The agent ID to describe"),
});

type DescribeAgentInput_z = z.infer<typeof describeAgentSchema>;

const describeAgent: ToolDefinition = {
  name: "describe_agent",
  description: `Get detailed information about a registered agent.

Returns the agent's capabilities, restrictions, and status.
Use this before calling tools that require agent-specific permissions.`,

  inputSchema: describeAgentSchema,

  riskLevel: "none",
  entity: "agent_registry",
  tags: ["security", "agent", "discovery"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as DescribeAgentInput_z;
    const svc = getSecurityService(context);
    const agent = await svc.getAgent(context.tenantId, input.agentId);
    return {
      success: true,
      data: agent,
      nextActions: [
        "Use 'list_agents' to see all agents in this tenant.",
      ],
    };
  },
};

// ─── Tool: update_agent ──────────────────────────────────────────

const updateAgentSchema = z.strictObject({
  agentId: agentIdParam("The agent ID to update"),
  displayName: agentNameParam("New display name").optional(),
  description: z.string()
    .transform((s) => stripHtmlTags(s.trim()))
    .pipe(z.string().min(1).max(1000))
    .optional()
    .describe("New description"),
  capabilities: z.array(z.string().min(1).max(100)).optional()
    .describe("Updated capability list"),
  version: z.string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(64).optional())
    .describe("New version string"),
  maxToolCallsPerConversation: z.number().int().min(1).max(10000).optional(),
  maxConcurrentConversations: z.number().int().min(1).max(100).optional(),
  maxTransactionAmount: z.number().min(0).optional(),
  allowedEntityTypes: z.array(z.string().min(1).max(64)).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(1000).optional(),
  isActive: z.boolean().optional(),
}).refine(
  (data) => Object.keys(data).some((k) => k !== "agentId"),
  { message: "At least one updatable field must be provided." }
);

type UpdateAgentInput_z = z.infer<typeof updateAgentSchema>;

const updateAgent: ToolDefinition = {
  name: "update_agent",
  description: `Update an existing agent's configuration.

Use this to modify agent capabilities, rate limits, or status.
Only specified fields are updated; omitting a field leaves it unchanged.`,

  inputSchema: updateAgentSchema,

  riskLevel: "high",
  entity: "agent_registry",
  tags: ["security", "agent", "update"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as UpdateAgentInput_z;
    const svc = getSecurityService(context);
    const updateInput: Parameters<typeof svc.updateAgent>[0] = {
      tenantId: context.tenantId,
      agentId: input.agentId,
      ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.capabilities !== undefined && { capabilities: input.capabilities }),
      ...(input.version !== undefined && { version: input.version }),
      ...(input.maxToolCallsPerConversation !== undefined && { maxToolCallsPerConversation: input.maxToolCallsPerConversation }),
      ...(input.maxConcurrentConversations !== undefined && { maxConcurrentConversations: input.maxConcurrentConversations }),
      ...(input.maxTransactionAmount !== undefined && { maxTransactionAmount: input.maxTransactionAmount }),
      ...(input.allowedEntityTypes !== undefined && { allowedEntityTypes: input.allowedEntityTypes }),
      ...(input.rateLimitPerMinute !== undefined && { rateLimitPerMinute: input.rateLimitPerMinute }),
    };
    const agent = await svc.updateAgent(updateInput);
    return {
      success: true,
      data: agent,
      nextActions: [
        "Use 'describe_agent' to verify the updated configuration.",
      ],
    };
  },
};

// ─── Tool: deactivate_agent ──────────────────────────────────────

const deactivateAgentSchema = z.strictObject({
  agentId: agentIdParam("The agent ID to deactivate"),
});

type DeactivateAgentInput_z = z.infer<typeof deactivateAgentSchema>;

const deactivateAgent: ToolDefinition = {
  name: "deactivate_agent",
  description: `Deactivate an agent, preventing it from making tool calls.

The agent record is preserved (soft delete) so it can be reactivated later.
Use this instead of delete_agent when you want to temporarily disable an agent.`,

  inputSchema: deactivateAgentSchema,

  riskLevel: "critical",
  entity: "agent_registry",
  tags: ["security", "agent", "update"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as DeactivateAgentInput_z;
    const svc = getSecurityService(context);
    const updateInput: UpdateAgentInput = {
      tenantId: context.tenantId,
      agentId: input.agentId,
      isActive: false,
    };
    const agent = await svc.updateAgent(updateInput);
    return {
      success: true,
      data: { agentId: agent.agentId, isActive: false },
      nextActions: [
        "Use 'list_agents' to see all agents.",
      ],
    };
  },
};

// ─── Tool: delete_agent ────────────────────────────────────────

const deleteAgentSchema = z.strictObject({
  agentId: agentIdParam("The agent ID to delete"),
});

type DeleteAgentInput_z = z.infer<typeof deleteAgentSchema>;

const deleteAgent: ToolDefinition = {
  name: "delete_agent",
  description: `Permanently delete a registered AI agent from the tenant.

Unlike deactivate_agent (which soft-disables), this removes the agent record entirely.
This operation is irreversible — use deactivate_agent if you want to temporarily
disable an agent instead.`,

  inputSchema: deleteAgentSchema,

  riskLevel: "critical",
  entity: "agent_registry",
  tags: ["security", "agent", "delete"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as DeleteAgentInput_z;
    const svc = getSecurityService(context);
    const result = await svc.deleteAgent(context.tenantId, input.agentId);
    return {
      success: true,
      data: result,
      nextActions: [
        "Use 'list_agents' to verify the agent has been removed.",
      ],
    };
  },
};

// ─── Registration ─────────────────────────────────────────────────

export function registerAgentTools(registry: ToolRegistry): void {
  registry.register(registerAgent);
  registry.register(listAgents);
  registry.register(describeAgent);
  registry.register(updateAgent);
  registry.register(deactivateAgent);
  registry.register(deleteAgent);
}
