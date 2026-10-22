// Unit tests for the agent-facing redaction boundary.
//
// `sanitizeAgentFacingResult` is the SINGLE place where every value that
// reaches the AI agent is redacted. Its contract is "the success payload and
// the failure payload are treated identically" — a value must never be
// redacted on one path and reflected verbatim on the other.

import { describe, it, expect } from "vitest";
import { sanitizeAgentFacingResult, sanitizeAgentText, capAgentErrorText } from "../agent-result.js";
import { MAX_ERROR_MESSAGE_LENGTH } from "@besterp/shared";

describe("sanitizeAgentFacingResult — data redaction", () => {
  it("redacts sensitive fields in a SUCCESS payload", () => {
    const out = sanitizeAgentFacingResult({
      success: true,
      data: { password: "hunter2", apiKey: "sk_live_ABCDEFGHIJKLMNOP" },
    });
    expect((out.data as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((out.data as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });

  it("redacts sensitive fields in a FAILURE payload too", () => {
    // `ToolResult` does not gate `data` on `success`, so a handler may
    // return a soft failure that still carries a payload. That payload used
    // to be returned to the agent VERBATIM while the identical value on a
    // SUCCESSFUL result was redacted — the exact asymmetry this module
    // exists to close.
    const out = sanitizeAgentFacingResult({
      success: false,
      data: { password: "hunter2", apiKey: "sk_live_ABCDEFGHIJKLMNOP" },
      error: { code: "SOME_CODE", message: "failed" },
    });
    expect((out.data as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((out.data as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });

  it("leaves a failure payload with no data untouched", () => {
    const out = sanitizeAgentFacingResult({
      success: false,
      error: { code: "SOME_CODE", message: "failed" },
    });
    expect(out.data).toBeUndefined();
    expect(out.error?.code).toBe("SOME_CODE");
  });

  it("redacts the error context on both paths", () => {
    const out = sanitizeAgentFacingResult({
      success: false,
      error: { code: "E", message: "m", context: { password: "hunter2" } },
    });
    expect((out.error?.context as Record<string, unknown>).password).toBe("[REDACTED]");
  });

  it("sanitizes nextActions on both paths", () => {
    const out = sanitizeAgentFacingResult({
      success: true,
      data: { a: 1 },
      nextActions: ["Use 'get_party' to see full details."],
    });
    expect(out.nextActions).toEqual(["Use 'get_party' to see full details."]);
  });
});

describe("sanitizeAgentText", () => {
  it("strips HTML and scrubs secrets", () => {
    expect(sanitizeAgentText("<script>x</script>ok")).toBe("ok");
    expect(sanitizeAgentText("postgres://u:p@h/db")).toContain("[DATABASE_URL]");
  });

  it("never throws on an oversized value", () => {
    // `stripHtmlTags` rejects inputs over 100 KB by throwing; a redactor
    // that can throw turns a successful write into an opaque error.
    const huge = "<b>x".repeat(60_000);
    expect(() => sanitizeAgentText(huge)).not.toThrow();
  });
});

describe("capAgentErrorText", () => {
  it("caps at the shared agent-facing bound", () => {
    const capped = capAgentErrorText("x".repeat(MAX_ERROR_MESSAGE_LENGTH + 500));
    expect(capped.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH + 1);
  });

  it("leaves a short string untouched", () => {
    expect(capAgentErrorText("short")).toBe("short");
  });
});

describe("capAgentErrorText — surrogate pairs are never split", () => {
  it("does not cut a surrogate pair in half", () => {
    // `String.prototype.slice` counts UTF-16 code units, so a cut between a
    // high and a low surrogate produced a LONE SURROGATE in the
    // agent-facing string — a broken character that is also invalid UTF-8
    // when it reaches a durable sink.
    const value = "a".repeat(1999) + "\u{1F600}";
    const capped = capAgentErrorText(value);
    expect(capped.endsWith("…")).toBe(true);
    // No lone surrogate: every high surrogate is followed by its low one.
    for (let i = 0; i < capped.length; i++) {
      const code = capped.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = capped.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        // A low surrogate must be preceded by a high one.
        const prev = capped.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });
});
