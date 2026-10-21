// Agent-facing result sanitization.
//
// EVERY value that reaches the AI agent must pass through the same redaction
// the durable sinks use (`redactSensitiveFieldValues`). Before this module
// existed, the agent-facing redaction lived INSIDE the audit middleware, which
// meant:
//
//   * A handler that RETURNED a soft failure (`{ success: false, error: {
//     code, message, context } }` — the normal business-rule path) never went
//     through the audit middleware's redaction, because that branch is gated
//     on `result.success`. The `error.context` was reflected to the agent
//     VERBATIM, while the identical value was redacted in the durable audit
//     row, in the idempotency record and on the thrown-error path.
//   * When the audit middleware short-circuited (no Prisma client available)
//     the redaction was skipped entirely, and any pipeline composed WITHOUT
//     the audit middleware lost it too — the redaction was coupled to a
//     side-effect sink instead of to the agent-facing boundary.
//
// This module is that boundary. It is applied by the registry's final
// handler (so every HANDLER result is sanitized no matter which middlewares
// are composed), by the audit middleware (so results produced by a MIDDLEWARE
// are sanitized too), and by the error handler (so a THROWN error is
// sanitized once it has been converted into a result).

import {
  redactSensitiveFieldValues,
  sanitizeForLogOutput,
  stripHtmlTags,
  MAX_ERROR_MESSAGE_LENGTH,
} from "@besterp/shared";
import type { ToolResult } from "./schema/tool-definition.js";

/**
 * Sanitize a single agent-facing string.
 *
 * Never throws: `stripHtmlTags` rejects inputs over 100 KB, and a redactor
 * that can throw would turn a successful write into an opaque error (the
 * exact failure mode that the audit middleware's `nextActions` handling had).
 */
export function sanitizeAgentText(value: string): string {
  try {
    return sanitizeForLogOutput(stripHtmlTags(value));
  } catch {
    // Never let a redactor break the tool call. The value is returned
    // sanitized (control chars / ANSI / secrets) even if the HTML strip
    // could not run.
    try {
      return sanitizeForLogOutput(value);
    } catch {
      return "";
    }
  }
}

/**
 * Cap an agent-facing error string at MAX_ERROR_MESSAGE_LENGTH.
 *
 * The registry's INVALID_INPUT path caps the joined issue summary at the same
 * bound, so the DomainError path had no cap at all (only the internal 100 KB
 * sanitizer truncation), and the two surfaces disagreed on how large an
 * agent-facing error message may be.
 */
export function capAgentErrorText(value: string): string {
  return value.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : value;
}

/**
 * Sanitize a tool result for the AI agent.
 *
 * Applied to the SUCCESS payload (`data`), to the FAILURE payload
 * (`error.code` / `error.message` / `error.suggestedTools` /
 * `error.context`) and to `nextActions`.
 */
export function sanitizeAgentFacingResult(result: ToolResult): ToolResult {
  const nextActions = Array.isArray(result.nextActions)
    ? result.nextActions.map((n) => (typeof n === "string" ? sanitizeAgentText(n) : n))
    : result.nextActions;

  if (result.success) {
    if (result.data == null) {
      return nextActions === result.nextActions ? result : { ...result, nextActions };
    }
    return {
      ...result,
      data: redactSensitiveFieldValues(result.data),
      nextActions,
    };
  }

  const error = result.error;
  if (!error) {
    return nextActions === result.nextActions ? result : { ...result, nextActions };
  }
  return {
    ...result,
    nextActions,
    error: {
      code: capAgentErrorText(sanitizeAgentText(error.code)),
      message: capAgentErrorText(sanitizeAgentText(error.message)),
      suggestedTools: error.suggestedTools?.map((t) => capAgentErrorText(sanitizeAgentText(t))),
      context: error.context == null
        ? undefined
        : (redactSensitiveFieldValues(error.context) as Record<string, unknown>),
    },
  };
}
