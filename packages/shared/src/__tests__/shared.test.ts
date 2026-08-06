// Unit tests for @besterp/shared pure utilities.
// These don't require a database — only validateTenantId.
// hashInput tests are in crypto.test.ts (comprehensive coverage).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateTenantId, validateTenantIdEnhancedForAuth, withTenant } from "../tenant.js";
import { COUNTRY_CODE_REGEX, EMAIL_REGEX, UUID_REGEX, isValidISODate } from "../validation.js";
import { JWT_EXPIRES_IN_REGEX, resolveRedisTls } from "../constants.js";
import {
  ConcurrencyConflictError,
  DomainError,
  DuplicateEntityError,
  EntityNotFoundError,
  InvalidTypeValueError,
  MissingSubtypeDataError,
  isDomainError,
  getErrorCode,
} from "../errors.js";

describe("validateTenantId", () => {
  it("accepts valid tenant IDs", () => {
    expect(() => validateTenantId("tenant-acme")).not.toThrow();
    expect(() => validateTenantId("my_tenant_123")).not.toThrow();
    expect(() => validateTenantId("a")).not.toThrow();
    expect(() => validateTenantId("A-B_C-123")).not.toThrow();
  });

  it("rejects empty strings", () => {
    expect(() => validateTenantId("")).toThrow("Tenant ID must be a non-empty string");
  });

  it("rejects SQL injection attempts", () => {
    expect(() => validateTenantId("'; DROP TABLE party;--")).toThrow(
      "Invalid tenant ID"
    );
  });

  it("rejects IDs with spaces", () => {
    expect(() => validateTenantId("tenant acme")).toThrow("Invalid tenant ID");
  });

  it("rejects IDs with special characters", () => {
    expect(() => validateTenantId("tenant@acme")).toThrow("Invalid tenant ID");
    expect(() => validateTenantId("tenant.acme")).toThrow("Invalid tenant ID");
    expect(() => validateTenantId("tenant/acme")).toThrow("Invalid tenant ID");
  });

  it("trims surrounding whitespace and returns the normalized id", () => {
    // A whitespace-padded id must normalize so the RLS call path
    // (set_tenant_context) operates on the SAME string the validator accepted.
    // Without trim, `"tenant-acme "` would pass validation but set an RLS
    // context that matches no stored tenant_id — an isolation bypass.
    expect(validateTenantId("  tenant-acme  ")).toBe("tenant-acme");
    expect(validateTenantId("\ttenant-1\n")).toBe("tenant-1");
  });

  it("rejects an id that is only whitespace", () => {
    expect(() => validateTenantId("   ")).toThrow("Tenant ID must not consist solely of whitespace");
  });
});

describe("validateTenantIdEnhancedForAuth", () => {
  it("accepts valid, in-bounds tenant IDs", () => {
    expect(validateTenantIdEnhancedForAuth("tenant-acme")).toBe("tenant-acme");
    expect(validateTenantIdEnhancedForAuth("  tenant-acme  ")).toBe("tenant-acme");
  });

  it("rejects empty / whitespace-only IDs", () => {
    expect(() => validateTenantIdEnhancedForAuth("")).toThrow("non-empty string");
    expect(() => validateTenantIdEnhancedForAuth("   ")).toThrow("whitespace");
  });

  it("rejects invalid characters", () => {
    expect(() => validateTenantIdEnhancedForAuth("tenant acme")).toThrow("Invalid tenant ID");
    expect(() => validateTenantIdEnhancedForAuth("tenant@acme")).toThrow("Invalid tenant ID");
  });

  it("rejects IDs exceeding MAX_TENANT_ID_LENGTH", () => {
    // Aligns with validateTenantId — the two auth-boundary validators must
    // agree, otherwise a too-long ID passes here and throws a confusing
    // InvalidTenantIdError later inside withTenant.
    const tooLong = "t".repeat(101);
    expect(tooLong.length).toBeGreaterThan(100);
    expect(() => validateTenantIdEnhancedForAuth(tooLong)).toThrow("too long");
  });
});

describe("withTenant", () => {
  it("rejects null/undefined PrismaClient", async () => {
    await expect(
      withTenant(null as any, "tenant-1", async (tx) => tx.party.findMany())
    ).rejects.toThrow("Invalid PrismaClient");
  });

  it("rejects object without $transaction", async () => {
    await expect(
      withTenant({} as any, "tenant-1", async (tx) => tx.party.findMany())
    ).rejects.toThrow("Invalid PrismaClient");
  });
});

describe("COUNTRY_CODE_REGEX (E.164 country code)", () => {
  it("accepts common E.164 country codes", () => {
    expect(COUNTRY_CODE_REGEX.test("+1")).toBe(true);
    expect(COUNTRY_CODE_REGEX.test("+44")).toBe(true);
    expect(COUNTRY_CODE_REGEX.test("+81")).toBe(true);
    expect(COUNTRY_CODE_REGEX.test("+86")).toBe(true);
    expect(COUNTRY_CODE_REGEX.test("+999")).toBe(true);
  });

  it("rejects values without a leading +", () => {
    expect(COUNTRY_CODE_REGEX.test("1")).toBe(false);
    expect(COUNTRY_CODE_REGEX.test("44")).toBe(false);
  });

  it("rejects non-numeric values", () => {
    expect(COUNTRY_CODE_REGEX.test("+abc")).toBe(false);
    expect(COUNTRY_CODE_REGEX.test("++")).toBe(false);
  });

  it("rejects values with more than 3 digits", () => {
    // ITU-T E.164 country codes are 1-3 digits; longer values are
    // subscriber numbers and shouldn't be accepted as a country code.
    expect(COUNTRY_CODE_REGEX.test("+1234")).toBe(false);
  });

  it("rejects empty string and whitespace", () => {
    expect(COUNTRY_CODE_REGEX.test("")).toBe(false);
    expect(COUNTRY_CODE_REGEX.test("+")).toBe(false);
    expect(COUNTRY_CODE_REGEX.test("+ ")).toBe(false);
  });
});

describe("UUID_REGEX / EMAIL_REGEX sanity check", () => {
  // Light smoke tests — the constants are heavily exercised in the
  // services that use them. These just guard against accidental
  // regressions in the exported regex source.
  it("UUID_REGEX matches standard UUID format", () => {
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
  });
  it("EMAIL_REGEX matches a simple address", () => {
    expect(EMAIL_REGEX.test("user@example.com")).toBe(true);
    expect(EMAIL_REGEX.test("not-an-email")).toBe(false);
  });
  it("EMAIL_REGEX rejects a single-character TLD", () => {
    // A one-letter TLD ("b.c") is not a valid public suffix and must be
    // rejected so malformed addresses cannot enter email_address storage.
    expect(EMAIL_REGEX.test("user@b.c")).toBe(false);
    expect(EMAIL_REGEX.test("a@x.y")).toBe(false);
    expect(EMAIL_REGEX.test("user@example.c")).toBe(false);
    // A legitimate 2+ char TLD still matches.
    expect(EMAIL_REGEX.test("user@example.io")).toBe(true);
  });
  it("EMAIL_REGEX rejects numeric or digit-containing TLDs", () => {
    // Regression: the final TLD segment allowed `[a-zA-Z0-9]`, so
    // `example.123` / `example.c0m` validated even though a numeric TLD never
    // exists. Aligns with Zod `.email()` and class-validator `@IsEmail`.
    expect(EMAIL_REGEX.test("user@example.123")).toBe(false);
    expect(EMAIL_REGEX.test("user@example.c0m")).toBe(false);
    expect(EMAIL_REGEX.test("user@example.2day")).toBe(false);
  });
});

describe("JWT_EXPIRES_IN_REGEX (token lifetime)", () => {
  it("accepts well-formed positive durations", () => {
    expect(JWT_EXPIRES_IN_REGEX.test("24h")).toBe(true);
    expect(JWT_EXPIRES_IN_REGEX.test("60m")).toBe(true);
    expect(JWT_EXPIRES_IN_REGEX.test("7d")).toBe(true);
    expect(JWT_EXPIRES_IN_REGEX.test("1s")).toBe(true);
    expect(JWT_EXPIRES_IN_REGEX.test("9999999999d")).toBe(true);
  });
  it("rejects degenerate and unbounded durations", () => {
    // Zero/instant expiry would invalidate every token immediately; an
    // unbounded magnitude would produce an effectively non-expiring token.
    expect(JWT_EXPIRES_IN_REGEX.test("0s")).toBe(false);
    expect(JWT_EXPIRES_IN_REGEX.test("0d")).toBe(false);
    expect(JWT_EXPIRES_IN_REGEX.test("007d")).toBe(false);
    expect(JWT_EXPIRES_IN_REGEX.test("999999999999999999d")).toBe(false);
    // Format-only mistakes are still rejected.
    expect(JWT_EXPIRES_IN_REGEX.test("24")).toBe(false);
    expect(JWT_EXPIRES_IN_REGEX.test("h")).toBe(false);
    expect(JWT_EXPIRES_IN_REGEX.test("1x")).toBe(false);
    expect(JWT_EXPIRES_IN_REGEX.test("")).toBe(false);
  });
});

describe("ConcurrencyConflictError", () => {
  it("creates an error with CONCURRENCY_CONFLICT code", () => {
    const error = new ConcurrencyConflictError("Conflict detected", {
      suggestedTools: ["retry_operation"],
      context: { version: 2 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("CONCURRENCY_CONFLICT");
    expect(error.name).toBe("ConcurrencyConflictError");
    expect(error.message).toBe("Conflict detected");
    expect(error.suggestedTools).toEqual(["retry_operation"]);
    expect(error.context).toEqual({ version: 2 });
  });

  it("serializes correctly via toJSON", () => {
    const error = new ConcurrencyConflictError("stale version", {
      suggestedTools: ["reload_and_retry"],
    });
    const json = error.toJSON();
    expect(json.code).toBe("CONCURRENCY_CONFLICT");
    expect(json.name).toBe("ConcurrencyConflictError");
    expect(json.message).toBe("stale version");
  });

  it("sanitizes a secret-bearing cause message in toJSON (durable-sink leak)", () => {
    // A Prisma/driver error is routinely attached as `cause`; its message can
    // embed a connection string / SQL. toJSON is the canonical serializer for
    // audit logs + idempotency records, so the cause message must be scrubbed
    // the same way `message` and `context` already are.
    const root = new Error("connect ECONNREFUSED postgres://user:secretpass@db.internal:5432/app");
    const error = new ConcurrencyConflictError("operation failed", { cause: root });
    const json = error.toJSON();
    expect(JSON.stringify(json.cause)).not.toContain("secretpass");
    expect(JSON.stringify(json.cause)).toContain("[DATABASE_URL]");
  });

  it("redacts secrets in non-Error object cause as sanitized string", () => {
    const error = new ConcurrencyConflictError("operation failed", {
      cause: { raw: "postgres://user:secretpass@db.internal" },
    });
    const json = error.toJSON();
    expect(typeof json.cause).toBe("string");
    expect(json.cause).toContain("[DATABASE_URL]");
    expect(json.cause).not.toContain("secretpass");
  });

  it("returns safe placeholder for non-Error, non-object cause", () => {
    const error = new ConcurrencyConflictError("operation failed", {
      cause: "just a string",
    });
    const json = error.toJSON();
    expect(json.cause).toBe("[Non-error cause]");
  });
});

describe("getErrorCode", () => {
  it("extracts string code from error-like objects", () => {
    expect(getErrorCode({ code: "P2034" })).toBe("P2034");
    expect(getErrorCode({ code: "P2002" })).toBe("P2002");
  });

  it("returns undefined for non-object inputs", () => {
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode(undefined)).toBeUndefined();
    expect(getErrorCode("string")).toBeUndefined();
    expect(getErrorCode(42)).toBeUndefined();
  });

  it("returns undefined when code is not a string", () => {
    expect(getErrorCode({ code: 42 })).toBeUndefined();
    expect(getErrorCode({ code: true })).toBeUndefined();
    expect(getErrorCode({ code: null })).toBeUndefined();
    expect(getErrorCode({})).toBeUndefined();
  });

  it("returns undefined for plain Error instances (no Prisma code)", () => {
    expect(getErrorCode(new Error("something broke"))).toBeUndefined();
  });
});

describe("DomainError subclasses", () => {
  it("EntityNotFoundError creates error with correct code and name", () => {
    const error = new EntityNotFoundError("Not found", {
      suggestedTools: ["search_parties"],
      context: { partyId: "abc" },
    });
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ENTITY_NOT_FOUND");
    expect(error.name).toBe("EntityNotFoundError");
    expect(error.message).toBe("Not found");
    expect(error.suggestedTools).toEqual(["search_parties"]);
    expect(error.context).toEqual({ partyId: "abc" });
  });

  it("DuplicateEntityError creates error with correct code", () => {
    const error = new DuplicateEntityError("Already exists");
    expect(error.code).toBe("DUPLICATE_ENTITY");
    expect(error.name).toBe("DuplicateEntityError");
  });

  it("InvalidTypeValueError creates error with correct code", () => {
    const error = new InvalidTypeValueError("Bad value");
    expect(error.code).toBe("INVALID_TYPE_VALUE");
    expect(error.name).toBe("InvalidTypeValueError");
  });

  it("MissingSubtypeDataError creates error with correct code", () => {
    const error = new MissingSubtypeDataError("Missing person data");
    expect(error.code).toBe("MISSING_SUBTYPE_DATA");
    expect(error.name).toBe("MissingSubtypeDataError");
  });

  it("DomainError toJSON serializes all fields", () => {
    const cause = new Error("root cause");
    const error = new DomainError("TEST_CODE", "test message", {
      suggestedTools: ["tool_a"],
      context: { key: "value" },
      cause,
    });
    const json = error.toJSON();
    expect(json.code).toBe("TEST_CODE");
    expect(json.message).toBe("test message");
    expect(json.suggestedTools).toEqual(["tool_a"]);
    expect(json.context).toEqual({ key: "value" });
    expect(json.cause).toBe("root cause");
  });

  it("DomainError toJSON redacts secrets in non-Error object cause and caps length", () => {
    // Non-Error object causes are serialized to JSON, sanitized, and capped
    // at 500 chars to prevent leaking embedded connection strings or tokens
    // in durable sinks.
    const error = new DomainError("TEST", "msg", { cause: { secret: "leak" } as any });
    const cause = error.toJSON().cause;
    expect(typeof cause).toBe("string");
    expect(cause).toContain("[REDACTED]");
  });

  it("DomainError toJSON handles null cause", () => {
    const error = new DomainError("TEST", "msg");
    expect(error.toJSON().cause).toBeUndefined();
  });

  it("DomainError toJSON redacts sensitive-named context values", () => {
    // toJSON is the canonical structured serializer used for audit logs and
    // idempotency records, so a secret under a sensitive-named key must not
    // reach those durable sinks verbatim.
    const error = new DomainError("TEST", "msg", {
      context: { password: "hunter2", apiKey: "sk_live_abc123", note: "benign" },
    });
    const json = error.toJSON();
    expect(json.context).toEqual({
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
      note: "benign",
    });
  });

  it("DomainError toJSON sanitizes a secret-bearing message", () => {
    // `message` routinely echoes user-supplied input (connection strings,
    // `?api_key=…`). Sanitize it on the toJSON path so any caller serializing
    // the error via JSON.stringify cannot leak the secret verbatim into durable
    // sinks.
    const error = new DomainError("TEST", "connect failed postgres://u:p@host/db");
    const json = error.toJSON();
    expect(json.message).not.toContain("postgres://u:p@host/db");
    expect(json.message).toContain("[DATABASE_URL]");
  });

  it("isDomainError returns true for DomainError instances", () => {
    expect(isDomainError(new DomainError("C", "m"))).toBe(true);
    expect(isDomainError(new EntityNotFoundError("m"))).toBe(true);
    expect(isDomainError(new Error("m"))).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});

describe("isValidISODate", () => {
  it("accepts valid dates", () => {
    expect(isValidISODate("2024-06-15")).toBe(true);
    expect(isValidISODate("2000-02-29")).toBe(true);
  });

  it("rejects dates with years before 1700", () => {
    expect(isValidISODate("1699-12-31")).toBe(false);
    expect(isValidISODate("0001-01-01")).toBe(false);
  });

  it("rejects dates with years after 2200", () => {
    expect(isValidISODate("2201-01-01")).toBe(false);
    expect(isValidISODate("9999-12-31")).toBe(false);
  });

  it("rejects invalid calendar dates", () => {
    expect(isValidISODate("2024-02-30")).toBe(false);
    expect(isValidISODate("2023-13-01")).toBe(false);
  });

  it("rejects non-leap-year Feb 29", () => {
    expect(isValidISODate("2023-02-29")).toBe(false);
  });

  it("accepts date-only with Z suffix (UTC marker, no time)", () => {
    expect(isValidISODate("2024-06-15Z")).toBe(true);
    expect(isValidISODate("2000-02-29Z")).toBe(true);
  });

  it("rejects timezone offsets outside the valid -12:00..+14:00 range", () => {
    // +14:00 is the maximum valid offset; +14:30/+14:59 are not.
    expect(isValidISODate("2024-06-15T00:00:00+14:00")).toBe(true);
    expect(isValidISODate("2024-06-15T00:00:00+14:30")).toBe(false);
    expect(isValidISODate("2024-06-15T00:00:00+14:59")).toBe(false);
    // -12:00 is the minimum valid offset; -13:00 is not.
    expect(isValidISODate("2024-06-15T00:00:00-12:00")).toBe(true);
    expect(isValidISODate("2024-06-15T00:00:00-12:30")).toBe(false);
    expect(isValidISODate("2024-06-15T00:00:00-13:00")).toBe(false);
  });

  it("rejects non-date strings", () => {
    expect(isValidISODate("not-a-date")).toBe(false);
    expect(isValidISODate("")).toBe(false);
  });
});

describe("resolveRedisTls", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when REDIS_TLS=1", () => {
    process.env.REDIS_TLS = "1";
    expect(resolveRedisTls()).toBe(true);
  });

  it("returns true when REDIS_TLS=true", () => {
    process.env.REDIS_TLS = "true";
    expect(resolveRedisTls()).toBe(true);
  });

  it("returns true when REDIS_TLS=yes", () => {
    process.env.REDIS_TLS = "yes";
    expect(resolveRedisTls()).toBe(true);
  });

  it("returns false when REDIS_TLS=0", () => {
    process.env.REDIS_TLS = "0";
    expect(resolveRedisTls()).toBe(false);
  });

  it("returns false when REDIS_TLS=false", () => {
    process.env.REDIS_TLS = "false";
    expect(resolveRedisTls()).toBe(false);
  });

  it("returns false when REDIS_TLS=no", () => {
    process.env.REDIS_TLS = "no";
    expect(resolveRedisTls()).toBe(false);
  });

  it("defaults to true in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_TLS;
    expect(resolveRedisTls()).toBe(true);
  });

  it("defaults to false in development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_TLS;
    expect(resolveRedisTls()).toBe(false);
  });

  it("defaults to true in non-development, non-production envs", () => {
    process.env.NODE_ENV = "staging";
    delete process.env.REDIS_TLS;
    expect(resolveRedisTls()).toBe(true);
  });

  it("explicit value overrides environment default", () => {
    process.env.NODE_ENV = "development";
    process.env.REDIS_TLS = "1";
    expect(resolveRedisTls()).toBe(true);
  });
});
