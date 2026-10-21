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
