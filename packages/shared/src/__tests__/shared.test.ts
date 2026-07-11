// Unit tests for @besterp/shared pure utilities.
// These don't require a database — only validateTenantId.
// hashInput tests are in crypto.test.ts (comprehensive coverage).

import { describe, it, expect } from "vitest";
import { validateTenantId, withTenant } from "../tenant.js";
import { COUNTRY_CODE_REGEX, EMAIL_REGEX, UUID_REGEX, isValidISODate } from "../validation.js";
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

  it("DomainError toJSON handles non-Error cause", () => {
    const error = new DomainError("TEST", "msg", { cause: "string cause" as any });
    expect(error.toJSON().cause).toBe("string cause");
  });

  it("DomainError toJSON handles null cause", () => {
    const error = new DomainError("TEST", "msg");
    expect(error.toJSON().cause).toBeUndefined();
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

  it("rejects non-date strings", () => {
    expect(isValidISODate("not-a-date")).toBe(false);
    expect(isValidISODate("")).toBe(false);
  });
});
