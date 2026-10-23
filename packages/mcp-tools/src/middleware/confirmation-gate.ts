// Confirmation Gate Middleware — Enforces agent confirmation for high-risk tools.
//
// Implements Principle 10 from AGENTIC_AI_DESIGN.md: AI-Traceable Audit.
// Before executing a tool marked as requiring confirmation, this middleware
// checks the confirmation_gate table. If enabled, the tool MUST carry a
// `confirmation` field (string) explaining why the agent believes this
// operation should proceed. The confirmation is persisted to ai_action_log
// so operators can audit agent reasoning.
//
// This is a global middleware — registered once in McpService.onModuleInit().
//
// FAIL CLOSED
// A lookup failure (the database is unreachable, the query throws) REJECTS
// the call. The middleware cannot distinguish "this tool is not gated" from
// "we could not check", and allowing the call on an unknown state would make
// the control bypassable by making the database unavailable: a high-risk
// write would execute with no confirmation and no recorded justification.
// The sibling `agentPolicy` middleware in the same pipeline already fails
// closed for exactly this reason, and the two must not disagree.
//
// ENVELOPE CONTRACT: the `confirmation` value travels on the ToolContext
// (promoted from the tool arguments by ToolRegistry.execute), NOT on the
// tool input. Every tool schema is a `z.strictObject` that rejects
// undeclared keys, so a confirmation injected into the input made the final
// Zod step reject EVERY gated tool with "Unrecognized key(s) in object:
// 'confirmation'" — the gate was a dead end, and because the idempotency
// middleware hashes the input through the same strict schema, idempotency
// was silently disabled for every gated tool as well.

import { PrismaClient } from "@prisma/client";
import { ToolMiddleware, ToolContext } from "../schema/tool-definition.js";
import {
  sanitizeForLogOutput,
  normalizeUnpairedSurrogates,
  stripHtmlTags,
  MIN_CONFIRMATION_LENGTH,
  MAX_CONFIRMATION_LENGTH,
} from "@besterp/shared";
import { CONFIRMATION_GATE_UNAVAILABLE, CONFIRMATION_REQUIRED, INVALID_CONFIRMATION } from "../error-codes.js";

/** Suggested tools returned when confirmation is missing or invalid. */
const SUGGESTED_TOOLS = ["list_available_tools"] as const;

/**
 * Build a confirmation-required error result for the given tool name.
 */
function confirmationRequiredError(toolName: string): { success: false; error: { code: string; message: string; suggestedTools: string[] } } {
  return {
    success: false,
    error: {
      code: CONFIRMATION_REQUIRED,
      message: `Tool '${toolName}' requires agent confirmation. Pass a 'confirmation' field explaining why this operation should proceed.`,
      suggestedTools: [...SUGGESTED_TOOLS],
    },
  };
}

/**
 * Build an invalid-confirmation error result for the given message.
 */
function invalidConfirmationError(message: string): { success: false; error: { code: string; message: string; suggestedTools: string[] } } {
  return {
    success: false,
    error: {
      code: INVALID_CONFIRMATION,
      message,
      suggestedTools: [...SUGGESTED_TOOLS],
    },
  };
}

/**
 * Read the raw confirmation from the tool context.
 *
 * The context is the authoritative carrier (ToolRegistry.execute promotes
 * the value out of the tool arguments and strips it from the validated
 * input). The tool input is only consulted as a fallback so the middleware
 * still works when it is composed outside the registry.
 */
function readConfirmation(input: unknown, context: ToolContext): unknown {
  if (context.confirmation !== undefined) return context.confirmation;
  const inputObj = (input != null && typeof input === "object" && !Array.isArray(input))
    ? input as Record<string, unknown>
    : null;
  return inputObj === null ? undefined : inputObj["confirmation"];
}

/**
 * Validate the confirmation field. Returns the sanitized confirmation string
 * on success, or an error result on failure.
 */
function validateConfirmation(rawConfirmation: unknown, toolName: string):
  | { ok: true; confirmation: string }
  | { ok: false; error: { success: false; error: { code: string; message: string; suggestedTools: string[] } } } {
  if (rawConfirmation === undefined || rawConfirmation === null) {
    return { ok: false, error: confirmationRequiredError(toolName) };
  }

  if (typeof rawConfirmation !== "string") {
    return {
      ok: false,
      error: invalidConfirmationError(
        `Tool '${toolName}' requires a string 'confirmation' field.`,
      ),
    };
  }

  const confirmation = rawConfirmation.trim();
  if (confirmation.length === 0) {
    return {
      ok: false,
      error: invalidConfirmationError(
        `Tool '${toolName}' requires a non-empty 'confirmation' field.`,
      ),
    };
  }

  if (confirmation.length > MAX_CONFIRMATION_LENGTH) {
    return {
      ok: false,
      error: invalidConfirmationError(
        `Tool '${toolName}' confirmation exceeds ${MAX_CONFIRMATION_LENGTH} characters.`,
      ),
    };
  }

  // Sanitize before propagating: a confirmation can carry connection-string
  // / API-key payloads if the agent echoes attacker-supplied text back.
  const sanitized = normalizeUnpairedSurrogates(sanitizeForLogOutput(stripHtmlTags(confirmation))).slice(0, MAX_CONFIRMATION_LENGTH);

  // Validate the SANITIZED value, not the raw one. The value that is
  // propagated on the context and persisted to `ai_action_log.toolInput` is
  // the post-strip one, and `stripHtmlTags` deletes HTML comments and tags —
  // so a markup-only confirmation (e.g. `<!--` + justification + `-->`)
  // passed the length check on the RAW value but collapsed to an EMPTY string,
  // and the high-risk operation then executed with no recorded justification
  // at all.
  if (sanitized.trim().length < MIN_CONFIRMATION_LENGTH) {
    return {
      ok: false,
      error: invalidConfirmationError(
        `Tool '${toolName}' requires a confirmation of at least ${MIN_CONFIRMATION_LENGTH} characters of visible text.`,
      ),
    };
  }

  return { ok: true, confirmation: sanitized };
}

/**
 * Build the error result for a gate lookup that could not be completed.
 *
 * The gate is a security control on high/critical-risk tools, so an
 * unverifiable gate must BLOCK the call rather than wave it through. The
 * agent can retry once the database is healthy.
 */
function gateUnavailableError(toolName: string): { success: false; error: { code: string; message: string; suggestedTools: string[] } } {
  return {
    success: false,
    error: {
      code: CONFIRMATION_GATE_UNAVAILABLE,
      message: `Tool '${toolName}' requires an agent confirmation, but the confirmation gate could not be verified. The operation did NOT run. Retry when the service is healthy.`,
      suggestedTools: [...SUGGESTED_TOOLS],
    },
  };
}

/**
 * Create a confirmation-gate middleware backed by PostgreSQL.
 *
 * Tools registered with riskLevel "high" or "critical" are checked against
 * the confirmation_gate table. If the gate is enabled for that tool, the
 * agent MUST provide a `confirmation` field in the tool input. The value
 * is validated (non-empty, within length bounds) and propagated on the
 * context so the audit middleware can persist it in the durable audit row.
 *
 * The gate MUST run BEFORE the idempotency middleware: a request rejected
 * for a missing/invalid confirmation never reaches the handler, so it must
 * not consume the caller's idempotency key (otherwise the agent's next
 * attempt with a valid confirmation would be rejected as "already in
 * progress" for the full stale-pending window).
 *
 * @param prisma - Admin PrismaClient (superuser, bypasses RLS for reference data)
 */
export function confirmationGateMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, context, definition, next) => {
    // Only gate high/critical risk tools — low/none/medium are trusted
    // enough to proceed without explicit agent confirmation.
    if (definition.riskLevel !== "high" && definition.riskLevel !== "critical") {
      return next(input, context);
    }

    // Check whether this tool has a confirmation gate configured.
    //
    // A lookup failure BLOCKS the call (see the FAIL CLOSED note at the top
    // of this file). It used to pass through, which made the control
    // bypassable by making the database unavailable: with the gate table
    // unreachable, a high-risk write executed with no confirmation and no
    // justification recorded in the audit trail.
    try {
      const gate = await prisma.confirmationGate.findUnique({
        where: { toolName: definition.name },
        select: { enabled: true },
      });
      if (!(gate?.enabled ?? false)) {
        return next(input, context);
      }
    } catch {
      try {
        process.stderr.write(
          `[ConfirmationGate] Unable to check gate for '${definition.name}' — blocking the call\n`,
        );
      } catch {
        // stderr may be closed.
      }
      return gateUnavailableError(definition.name);
    }

    const validation = validateConfirmation(readConfirmation(input, context), definition.name);
    if (!validation.ok) {
      return validation.error;
    }

    // Propagate the SANITIZED confirmation on the context (the input is left
    // untouched — tool schemas reject undeclared keys). The audit middleware
    // reads `context.confirmation` to persist the agent's justification.
    const safeContext: ToolContext = { ...context, confirmation: validation.confirmation };
    return next(input, safeContext);
  };
}
