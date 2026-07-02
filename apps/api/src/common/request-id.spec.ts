// Unit tests for resolveRequestId — the untrusted-header sanitization boundary
// for the `x-request-id` correlation ID.

import { describe, it, expect } from "vitest";
import { resolveRequestId, MAX_REQUEST_ID_LENGTH } from "./request-id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("resolveRequestId", () => {
  it("passes through a valid UUID-shaped token", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(resolveRequestId(id)).toBe(id);
  });

  it("passes through other common correlation-ID formats", () => {
    expect(resolveRequestId("01HXY9Q6Z8J3R5TN7V9X1Z3A5B")).toBe("01HXY9Q6Z8J3R5TN7V9X1Z3A5B"); // ULID
    expect(resolveRequestId("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    ); // W3C traceparent
    expect(resolveRequestId("cG9ydl9pZA==")).toBe("cG9ydl9pZA=="); // base64
    expect(resolveRequestId("svc:handler:instance")).toBe("svc:handler:instance"); // colon-delimited
  });

  it("trims surrounding whitespace before accepting", () => {
    const id = "abc-123";
    expect(resolveRequestId(`  ${id}  `)).toBe(id);
  });

  it("generates a UUID for missing / empty / whitespace-only values", () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_RE);
    expect(resolveRequestId("")).toMatch(UUID_RE);
    expect(resolveRequestId("   ")).toMatch(UUID_RE);
    expect(resolveRequestId(null)).toMatch(UUID_RE);
  });

  it("generates a UUID for array (multi-valued) headers", () => {
    // Node joins repeated headers into a string[]; an ambiguous multi-valued
    // x-request-id must not be trusted.
    expect(resolveRequestId(["a", "b"])).toMatch(UUID_RE);
  });

  it("generates a UUID for non-string types", () => {
    expect(resolveRequestId(12345)).toMatch(UUID_RE);
    expect(resolveRequestId({ id: "x" })).toMatch(UUID_RE);
    expect(resolveRequestId(true)).toMatch(UUID_RE);
  });

  it("rejects values containing internal whitespace", () => {
    expect(resolveRequestId("abc def")).toMatch(UUID_RE);
    expect(resolveRequestId("abc\tdef")).toMatch(UUID_RE);
  });

  it("rejects values containing control bytes (CRLF / NUL / ESC)", () => {
    // Defense-in-depth against response-splitting / log-injection. These are
    // already gated by Node's HTTP parser + setHeader, but resolveRequestId
    // must not depend on that.
    expect(resolveRequestId("abc\r\nX-Injected: evil")).toMatch(UUID_RE);
    expect(resolveRequestId("abc\0def")).toMatch(UUID_RE);
    expect(resolveRequestId("abc\x1b[31mdef")).toMatch(UUID_RE);
  });

  it("rejects non-ASCII / high-byte values", () => {
    expect(resolveRequestId("café-123")).toMatch(UUID_RE);
    expect(resolveRequestId("id-\u00e9")).toMatch(UUID_RE);
  });

  it("rejects oversized values (over MAX_REQUEST_ID_LENGTH)", () => {
    const tooLong = "a".repeat(MAX_REQUEST_ID_LENGTH + 1);
    expect(tooLong.length).toBe(MAX_REQUEST_ID_LENGTH + 1);
    expect(resolveRequestId(tooLong)).toMatch(UUID_RE);
  });

  it("accepts a value exactly MAX_REQUEST_ID_LENGTH long", () => {
    const exact = "a".repeat(MAX_REQUEST_ID_LENGTH);
    expect(resolveRequestId(exact)).toBe(exact);
  });

  it("always returns a non-empty string", () => {
    for (const input of [undefined, "", "   ", "bad value", ["a", "b"], 1, "good-id"]) {
      const out = resolveRequestId(input);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
