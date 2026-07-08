// Shared truncation helper for MCP middlewares.
//
// Used by the audit log middleware and the idempotency middleware to cap
// JSONB payload size. Both the audit log and the idempotency `result` column
// accept arbitrary JSON, so a single 100 MB tool response would otherwise
// produce a 100 MB row. Truncating at 64 KB matches the audit log's limit
// and keeps PostgreSQL row sizes bounded.
//
// Truncation strategy:
// - If the value serialises to JSON under `maxSize` bytes, store it as-is.
// - If the serialised value exceeds `maxSize` bytes, store a structured
//   marker `{ _truncated: true, _originalSize, _preview }` so operators
//   know the data was elided and can see the first 1 KB for context.
// - If JSON serialisation itself throws (e.g., circular reference), store
//   `{ _error: "Failed to serialize value" }` — never throw from a middleware
//   side-effect like audit/idempotency logging.

import { MAX_STORED_PAYLOAD_SIZE } from "@besterp/shared";
export { MAX_STORED_PAYLOAD_SIZE };

/** Preview length (bytes) when a payload is truncated. */
const PREVIEW_BYTES = 1024;

/** Shared TextEncoder/TextDecoder instances — avoids allocation in hot paths. */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Slice a UTF-8 byte array at a byte boundary WITHOUT splitting a multi-byte
 * character. Walks backwards over continuation bytes (0x80–0xBF, the
 * `10xxxxxx` pattern) so the returned string never ends with a lone
 * replacement character (U+FFFD) from a half-decoded trail.
 *
 * Both `capString` and the truncation preview must agree on this behaviour —
 * previously only `capString` walked back, so a preview could end with U+FFFD
 * whenever the byte limit landed mid-character (CJK, emoji, accented chars).
 */
function safeSliceUtf8(encoded: Uint8Array, byteLimit: number): string {
  let sliceEnd = Math.min(byteLimit, encoded.byteLength);
  while (sliceEnd > 0) {
    const byte = encoded[sliceEnd];
    // `sliceEnd` points at the first EXCLUDED byte. While it is a UTF-8
    // continuation byte, the corresponding lead byte lies before `sliceEnd`,
    // so [0, sliceEnd) would still cut the character in half — keep walking.
    if (byte === undefined || (byte & 0xC0) !== 0x80) break;
    sliceEnd--;
  }
  return textDecoder.decode(encoded.slice(0, sliceEnd));
}

/** Structured marker stored in place of an oversized payload. */
function truncationMarker(encoded: Uint8Array): {
  _truncated: true;
  _originalSize: number;
  _preview: string;
} {
  return {
    _truncated: true,
    _originalSize: encoded.byteLength,
    _preview: safeSliceUtf8(encoded, PREVIEW_BYTES),
  };
}

/**
 * Cap an individual string at `maxBytes` bytes (measured in UTF-8).
 *
 * The idempotency middleware stores soft-failure error messages verbatim
 * in `idempotency_record.error.message`. A Zod validation failure with
 * many issues (or a deeply nested object) can produce multi-KB error
 * strings, which would otherwise create very wide rows and bloat the
 * 24h-TTL cleanup job's I/O. Capping at 4 KB keeps the message useful
 * for diagnostics while bounding the row size.
 */
export function capString(value: unknown, maxBytes: number): string {
  const effectiveMax = Math.max(1, maxBytes);
  if (typeof value !== "string") {
    return "Non-string value in error message (truncated)";
  }
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= effectiveMax) {
    return value;
  }
  const marker = `... [truncated, original was ${encoded.byteLength} bytes]`;
  const markerEncoded = textEncoder.encode(marker);
  const markerBytes = markerEncoded.byteLength;
  if (effectiveMax <= markerBytes) {
    return safeSliceUtf8(encoded, effectiveMax);
  }
  // Reserve room for the marker suffix, then slice on a character boundary.
  const truncated = safeSliceUtf8(encoded, effectiveMax - markerBytes);
  return `${truncated}${marker}`;
}

/**
 * Truncate a JSONB payload to `maxSize` bytes, replacing oversize values
 * with a structured marker. Never throws — returns an error marker on
 * serialisation failure.
 */
export function truncateValue(value: unknown, maxSize: number = MAX_STORED_PAYLOAD_SIZE): unknown {
  const effectiveMax = Math.max(1, maxSize);
  if (value === undefined) return undefined;

  // Fast path: null, primitives are always JSON-safe — skip the
  // stringify+parse roundtrip that class instances, Maps, etc. need.
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") {
    const serialized = JSON.stringify(value);
    const encoded = textEncoder.encode(serialized);
    if (encoded.byteLength > effectiveMax) {
      return truncationMarker(encoded);
    }
    return value;
  }
  if (typeof value === "number") {
    // Use JSON.stringify for numbers — String(1e21) vs JSON.stringify(1e21)
    // produce different byte lengths ("1e+21" vs "1000000000000000000000").
    // The stored value will be serialized via JSON.stringify, so measure that.
    const serialized = JSON.stringify(value);
    const encoded = textEncoder.encode(serialized);
    if (encoded.byteLength > effectiveMax) {
      return truncationMarker(encoded);
    }
    return value;
  }
  if (typeof value === "bigint") {
    const str = value.toString();
    const encoded = textEncoder.encode(str);
    if (encoded.byteLength > effectiveMax) {
      return truncationMarker(encoded);
    }
    return str;
  }
  if (typeof value === "symbol") {
    return { _truncated: true, _originalSize: 0, _preview: "[Symbol]" };
  }
  if (typeof value === "function") {
    return { _truncated: true, _originalSize: 0, _preview: "[Function]" };
  }

  try {
    const serialized = JSON.stringify(value);
    const encoded = textEncoder.encode(serialized);
    if (encoded.byteLength > effectiveMax) {
      return truncationMarker(encoded);
    }
    // Roundtrip through JSON.parse to normalise non-plain values
    // (class instances, Maps, Sets, BigInts, etc.) to plain JSON-safe
    // values before storage as JSONB.
    return JSON.parse(serialized);
  } catch {
    return { _error: "Failed to serialize value" };
  }
}
