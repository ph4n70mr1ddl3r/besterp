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
  normalizeUnpairedSurrogates,
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
    return normalizeUnpairedSurrogates(sanitizeForLogOutput(stripHtmlTags(value)));
  } catch {
    // Never let a redactor break the tool call. The value is returned
    // sanitized (control chars / ANSI / secrets) even if the HTML strip
    // could not run.
    try {
      return normalizeUnpairedSurrogates(sanitizeForLogOutput(value));
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
  const safe = normalizeUnpairedSurrogates(value);
  if (safe.length <= MAX_ERROR_MESSAGE_LENGTH) return safe;
  // Slice on a CHARACTER boundary, not a UTF-16 code-unit boundary.
  // `String.prototype.slice` counts UTF-16 code units, so a cut between a
  // high and a low surrogate produced a LONE SURROGATE in the agent-facing
  // string — a broken character that is also invalid UTF-8 when it reaches a
  // durable sink. The shared sanitizer already solves this (it iterates
  // `[...message]`), so the local cap must not reintroduce the problem.
  return `${truncateAtCharacterBoundary(safe, MAX_ERROR_MESSAGE_LENGTH)}…`;
}

/**
 * Truncate a string to at most `maxLength` CHARACTERS without splitting a
 * surrogate pair.
 */
export function truncateAtCharacterBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  // `[...value]` iterates by code point, so an astral character counts as
  // one element and is never split.
  const chars = [...value];
  if (chars.length <= maxLength) return value;
  return chars.slice(0, maxLength).join("");
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

  // A FAILURE result may still carry `data` — `ToolResult` does not gate
  // `data` on `success`. That payload used to be returned to the agent
  // VERBATIM, while the identical value on a SUCCESSFUL result was
  // redacted. The asymmetry is exactly the leak class this module exists to
  // close: a handler that returns "the record I could not create, but here
  // is its password field" would expose a secret on the failure path and
  // not on the success path. The success branch above already redacts
  // unconditionally, so the failure branch must do the same.
  const redactedData = result.data == null
    ? result.data
    : redactSensitiveFieldValues(result.data);

  const error = result.error;
  if (!error) {
    const base = redactedData === result.data ? result : { ...result, data: redactedData };
    return nextActions === result.nextActions ? base : { ...base, nextActions };
  }
  return {
    ...result,
    data: redactedData,
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
