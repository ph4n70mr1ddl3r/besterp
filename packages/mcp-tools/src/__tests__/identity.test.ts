// Unit tests for the canonical durable-sink identity sanitizer.
//
// The identity fields (`userId`, `agentId`, `conversationId`) are written to
// TWO durable sinks — the cross-tenant `ai_action_log` row and the
// tenant-scoped `idempotency_record` row — and the two MUST agree about who
// performed an operation.
//
// The plain sanitizer is LOSSY for secret-shaped values: every one of them
// collapses to the same placeholder. That broke the idempotency middleware's
// caller check: two DIFFERENT callers compared EQUAL, so the second one
// received the first one's stored result as a `replayed` success.

import { describe, it, expect } from "vitest";
import { sanitizeDurableIdentity } from "../identity.js";

describe("sanitizeDurableIdentity", () => {
  it("keeps an ordinary identity READABLE and unchanged", () => {
    for (const id of [
      "user-1",
      "user_1",
      "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ServiceAccount12345678",
      "user@example.com",
      "9f8d7c6b-5a4e-4f2d-8c0b-9a8e7d6c5b4a",
      "R&D-team",
      "user+tag",
      "user.name",
    ]) {
      expect(sanitizeDurableIdentity(id, 200)).toBe(id);
    }
  });

  it("redacts a secret-shaped identity but keeps it DISTINGUISHABLE", () => {
    // The redaction itself is unchanged: the secret never reaches the sink.
    const sanitized = sanitizeDurableIdentity("us-sk_live_realsecret123", 200);
    expect(sanitized).not.toContain("sk_live_realsecret123");
    expect(sanitized).toContain("[REDACTED_API_KEY]");
  });

  it("gives two DIFFERENT secret-shaped identities two DIFFERENT stored values", () => {
    // The regression: both collapsed to "[REDACTED_API_KEY]", so the
    // idempotency middleware treated the two callers as the SAME caller and
    // replayed the first one's stored result to the second one.
    const a = sanitizeDurableIdentity("sk_live_aaaaaaaaaaaaaaaa", 200);
    const b = sanitizeDurableIdentity("sk_live_bbbbbbbbbbbbbbbb", 200);
    expect(a).not.toBe(b);
    expect(a).not.toContain("aaaaaaaaaaaaaaaa");
    expect(b).not.toContain("bbbbbbbbbbbbbbbb");
  });

  it("is INJECTIVE: distinct raw identities never produce the same stored value", () => {
    const raws = [
      "sk_live_aaaaaaaaaaaaaaaa",
      "sk_live_bbbbbbbbbbbbbbbb",
      "us-sk_live_realsecret123",
      "user-1",
      "user-2",
      "postgres://u:p@h/db",
    ];
    const stored = raws.map((raw) => sanitizeDurableIdentity(raw, 200));
    expect(new Set(stored).size).toBe(raws.length);
  });

  it("is a FIXED POINT of its own output: re-sanitizing does not change it", () => {
    // The stored value must not be something the sanitizer would rewrite
    // again — otherwise the two sinks could disagree after a round trip.
    for (const raw of ["sk_live_aaaaaaaaaaaaaaaa", "user-1", "postgres://u:p@h/db"]) {
      const stored = sanitizeDurableIdentity(raw, 200);
      expect(sanitizeDurableIdentity(stored, 200)).toBe(stored);
    }
  });

  it("rejects a value that cannot be stored", () => {
    expect(sanitizeDurableIdentity(undefined, 200)).toBeNull();
    expect(sanitizeDurableIdentity(null, 200)).toBeNull();
    expect(sanitizeDurableIdentity(42, 200)).toBeNull();
    expect(sanitizeDurableIdentity("", 200)).toBeNull();
    expect(sanitizeDurableIdentity("x".repeat(201), 200)).toBeNull();
  });
});
