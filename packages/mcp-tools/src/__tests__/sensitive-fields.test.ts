// Unit tests for sensitive-field detection (shared by audit-log + error-handler)

import { describe, it, expect } from "vitest";
import { isSensitiveFieldName, splitFieldNameTokens } from "@besterp/shared";
import { redactSensitiveFields } from "../middleware/audit-log.js";

// The tests below exercise the canonical @besterp/shared implementation directly.
// No local shim is needed — tool-registry.ts and audit-log.ts both import from
// @besterp/shared, so this file tests the exact code path every consumer uses.

describe("isSensitiveFieldName", () => {
  it("should catch explicit sensitive field names", () => {
    expect(isSensitiveFieldName("password")).toBe(true);
    expect(isSensitiveFieldName("apiKey")).toBe(true);
    expect(isSensitiveFieldName("api_key")).toBe(true);
    expect(isSensitiveFieldName("secret")).toBe(true);
    expect(isSensitiveFieldName("token")).toBe(true);
    expect(isSensitiveFieldName("creditCard")).toBe(true);
    expect(isSensitiveFieldName("ssn")).toBe(true);
    expect(isSensitiveFieldName("birthDate")).toBe(true);
    expect(isSensitiveFieldName("birth_date")).toBe(true);
    expect(isSensitiveFieldName("pin")).toBe(true);
    expect(isSensitiveFieldName("passport")).toBe(true);
  });

  it("should catch OTP/MFA field names", () => {
    expect(isSensitiveFieldName("otp")).toBe(true);
    expect(isSensitiveFieldName("otp_code")).toBe(true);
    expect(isSensitiveFieldName("one_time_password")).toBe(true);
    expect(isSensitiveFieldName("mfa")).toBe(true);
    expect(isSensitiveFieldName("mfa_secret")).toBe(true);
    expect(isSensitiveFieldName("mfaToken")).toBe(true);
    expect(isSensitiveFieldName("otpToken")).toBe(true);
  });

  it("should catch passcode/passphrase and their camelCase variants", () => {
    // Bare forms — explicit in SENSITIVE_FIELDS.
    expect(isSensitiveFieldName("passcode")).toBe(true);
    expect(isSensitiveFieldName("passphrase")).toBe(true);
    // camelCase variants — caught via the SENSITIVE_TOKENS token fallback
    // ("passcode"/"passphrase" tokens), which the regex misses because the
    // "password" branch requires the full word.
    expect(isSensitiveFieldName("newPasscode")).toBe(true);
    expect(isSensitiveFieldName("verifyPassphrase")).toBe(true);
    expect(isSensitiveFieldName("passcodeVerify")).toBe(true);
    // snake_case forms — caught via the regex-independent token fallback too.
    expect(isSensitiveFieldName("passcode_hash")).toBe(true);
    expect(isSensitiveFieldName("user_passphrase")).toBe(true);
  });

  it("should catch all date-of-birth variants consistently", () => {
    // Regression: dateOfBirth (camelCase Date-Of-Noun form) was previously
    // missed while birthDate/birth_date/date_of_birth/dob were caught —
    // an inconsistency that leaked DOB under that specific key.
    expect(isSensitiveFieldName("dateOfBirth")).toBe(true);
    expect(isSensitiveFieldName("birthDate")).toBe(true);
    expect(isSensitiveFieldName("birth_date")).toBe(true);
    expect(isSensitiveFieldName("date_of_birth")).toBe(true);
    expect(isSensitiveFieldName("dob")).toBe(true);
  });

  it("should catch snake_case sensitive fields via regex", () => {
    expect(isSensitiveFieldName("auth_token")).toBe(true);
    expect(isSensitiveFieldName("session_token")).toBe(true);
    expect(isSensitiveFieldName("bearer_token")).toBe(true);
    expect(isSensitiveFieldName("client_secret")).toBe(true);
    expect(isSensitiveFieldName("access_token")).toBe(true);
    expect(isSensitiveFieldName("refresh_token")).toBe(true);
  });

  it("should catch camelCase sensitive fields via token fallback", () => {
    expect(isSensitiveFieldName("clientSecret")).toBe(true);
    expect(isSensitiveFieldName("bearerToken")).toBe(true);
    expect(isSensitiveFieldName("accessToken")).toBe(true);
    expect(isSensitiveFieldName("refreshToken")).toBe(true);
    expect(isSensitiveFieldName("userPassword")).toBe(true);
    expect(isSensitiveFieldName("sessionToken")).toBe(true);
  });

  it("should NOT catch benign field names (no over-redaction)", () => {
    expect(isSensitiveFieldName("primaryKey")).toBe(false);
    expect(isSensitiveFieldName("foreignKey")).toBe(false);
    expect(isSensitiveFieldName("sortKey")).toBe(false);
    expect(isSensitiveFieldName("idempotencyKey")).toBe(false);
    expect(isSensitiveFieldName("tokenize")).toBe(false);
    expect(isSensitiveFieldName("secrets")).toBe(false);
    expect(isSensitiveFieldName("name")).toBe(false);
    expect(isSensitiveFieldName("email")).toBe(false);
    expect(isSensitiveFieldName("partyId")).toBe(false);
    expect(isSensitiveFieldName("field")).toBe(false);
    expect(isSensitiveFieldName("conflictingFields")).toBe(false);
    expect(isSensitiveFieldName("lineNumber")).toBe(false);
    // DOB-adjacent fields that share a "birth"/"date" token but are NOT PII
    // must not be over-redacted by the explicit-set approach.
    expect(isSensitiveFieldName("birthRate")).toBe(false);
    expect(isSensitiveFieldName("birthday")).toBe(false);
    expect(isSensitiveFieldName("birthDate")).toBe(true); // explicit in set
  });
});

describe("splitFieldNameTokens", () => {
  it("should split camelCase", () => {
    expect(splitFieldNameTokens("clientSecret")).toEqual(["client", "Secret"]);
    expect(splitFieldNameTokens("bearerToken")).toEqual(["bearer", "Token"]);
  });

  it("should split snake_case", () => {
    expect(splitFieldNameTokens("access_token")).toEqual(["access", "token"]);
    expect(splitFieldNameTokens("client_secret")).toEqual(["client", "secret"]);
  });

  it("should split kebab-case", () => {
    expect(splitFieldNameTokens("bearer-token")).toEqual(["bearer", "token"]);
  });

  it("should handle single-word names", () => {
    expect(splitFieldNameTokens("name")).toEqual(["name"]);
    expect(splitFieldNameTokens("token")).toEqual(["token"]);
  });

  it("should handle empty string", () => {
    expect(splitFieldNameTokens("")).toEqual([]);
  });
});

describe("canonical shared implementation (single source of truth)", () => {
  it("should classify every sample correctly against known expectations", () => {
    // Sensitive values that MUST be flagged
    const sensitive: readonly string[] = [
      "password", "apiKey", "secret", "token", "code", "session", "signature",
      "sign", "birthDate", "otp", "mfa",
    ];
    // Benign values that MUST NOT be flagged (regression guard against over-redaction)
    const benign: readonly string[] = [
      "primaryKey", "email", "partyId", "name",
    ];
    for (const s of sensitive) {
      expect(isSensitiveFieldName(s)).toBe(true);
    }
    for (const s of benign) {
      expect(isSensitiveFieldName(s)).toBe(false);
    }
  });

  it("should contain all expected ERP-specific fields", () => {
    // The canonical set lives in @besterp/shared; verify the MCP surface
    // agrees on the ERP-specific PII/credential field names.
    expect(isSensitiveFieldName("birthDate")).toBe(true);
    expect(isSensitiveFieldName("birth_date")).toBe(true);
    expect(isSensitiveFieldName("date_of_birth")).toBe(true);
    expect(isSensitiveFieldName("dob")).toBe(true);
    expect(isSensitiveFieldName("national_id")).toBe(true);
    expect(isSensitiveFieldName("bank_account")).toBe(true);
    expect(isSensitiveFieldName("routing_number")).toBe(true);
    expect(isSensitiveFieldName("otp")).toBe(true);
    expect(isSensitiveFieldName("mfa")).toBe(true);
  });

  it("should match standard credential patterns", () => {
    expect(isSensitiveFieldName("password")).toBe(true);
    expect(isSensitiveFieldName("secret")).toBe(true);
    expect(isSensitiveFieldName("token")).toBe(true);
    expect(isSensitiveFieldName("api_key")).toBe(true);
    expect(isSensitiveFieldName("apiKey")).toBe(true);
    expect(isSensitiveFieldName("credential")).toBe(true);
    expect(isSensitiveFieldName("auth_token")).toBe(true);
    expect(isSensitiveFieldName("authToken")).toBe(true);
  });

  it("should NOT match unrelated words containing sensitive substrings", () => {
    expect(isSensitiveFieldName("tokenize")).toBe(false);
    expect(isSensitiveFieldName("passwordless")).toBe(false);
    expect(isSensitiveFieldName("bartender")).toBe(false);
  });

  it("should redact the codes that the MCP surface previously MISSED", () => {
    // Regression for round 44: code / session / signature / sign were in the
    // shared single source of truth but absent from the old local copy, so they
    // leaked on the MCP surface while being redacted on the REST surface.
    expect(isSensitiveFieldName("code")).toBe(true);
    expect(isSensitiveFieldName("session")).toBe(true);
    expect(isSensitiveFieldName("signature")).toBe(true);
    expect(isSensitiveFieldName("sign")).toBe(true);
  });
});

describe("redactSensitiveFields (shared by audit-log + idempotency)", () => {
  // Imported from audit-log.ts so the SAME implementation redacts both the
  // persisted ai_action_log.toolOutput row and the idempotency_record.result
  // column. The idempotency sink previously applied NO redaction, leaking
  // values under sensitive-named keys; this guards the shared function.

  it("redacts values under sensitive-named keys at any nesting depth", () => {
    const input = {
      partyId: "p1",
      result: { apiKey: "sk_live_secret123", nested: { password: "hunter2" } },
    };
    const out = redactSensitiveFields(input) as Record<string, unknown>;
    expect(out.partyId).toBe("p1");
    expect((out.result as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect(
      ((out.result as Record<string, unknown>).nested as Record<string, unknown>).password,
    ).toBe("[REDACTED]");
  });

  it("replaces deep subgraphs with a placeholder when the redaction depth cap is exceeded", () => {
    let deep: Record<string, unknown> = { leaf: "v" };
    for (let i = 0; i < 15; i++) deep = { child: deep };
    const out = redactSensitiveFields({ secret: deep }) as Record<string, unknown>;
    expect(out.secret).toBe("[REDACTED]");
  });
});
