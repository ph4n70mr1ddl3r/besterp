// Unit tests for sensitive-field detection (shared by audit-log + error-handler)

import { describe, it, expect } from "vitest";
import { isSensitiveField, splitFieldTokens, SENSITIVE_FIELDS, SENSITIVE_TOKENS, SENSITIVE_FIELD_PATTERN } from "../middleware/sensitive-fields.js";

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

describe("SENSITIVE_FIELDS", () => {
  it("should be frozen (immutable at runtime)", () => {
    expect(Object.isFrozen(SENSITIVE_FIELDS)).toBe(true);
  });

  it("should contain all expected ERP-specific fields", () => {
    expect(SENSITIVE_FIELDS.has("birthDate")).toBe(true);
    expect(SENSITIVE_FIELDS.has("birth_date")).toBe(true);
    expect(SENSITIVE_FIELDS.has("date_of_birth")).toBe(true);
    expect(SENSITIVE_FIELDS.has("dob")).toBe(true);
    expect(SENSITIVE_FIELDS.has("national_id")).toBe(true);
    expect(SENSITIVE_FIELDS.has("bank_account")).toBe(true);
    expect(SENSITIVE_FIELDS.has("routing_number")).toBe(true);
    expect(SENSITIVE_FIELDS.has("otp")).toBe(true);
    expect(SENSITIVE_FIELDS.has("mfa")).toBe(true);
  });
});

describe("SENSITIVE_TOKENS", () => {
  it("should be frozen (immutable at runtime)", () => {
    expect(Object.isFrozen(SENSITIVE_TOKENS)).toBe(true);
  });

  it("should contain otp and mfa", () => {
    expect(SENSITIVE_TOKENS.has("otp")).toBe(true);
    expect(SENSITIVE_TOKENS.has("mfa")).toBe(true);
  });
});

describe("SENSITIVE_FIELD_PATTERN", () => {
  it("should match standard credential patterns", () => {
    expect(SENSITIVE_FIELD_PATTERN.test("password")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("secret")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("token")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("api_key")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("apiKey")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("credential")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("auth_token")).toBe(true);
    expect(SENSITIVE_FIELD_PATTERN.test("authToken")).toBe(true);
  });

  it("should NOT match unrelated words containing sensitive substrings", () => {
    expect(SENSITIVE_FIELD_PATTERN.test("tokenize")).toBe(false);
    expect(SENSITIVE_FIELD_PATTERN.test("credentials")).toBe(false);
    expect(SENSITIVE_FIELD_PATTERN.test("passwordless")).toBe(false);
    expect(SENSITIVE_FIELD_PATTERN.test("bartender")).toBe(false);
  });
});
