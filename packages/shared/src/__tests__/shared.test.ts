// Unit tests for @besterp/shared pure utilities.
// These don't require a database — only validateTenantId, richError.
// hashInput tests are in crypto.test.ts (comprehensive coverage).

import { describe, it, expect } from "vitest";
import { validateTenantId, withTenant } from "../tenant.js";
import { richError } from "../errors.js";

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
