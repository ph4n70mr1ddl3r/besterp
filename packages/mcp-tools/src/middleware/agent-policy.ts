// Agent Policy Middleware — Enforces the agent registry's restrictions.
//
// Implements AGENTIC_AI_DESIGN.md §8.1: "Every AI agent must be registered
// before it can use the system" and "The AI agent never has MORE permission
// than the human it acts on behalf of. It may have LESS (agent restrictions),
// but never more."
//
// This is a global middleware — registered once in McpService.onModuleInit().
//
// WHY THIS EXISTS
// The agent registry stored `capabilities`, `isActive` and the rate/limit
// fields, and the MCP tool descriptions PROMISED they were enforced:
//
//   * register_agent: "The agent registry enforces capabilities, rate limits,
//     and financial restrictions."
//   * deactivate_agent: "Deactivate an agent, preventing it from making tool
//     calls."
//
// but NOTHING read them back. Verified against a live database: an agent
// registered with `capabilities: ["search_parties"]` could still call
// `create_party`, and a JWT carrying a DEACTIVATED agent's id still
// executed every tool in the registry, including the destructive ones. The
// restrictions were decorative.
//
// WHAT IS ENFORCED HERE
//   * Registration — an agent id that is not in the registry cannot call any
//     tool.
//   * Activity      — a deactivated agent cannot call any tool.
//   * Capabilities  — the tool being called must be listed in the agent's
//     `capabilities`, which the schema documents as "List of tool names this
//     agent is allowed to call".
//
// WHAT IS NOT ENFORCED HERE (and why)
//   * `rateLimitPerMinute`, `maxToolCallsPerConversation` and
//     `maxConcurrentConversations` need a durable per-agent usage counter.
//     The `agent_usage` table from AGENTIC_AI_DESIGN.md §8.2 does not exist
//     in the schema, and an in-process counter would not survive a restart
//     or be shared across replicas — it would give a false sense of control.
//     The tool descriptions say so explicitly instead of claiming a control
//     that does not exist.
//   * `maxTransactionAmount` needs the amount of the operation, which no
//     tool reports. It is documented as "not yet enforced" for the same
//     reason.
//   * `allowedEntityTypes` is NOT enforced: the seeded default agent lists
//     `allowedEntityTypes: ["party"]` but `capabilities: ["list_agents",
//     "describe_agent", ...]` — the agent-registry tools have entity
//     "agent", so enforcing both rules at once would make the shipped seed
//     data self-contradictory and unusable.
//
// FAIL CLOSED
// A lookup failure (the database is unreachable, the query throws) rejects
// the call. The middleware cannot distinguish "the agent is not allowed"
// from "we could not check", and allowing the call on an unknown state would
// make the control bypassable by making the database unavailable.

import { PrismaClient } from "@prisma/client";
import { ToolMiddleware } from "../schema/tool-definition.js";
import { sanitizeForLogOutput } from "@besterp/shared";

/** Suggested tools returned when an agent is not permitted to make the call. */
const SUGGESTED_TOOLS = ["list_available_tools"] as const;

/** The subset of the agent registry row this middleware needs. */
interface AgentPolicyRow {
  agentId: string;
  isActive: boolean;
  capabilities: unknown;
}

/**
 * Read the capability list off a registry row.
 *
 * The column is a JSON array of tool names. A row whose value is not an
 * array (or contains non-strings) is treated as NO capabilities — a
 * malformed row must not silently grant access to everything.
 */
function readCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Create the agent-policy middleware.
 *
 * @param prisma - Prisma client used to read the agent registry. The lookup
 *                 is explicitly scoped by `tenantId`, so it cannot read (or
 *                 grant access to) another tenant's agent.
 */
export function agentPolicyMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    // No agent id on the context means the call is made by a HUMAN acting
    // directly (or by a service). The agent registry places no restrictions
    // on that path — the agent rules exist to REDUCE a caller's authority,
    // never to grant it.
    const agentId = context.agentId;
    if (agentId === undefined || agentId === "") {
      return next(input, context);
    }

    if (!prisma?.agentRegistry) {
      // Fail closed: without a registry lookup the agent's restrictions
      // cannot be verified.
      return {
        success: false,
        error: {
          code: "AGENT_POLICY_UNAVAILABLE",
          message: "The agent registry is unavailable, so the agent's permissions cannot be verified.",
          suggestedTools: [...SUGGESTED_TOOLS],
          context: { agentId: sanitizeForLogOutput(agentId) },
        },
      };
    }

    let agent: AgentPolicyRow | null;
    try {
      agent = await prisma.agentRegistry.findUnique({
        where: { agentId_tenantId: { agentId, tenantId: context.tenantId } },
        select: { agentId: true, isActive: true, capabilities: true },
      });
    } catch {
      // Fail closed — see the header comment.
      return {
        success: false,
        error: {
          code: "AGENT_POLICY_UNAVAILABLE",
          message: "The agent registry could not be read, so the agent's permissions could not be verified.",
          suggestedTools: [...SUGGESTED_TOOLS],
          context: { agentId: sanitizeForLogOutput(agentId) },
        },
      };
    }

    if (!agent) {
      return {
        success: false,
        error: {
          code: "AGENT_NOT_REGISTERED",
          message: `Agent '${sanitizeForLogOutput(agentId)}' is not registered in this tenant.`,
          suggestedTools: [...SUGGESTED_TOOLS],
          context: { agentId: sanitizeForLogOutput(agentId) },
        },
      };
    }

    if (!agent.isActive) {
      return {
        success: false,
        error: {
          code: "AGENT_INACTIVE",
          message: `Agent '${sanitizeForLogOutput(agentId)}' is deactivated and cannot call tools.`,
          suggestedTools: [...SUGGESTED_TOOLS],
          context: { agentId: sanitizeForLogOutput(agentId) },
        },
      };
    }

    const capabilities = readCapabilities(agent.capabilities);
    if (!capabilities.includes(definition.name)) {
      return {
        success: false,
        error: {
          code: "AGENT_CAPABILITY_DENIED",
          message:
            `Agent '${sanitizeForLogOutput(agentId)}' is not permitted to call '${sanitizeForLogOutput(definition.name)}'. ` +
            `Use 'describe_agent' to review the agent's capabilities.`,
          suggestedTools: [...SUGGESTED_TOOLS],
          context: { agentId: sanitizeForLogOutput(agentId), tool: definition.name },
        },
      };
    }

    return next(input, context);
  };
}
