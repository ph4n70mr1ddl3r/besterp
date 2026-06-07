// Unit tests for @besterp/shared pure utilities.
// These don't require a database — only validateTenantId, richError.
// hashInput tests are in crypto.test.ts (comprehensive coverage).

import { describe, it, expect } from "vitest";
import { validateTenantId, withTenant } from "../tenant.js";
import { richError } from "../errors.js";
import { COUNTRY_CODE_REGEX, EMAIL_REGEX, UUID_REGEX } from "../validation.js";

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

describe("richError", () => {
  it("returns an MCP-compatible error response", () => {
    const result = richError("TEST_ERROR", "Something went wrong");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("TEST_ERROR");
    expect(parsed.message).toBe("Something went wrong");
  });

  it("includes suggested tools when provided", () => {
    const result = richError("NOT_FOUND", "Party not found", [
      "create_party",
      "search_parties",
    ]);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.suggestedTools).toEqual([
      "create_party",
      "search_parties",
    ]);
  });

  it("includes context when provided", () => {
    const result = richError("VALIDATION", "Invalid input", [], {
      field: "partyType",
      validValues: ["PERSON", "ORGANIZATION"],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.context.field).toBe("partyType");
    expect(parsed.context.validValues).toEqual(["PERSON", "ORGANIZATION"]);
  });

  it("defaults to empty suggested tools and context", () => {
    const result = richError("ERROR", "msg");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.suggestedTools).toEqual([]);
    expect(parsed.context).toEqual({});
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
