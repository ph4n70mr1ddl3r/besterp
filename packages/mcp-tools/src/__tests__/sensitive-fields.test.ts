// Unit tests for sensitive-field detection (shared by audit-log + error-handler)

import { describe, it, expect } from "vitest";
import { isSensitiveField, splitFieldTokens } from "../middleware/sensitive-fields.js";
import { isSensitiveFieldName } from "@besterp/shared";
import { redactSensitiveFields } from "../middleware/audit-log.js";

// The local `isSensitiveField` delegates to the canonical `isSensitiveFieldName`
// in @besterp/shared. The tests below assert the two surfaces agree on what
// counts as sensitive (the asymmetric-leak class of bug that round 44 fixed).

describe("isSensitiveField", () => {
  it("should catch explicit sensitive field names", () => {
    expect(isSensitiveField("password")).toBe(true);
    expect(isSensitiveField("apiKey")).toBe(true);
    expect(isSensitiveField("api_key")).toBe(true);
    expect(isSensitiveField("secret")).toBe(true);
    expect(isSensitiveField("token")).toBe(true);
    expect(isSensitiveField("creditCard")).toBe(true);
    expect(isSensitiveField("ssn")).toBe(true);
    expect(isSensitiveField("birthDate")).toBe(true);
    expect(isSensitiveField("birth_date")).toBe(true);
    expect(isSensitiveField("pin")).toBe(true);
    expect(isSensitiveField("passport")).toBe(true);
  });

  it("should catch OTP/MFA field names", () => {
    expect(isSensitiveField("otp")).toBe(true);
    expect(isSensitiveField("otp_code")).toBe(true);
    expect(isSensitiveField("one_time_password")).toBe(true);
    expect(isSensitiveField("mfa")).toBe(true);
    expect(isSensitiveField("mfa_secret")).toBe(true);
    expect(isSensitiveField("mfaToken")).toBe(true);
    expect(isSensitiveField("otpToken")).toBe(true);
  });

  it("should catch passcode/passphrase and their camelCase variants", () => {
    // Bare forms — explicit in SENSITIVE_FIELDS.
    expect(isSensitiveField("passcode")).toBe(true);
    expect(isSensitiveField("passphrase")).toBe(true);
    // camelCase variants — caught via the SENSITIVE_TOKENS token fallback
    // ("passcode"/"passphrase" tokens), which the regex misses because the
    // "password" branch requires the full word.
    expect(isSensitiveField("newPasscode")).toBe(true);
    expect(isSensitiveField("verifyPassphrase")).toBe(true);
    expect(isSensitiveField("passcodeVerify")).toBe(true);
    // snake_case forms — caught via the regex-independent token fallback too.
    expect(isSensitiveField("passcode_hash")).toBe(true);
    expect(isSensitiveField("user_passphrase")).toBe(true);
  });

  it("should catch all date-of-birth variants consistently", () => {
    // Regression: dateOfBirth (camelCase Date-Of-Noun form) was previously
    // missed while birthDate/birth_date/date_of_birth/dob were caught —
    // an inconsistency that leaked DOB under that specific key.
    expect(isSensitiveField("dateOfBirth")).toBe(true);
    expect(isSensitiveField("birthDate")).toBe(true);
    expect(isSensitiveField("birth_date")).toBe(true);
    expect(isSensitiveField("date_of_birth")).toBe(true);
    expect(isSensitiveField("dob")).toBe(true);
  });

  it("should catch snake_case sensitive fields via regex", () => {
    expect(isSensitiveField("auth_token")).toBe(true);
    expect(isSensitiveField("session_token")).toBe(true);
    expect(isSensitiveField("bearer_token")).toBe(true);
    expect(isSensitiveField("client_secret")).toBe(true);
    expect(isSensitiveField("access_token")).toBe(true);
    expect(isSensitiveField("refresh_token")).toBe(true);
  });

  it("should catch camelCase sensitive fields via token fallback", () => {
    expect(isSensitiveField("clientSecret")).toBe(true);
    expect(isSensitiveField("bearerToken")).toBe(true);
    expect(isSensitiveField("accessToken")).toBe(true);
    expect(isSensitiveField("refreshToken")).toBe(true);
    expect(isSensitiveField("userPassword")).toBe(true);
    expect(isSensitiveField("sessionToken")).toBe(true);
  });

  it("should NOT catch benign field names (no over-redaction)", () => {
    expect(isSensitiveField("primaryKey")).toBe(false);
    expect(isSensitiveField("foreignKey")).toBe(false);
    expect(isSensitiveField("sortKey")).toBe(false);
    expect(isSensitiveField("idempotencyKey")).toBe(false);
    expect(isSensitiveField("tokenize")).toBe(false);
    expect(isSensitiveField("secrets")).toBe(false);
    expect(isSensitiveField("name")).toBe(false);
    expect(isSensitiveField("email")).toBe(false);
    expect(isSensitiveField("partyId")).toBe(false);
    expect(isSensitiveField("field")).toBe(false);
    expect(isSensitiveField("conflictingFields")).toBe(false);
    expect(isSensitiveField("lineNumber")).toBe(false);
    // DOB-adjacent fields that share a "birth"/"date" token but are NOT PII
    // must not be over-redacted by the explicit-set approach.
    expect(isSensitiveField("birthRate")).toBe(false);
    expect(isSensitiveField("birthday")).toBe(false);
    expect(isSensitiveField("birthDate")).toBe(true); // explicit in set
  });
});

describe("splitFieldTokens", () => {
  it("should split camelCase", () => {
    expect(splitFieldTokens("clientSecret")).toEqual(["client", "Secret"]);
    expect(splitFieldTokens("bearerToken")).toEqual(["bearer", "Token"]);
  });

  it("should split snake_case", () => {
    expect(splitFieldTokens("access_token")).toEqual(["access", "token"]);
    expect(splitFieldTokens("client_secret")).toEqual(["client", "secret"]);
  });

  it("should split kebab-case", () => {
    expect(splitFieldTokens("bearer-token")).toEqual(["bearer", "token"]);
  });

  it("should handle single-word names", () => {
    expect(splitFieldTokens("name")).toEqual(["name"]);
    expect(splitFieldTokens("token")).toEqual(["token"]);
  });

  it("should handle empty string", () => {
    expect(splitFieldTokens("")).toEqual([]);
  });
});

describe("delegation to shared isSensitiveFieldName (single source of truth)", () => {
  it("should agree with the shared single source of truth on every sample", () => {
    const samples = [
      "password", "apiKey", "secret", "token", "code", "session", "signature",
      "sign", "birthDate", "otp", "mfa", "primaryKey", "email", "partyId", "name",
    ];
    for (const s of samples) {
      expect(isSensitiveField(s)).toBe(isSensitiveFieldName(s));
    }
  });

  it("should contain all expected ERP-specific fields", () => {
    // The canonical set lives in @besterp/shared; verify the MCP surface
    // agrees on the ERP-specific PII/credential field names.
    expect(isSensitiveField("birthDate")).toBe(true);
    expect(isSensitiveField("birth_date")).toBe(true);
    expect(isSensitiveField("date_of_birth")).toBe(true);
    expect(isSensitiveField("dob")).toBe(true);
    expect(isSensitiveField("national_id")).toBe(true);
    expect(isSensitiveField("bank_account")).toBe(true);
    expect(isSensitiveField("routing_number")).toBe(true);
    expect(isSensitiveField("otp")).toBe(true);
    expect(isSensitiveField("mfa")).toBe(true);
  });

  it("should match standard credential patterns", () => {
    expect(isSensitiveField("password")).toBe(true);
    expect(isSensitiveField("secret")).toBe(true);
    expect(isSensitiveField("token")).toBe(true);
    expect(isSensitiveField("api_key")).toBe(true);
    expect(isSensitiveField("apiKey")).toBe(true);
    expect(isSensitiveField("credential")).toBe(true);
    expect(isSensitiveField("auth_token")).toBe(true);
    expect(isSensitiveField("authToken")).toBe(true);
  });

  it("should NOT match unrelated words containing sensitive substrings", () => {
    expect(isSensitiveField("tokenize")).toBe(false);
    expect(isSensitiveField("passwordless")).toBe(false);
    expect(isSensitiveField("bartender")).toBe(false);
  });

  it("should redact the codes that the MCP surface previously MISSED", () => {
    // Regression for round 44: code / session / signature / sign were in the
    // shared single source of truth but absent from the old local copy, so they
    // leaked on the MCP surface while being redacted on the REST surface.
    expect(isSensitiveField("code")).toBe(true);
    expect(isSensitiveField("session")).toBe(true);
    expect(isSensitiveField("signature")).toBe(true);
    expect(isSensitiveField("sign")).toBe(true);
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
