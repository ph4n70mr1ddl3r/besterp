// Unit tests for the shared truncation helpers in truncate.ts.
//
// `truncateValue` and `capString` were previously only exercised indirectly
// through the middleware integration tests. These unit tests cover the
// boundary cases directly — especially the UTF-8 multibyte slicing contract
// shared by both functions.

import { describe, it, expect } from "vitest";
import { truncateValue, capString, isTruncationMarker } from "../middleware/truncate.js";
import { MAX_STORED_PAYLOAD_SIZE } from "@besterp/shared";

describe("truncateValue", () => {
  it("passes through undefined", () => {
    expect(truncateValue(undefined)).toBeUndefined();
  });

  it("passes through null", () => {
    expect(truncateValue(null)).toBeNull();
  });

  it("passes through small primitives unchanged", () => {
    expect(truncateValue("hello")).toBe("hello");
    expect(truncateValue(42)).toBe(42);
    expect(truncateValue(true)).toBe(true);
    expect(truncateValue(false)).toBe(false);
  });

  it("converts bigint to a decimal string when it fits", () => {
    expect(truncateValue(123456789n)).toBe("123456789");
  });

  it("marks symbols and functions with an error marker", () => {
    expect(truncateValue(Symbol("x"))).toEqual({
      _error: "Cannot serialize Symbol value",
    });
    expect(truncateValue(() => undefined)).toEqual({
      _error: "Cannot serialize Function value",
    });
  });

  it("converts Date objects to ISO strings", () => {
    const date = new Date("2024-06-15T14:30:00.000Z");
    const result = truncateValue(date);
    expect(result).toBe("2024-06-15T14:30:00.000Z");
    expect(typeof result).toBe("string");
  });

  it("truncates an oversize string with a structured marker", () => {
    const huge = "a".repeat(MAX_STORED_PAYLOAD_SIZE + 1000);
    const result = truncateValue(huge) as { _truncated: boolean; _originalSize: number; _preview: string };
    expect(result._truncated).toBe(true);
    expect(result._originalSize).toBeGreaterThan(MAX_STORED_PAYLOAD_SIZE);
    expect(result._preview.length).toBeGreaterThan(0);
    expect(result._preview.length).toBeLessThanOrEqual(1100); // ~1 KB preview
  });

  it("sanitizes a high-entropy secret out of the truncation _preview", () => {
    // Regression: truncateValue is the last line of defense before a payload
    // is persisted to the durable ai_action_log / idempotency `result` rows.
    // The payload is normally pre-redacted by key name, but a secret under a
    // NON-sensitive key name survives key-name redaction and would otherwise
    // land verbatim in the `_preview` field of the truncation marker — an
    // asymmetric leak into the cross-tenant audit sink. The preview must be
    // passed through sanitizeForLogOutput so the secret is scrubbed by shape.
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const value = { config: { value: secret + "x".repeat(4000) } };
    const result = truncateValue(value, 1024) as { _truncated: boolean; _preview: string };
    expect(result._truncated).toBe(true);
    expect(result._preview).not.toContain(secret);
    expect(result._preview).toContain("[REDACTED_AWS_KEY]");
  });

  it("truncation marker carries a private discriminator so a real '_truncated' user field cannot falsely trigger replay notes", () => {
    const huge = "a".repeat(MAX_STORED_PAYLOAD_SIZE + 1000);
    const marker = truncateValue(huge);
    expect(isTruncationMarker(marker)).toBe(true);
    // A plain object with a user-supplied `_truncated` key must NOT be detected
    // as a truncation marker — that collision would falsely tell the agent the
    // original result was truncated for storage.
    expect(isTruncationMarker({ _truncated: true, data: "real" })).toBe(false);
    expect(isTruncationMarker({ data: "real" })).toBe(false);
    expect(isTruncationMarker(null)).toBe(false);
    expect(isTruncationMarker("string")).toBe(false);
  });

  it("round-trips a plain object under the limit unchanged", () => {
    const value = { a: 1, b: ["two", true] };
    expect(truncateValue(value)).toEqual(value);
  });

  it("never returns a stored form larger than the limit after normalisation", () => {
    // Object whose pre-parse JSON.stringify is just under the cap (so the
    // first size check passes) but whose normalised JSONB form could exceed
    // it (e.g. a value that expands on JSON.parse → re-serialise). The result
    // must still be bounded: either unchanged, or a truncation marker whose
    // _originalSize respects the limit.
    const base = "x".repeat(MAX_STORED_PAYLOAD_SIZE - 50);
    const value = { payload: base, n: 1 };
    const result = truncateValue(value) as { _truncated?: boolean };
    const reencoded = new TextEncoder().encode(JSON.stringify(result));
    expect(reencoded.byteLength).toBeLessThanOrEqual(MAX_STORED_PAYLOAD_SIZE);
    if (result._truncated) {
      expect(result._originalSize).toBeGreaterThan(MAX_STORED_PAYLOAD_SIZE);
    }
  });

  it("returns an error marker for unserializable (circular) input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncateValue(circular)).toEqual({ _error: "Failed to serialize value" });
  });

  it("preview avoids splitting a multibyte char at the 1 KB boundary", () => {
    // truncateValue encodes strings directly via TextEncoder (no JSON.stringify
    // wrapper), so the bytes are the raw UTF-8 of the string value.
    // 1022 'a' = 1022 bytes, then '🌍' (4 bytes) occupies bytes
    // 1022–1025 — byte 1024 is its 2nd (continuation) byte. A naive slice
    // at the 1 KB preview cap would decode a trailing U+FFFD; the safe
    // slice must back up past the lead byte so the whole code point is
    // excluded. (Deterministic: without the fix this preview contains U+FFFD.)
    const head = "a".repeat(1022);
    const value = head + "🌍" + "x".repeat(MAX_STORED_PAYLOAD_SIZE);
    const result = truncateValue(value) as { _truncated: boolean; _preview: string };
    expect(result._truncated).toBe(true);
    expect(result._preview).not.toContain("\uFFFD");
    // The emoji straddled the boundary and was excluded whole; the preview
    // ends inside the ASCII head.
    expect(result._preview.includes("🌍")).toBe(false);
    expect(result._preview.endsWith("a")).toBe(true);
  });

  it("preview of a multibyte-heavy payload stays whole-character aligned", () => {
    // CJK chars are 3 UTF-8 bytes each. With a 100-char ASCII head, the
    // encoded bytes are 100 ASCII, so byte 1024 lands mid-CJK
    // (a continuation byte). The preview must retain only complete chars.
    const head = "a".repeat(100);
    const value = head + "日".repeat(50_000); // ~150 KB — far over the cap
    const result = truncateValue(value) as { _truncated: boolean; _preview: string };
    expect(result._truncated).toBe(true);
    expect(result._preview).not.toContain("\uFFFD");
    // The ASCII head is retained intact, proving the boundary handling
    // didn't corrupt earlier content.
    expect(result._preview.charAt(0)).toBe("a");
    expect(result._preview.slice(0, 100)).toBe("a".repeat(100));
  });

  it("preserves a Map nested inside an array/object (no silent data-loss)", () => {
    // Regression: serializeObjectValue only converted a *top-level* Map/Set,
    // so a Map nested in an array/object was dropped (JSON.stringify turns Map
    // into {}) — losing the data from the persisted audit/idempotency payload.
    const nested = { list: [1, new Map([["token", "secret"], ["n", 2]]), "x"] };
    const result = truncateValue(nested) as { list: unknown[] };
    // The nested Map must survive as a [key, value] pair array, not be elided.
    expect(Array.isArray(result.list)).toBe(true);
    const mapEntry = result.list[1];
    expect(Array.isArray(mapEntry)).toBe(true);
    expect(mapEntry).toEqual([["token", "secret"], ["n", 2]]);
  });

  it("preserves a Set nested inside an object", () => {
    const nested = { tags: new Set(["a", "b"]), meta: { s: new Set([1, 2, 3]) } };
    const result = truncateValue(nested) as { tags: unknown[]; meta: { s: unknown[] } };
    expect(result.tags).toEqual(["a", "b"]);
    expect(result.meta.s).toEqual([1, 2, 3]);
  });

  it("rejects a circular reference in a nested Map/Set rather than truncating it away", () => {
    const a: Record<string, unknown> = {};
    const m = new Map<string, unknown>([["self", a]]);
    a.ref = m; // m -> a -> m
    expect(truncateValue(m)).toEqual({ _error: "Failed to serialize value" });
  });
});

describe("capString", () => {
  it("returns the input unchanged when under the cap", () => {
    expect(capString("short", 100)).toBe("short");
  });

  it("returns the fallback message for non-string input", () => {
    expect(capString(undefined, 100)).toBe("Non-string value in error message (truncated)");
    expect(capString(123, 100)).toBe("Non-string value in error message (truncated)");
  });

  it("caps an oversize ASCII string and appends a truncation marker", () => {
    const result = capString("x".repeat(1000), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toMatch(/truncated/);
    expect(result).toMatch(/original was 1000 bytes/);
  });

  it("respects a 1-byte minimum cap without throwing", () => {
    // Math.max(1, ...) guards against zero/negative caps.
    const result = capString("x".repeat(500), 1);
    expect(typeof result).toBe("string");
    expect(result.length).toBe(1);
  });

  it("does not split a multibyte character at the cap boundary", () => {
    // "🌍🌍🌍..." — each emoji is 4 bytes. A cap of 10 bytes would land in
    // the middle of the third emoji (4+4+2). The result must end cleanly
    // after the second emoji, with no replacement character.
    const value = "🌍".repeat(100); // 400 bytes
    const result = capString(value, 10);
    // Two whole emojis = 8 bytes, leaving 2 bytes which can't fit the marker,
    // so capString falls back to slicing the marker. Either way, no U+FFFD
    // and no partial surrogate/emoji byte should leak through.
    expect(result).not.toContain("\uFFFD");
  });

  it("keeps a multibyte string intact when it fits exactly under the cap", () => {
    const value = "café"; // 'é' is 2 bytes → total 5 bytes
    expect(capString(value, 5)).toBe("café");
    expect(capString(value, 6)).toBe("café");
  });
});

describe("truncateValue never throws", () => {
  it("does not throw when JSON.stringify emits a value JSON.parse rejects", () => {
    // Regression guard: a custom toJSON can make JSON.stringify succeed while
    // the round-trip JSON.parse fails (e.g. emitting a lone UTF-16 surrogate).
    // truncateValue is used in fire-and-forget audit/idempotency writes and
    // must never throw — it should fall back to the string form instead.
    const value = {
      toJSON() {
        return `bad\uD800surrogate`;
      },
    };
    expect(() => truncateValue(value, MAX_STORED_PAYLOAD_SIZE)).not.toThrow();
    // The stored form is the string produced by JSON.stringify.
    expect(truncateValue(value, MAX_STORED_PAYLOAD_SIZE)).toBe(`bad\uD800surrogate`);
  });
});
