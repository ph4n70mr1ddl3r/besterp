// Canonical sanitization for the durable identity fields.
//
// The identity fields (`userId`, `agentId`, `conversationId`) are written to
// TWO durable sinks — the cross-tenant `ai_action_log` row and the
// tenant-scoped `idempotency_record` row — and the two sinks MUST agree
// about who performed an operation. They therefore share ONE sanitizer.
//
// The sanitizer is LOSSY for secret-shaped values: every one of them
// collapses to the SAME placeholder (`"sk_live_aaa…"` and `"sk_live_bbb…"`
// both become `[REDACTED_API_KEY]`). That is exactly what the sanitization is
// FOR (a secret must never reach a durable sink), but it broke the
// idempotency middleware's caller check:
//
//   The idempotency record's key is `(idempotencyKey, tenantId)` — the key is
//   tenant-scoped, not user-scoped. Two different users in the same tenant
//   can collide on the same key, so the stored identity is compared to
//   decide whether the record belongs to the same caller. With a lossy
//   value, two DIFFERENT callers compared EQUAL: the second one received the
//   FIRST one's stored result as a `replayed` success — a cross-user
//   disclosure of another user's entity payload — and the second user's own
//   operation never ran. The audit trail could not attribute the action to a
//   principal either, because `ai_action_log.user_id` held the same
//   placeholder for both.
//
// The fix keeps the redaction (a secret must never be stored) AND makes the
// stored value INJECTIVE by appending a digest of the RAW identity whenever
// the redaction changed the value.
//
// Why the digest is appended AFTER the redaction (and is long enough to be
// opaque): the stored value must not be a fixed point of the sanitizer.
// Otherwise an attacker could craft an identity equal to another caller's
// stored value (`sanitized + digest`) and the sanitizer would leave it
// unchanged — the collision would survive. Because the digest is 24 hex
// characters, it is an opaque token to the generic long-token rule, so any
// identity that embeds it is itself "changed" by the sanitizer and is stored
// with its own digest. No two distinct raw identities can produce the same
// stored value.

import { createHash } from "node:crypto";
import { sanitizeForLogOutput, stripHtmlTags } from "@besterp/shared";

/**
 * The length of the appended identity digest.
 *
 * 24 hex characters: long enough that the generic long-token rule treats it
 * as an opaque token (so a crafted identity embedding it is never stable),
 * and short enough to keep the stored value readable.
 */
const IDENTITY_DIGEST_LENGTH = 24;

/**
 * The canonical sanitizer for a durable identity field.
 *
 * Returns the value to persist, or `null` when the value cannot be stored
 * (it is not a string, it is empty, or it is longer than the column's
 * identity budget).
 *
 * The returned value is:
 *  - the identity ITSELF when the sanitizer would not change it (the common
 *    case: a user id, a UUID, a ULID, an email address), so the durable row
 *    stays readable and correlatable; or
 *  - the redacted value followed by a digest of the raw identity, when the
 *    sanitizer WOULD change it (a secret-shaped identity).
 */
export function sanitizeDurableIdentity(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxLength) return null;
  let sanitized: string;
  try {
    sanitized = sanitizeForLogOutput(stripHtmlTags(value), { keepOpaqueTokens: true });
  } catch {
    return null;
  }
  if (sanitized === value) return value;
  return `${sanitized}${identityDigest(value)}`;
}

/**
 * A short, one-way digest of the RAW identity.
 *
 * SHA-256 hex output is ASCII-only, so it needs no further sanitization.
 */
function identityDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, IDENTITY_DIGEST_LENGTH);
}
