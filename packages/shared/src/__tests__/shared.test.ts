// Unit tests for @besterp/shared pure utilities.
// These don't require a database — only validateTenantId, hashInput, richError.

import { describe, it, expect } from "vitest";
import { validateTenantId } from "../tenant.js";
import { hashInput } from "../crypto.js";
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

describe("hashInput", () => {
  it("produces a deterministic SHA-256 hex hash", () => {
    const input = { name: "test", value: 42 };
    const hash1 = hashInput(input);
    const hash2 = hashInput(input);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex = 64 chars
  });

  it("produces different hashes for different inputs", () => {
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });

  it("handles primitives", () => {
    expect(() => hashInput("hello")).not.toThrow();
    expect(() => hashInput(42)).not.toThrow();
    expect(() => hashInput(null)).not.toThrow();
  });

  it("produces the same hash regardless of key insertion order", () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, y: 2, x: 1 };
    expect(hashInput(a)).toBe(hashInput(b));
  });

  it("produces the same hash for nested objects regardless of key order", () => {
    const a = { outer: { inner: 1, other: 2 }, value: 3 };
    const b = { value: 3, outer: { other: 2, inner: 1 } };
    expect(hashInput(a)).toBe(hashInput(b));
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
