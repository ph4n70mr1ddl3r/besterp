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
// It never blocks; if the DB is unavailable it logs and passes through.

import { PrismaClient } from "@prisma/client";
import { ToolMiddleware } from "../schema/tool-definition.js";
import { sanitizeForLogOutput, stripHtmlTags } from "@besterp/shared";

/** Minimum length for an agent confirmation string. */
const MIN_CONFIRMATION_LENGTH = 10;

/** Maximum length for a confirmation string (prevents bloat in audit rows). */
const MAX_CONFIRMATION_LENGTH = 500;

/** Suggested tools returned when confirmation is missing or invalid. */
const SUGGESTED_TOOLS = ["list_available_tools"] as const;

/**
 * Build a confirmation-required error result for the given tool name.
 */
function confirmationRequiredError(toolName: string): { success: false; error: { code: string; message: string; suggestedTools: string[] } } {
  return {
    success: false,
    error: {
      code: "CONFIRMATION_REQUIRED",
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
      code: "INVALID_CONFIRMATION",
      message,
      suggestedTools: [...SUGGESTED_TOOLS],
    },
  };
}

/**
 * Validate the confirmation field from tool input. Returns the sanitized
 * confirmation string on success, or an error result on failure.
 */
function validateConfirmation(input: unknown, toolName: string):
  | { ok: true; confirmation: string }
  | { ok: false; error: { success: false; error: { code: string; message: string; suggestedTools: string[] } } } {
  const inputObj = (input != null && typeof input === "object" && !Array.isArray(input))
    ? input as Record<string, unknown>
    : null;

  if (inputObj === null) {
    return { ok: false, error: confirmationRequiredError(toolName) };
  }

  const rawConfirmation = inputObj["confirmation"];
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

  if (confirmation.length < MIN_CONFIRMATION_LENGTH) {
    return {
      ok: false,
      error: invalidConfirmationError(
        `Tool '${toolName}' requires a confirmation of at least ${MIN_CONFIRMATION_LENGTH} characters.`,
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
  const sanitized = sanitizeForLogOutput(stripHtmlTags(confirmation)).slice(0, MAX_CONFIRMATION_LENGTH);
  return { ok: true, confirmation: sanitized };
}

/**
 * Create a confirmation-gate middleware backed by PostgreSQL.
 *
 * Tools registered with riskLevel "high" or "critical" are checked against
 * the confirmation_gate table. If the gate is enabled for that tool, the
 * agent MUST provide a `confirmation` field in the tool input. The value
 * is validated (non-empty, within length bounds) and persisted to the audit
 * log alongside the tool input.
 *
 * @param prisma - Admin PrismaClient (superuser, bypasses RLS for reference data)
 */
export function confirmationGateMiddleware(prisma: PrismaClient): ToolMiddleware {
  return async (input, _context, definition, next) => {
    // Only gate high/critical risk tools — low/none/medium are trusted
    // enough to proceed without explicit agent confirmation.
    if (definition.riskLevel !== "high" && definition.riskLevel !== "critical") {
      return next(input, _context);
    }

    // Check whether this tool has a confirmation gate configured.
    // If the DB is unavailable, pass through (confirmation must never block).
    try {
      const gate = await prisma.confirmationGate.findUnique({
        where: { toolName: definition.name },
        select: { enabled: true },
      });
      if (!(gate?.enabled ?? false)) {
        return next(input, _context);
      }
    } catch {
      try {
        process.stderr.write(
          `[ConfirmationGate] Unable to check gate for '${definition.name}' — proceeding without gate\n`,
        );
      } catch {
        // stderr may be closed.
      }
      return next(input, _context);
    }

    const validation = validateConfirmation(input, definition.name);
    if (!validation.ok) {
      return validation.error;
    }

    // Attach the sanitized confirmation to the input so downstream
    // middleware (audit-log) captures it in toolInput.
    const safeInput = { ...(input as Record<string, unknown>), confirmation: validation.confirmation };
    return next(safeInput, _context);
  };
}
