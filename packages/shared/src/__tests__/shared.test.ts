// Unit tests for @besterp/shared pure utilities.
// These don't require a database — only validateTenantId.
// hashInput tests are in crypto.test.ts (comprehensive coverage).

import { describe, it, expect } from "vitest";
import { validateTenantId, withTenant } from "../tenant.js";
import { COUNTRY_CODE_REGEX, EMAIL_REGEX, UUID_REGEX } from "../validation.js";
import { ConcurrencyConflictError, getErrorCode } from "../errors.js";

describe("validateTenantId", () => {
  it("accepts valid tenant IDs", () => {
    expect(() => validateTenantId("tenant-acme")).not.toThrow();
    expect(() => validateTenantId("my_tenant_123")).not.toThrow();
    expect(() => validateTenantId("a")).not.toThrow();
    expect(() => validateTenantId("A-B_C-123")).not.toThrow();
  });

  it("rejects empty strings", () => {
    expect(() => validateTenantId("")).toThrow("Invalid tenant ID");
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
