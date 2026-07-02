// Request ID resolution — derives a correlation ID from the `x-request-id`
// header for cross-cutting log/trace correlation.
//
// SECURITY: the header value is UNTRUSTED client input. It is reflected into
// a response header (via `res.setHeader("x-request-id", ...)`) AND stored on
// `req.requestId` for downstream structured logging. We must not blindly trust
// an arbitrary string:
//   - CRLF would enable HTTP response splitting. Node's HTTP parser strips
//     raw CRLF at the framing layer and `res.setHeader` rejects values that
//     contain control bytes, so this is already gated upstream — but we keep
//     the validation here as defense-in-depth that does not depend on the
//     parser's behaviour.
//   - Spaces / tabs / non-ASCII bytes are legal-but-meaningless for a
//     correlation token; reflecting them pollutes both the response header
//     and log correlation.
//
// We therefore only honour the header when it is a single printable-ASCII
// token (no whitespace, no control bytes) of at most 128 characters. Any other
// shape — array, empty, oversized, or containing unsafe bytes — falls back to a
// freshly generated UUID v4.

import { randomUUID } from "node:crypto";

/** Maximum accepted length for a client-supplied request ID. */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * A request ID must be a printable-ASCII token (0x21–0x7E) with NO whitespace
 * or control bytes. This is permissive enough for every common correlation-ID
 * format (UUID, ULID, base64, traceparent, `:`-delimited spans) while
 * rejecting everything that could corrupt a header or a log line.
 */
const SAFE_REQUEST_ID = /^[!-~]{1,128}$/;

/**
 * Resolve a correlation request ID from the raw `x-request-id` header value.
 *
 * - Returns the trimmed header value when it is a safe printable token.
 * - Returns a fresh UUID v4 for any other input (array, empty, oversized,
 *   whitespace, control bytes, non-ASCII).
 *
 * @param raw - The raw `req.headers["x-request-id"]` value (string | string[] | undefined).
 * @returns A safe, non-empty correlation ID.
 */
export function resolveRequestId(raw: unknown): string {
  // Node joins repeated headers into a string[] (comma-separated semantics).
  // A multi-valued x-request-id is ambiguous — fall back to a generated UUID
  // rather than guessing which entry to trust.
  if (typeof raw !== "string") return randomUUID();
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) return randomUUID();
  if (!SAFE_REQUEST_ID.test(value)) return randomUUID();
  return value;
}
