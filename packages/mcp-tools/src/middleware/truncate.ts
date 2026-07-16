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
 * Serialize a non-primitive value to a JSON-safe form, handling Map/Set
 * conversion. Returns a structured error marker on serialisation failure.
 * Never throws.
 */
function serializeObjectValue(value: unknown): { serialized: string } | { _error: string } {
  try {
    // Convert Map/Set to arrays before serialisation — JSON.stringify
    // silently converts Map/Set to "{}", losing all data. This conversion
    // mirrors the audit-log middleware's pre-processing but is applied here
    // so custom middleware authors who call truncateValue directly don't hit
    // the silent data-loss pitfall.
    const normalised = value instanceof Map
      ? Array.from(value.entries())
      : value instanceof Set
        ? Array.from(value)
        : value;
    const serialized = JSON.stringify(normalised);
    return { serialized };
  } catch {
    return { _error: "Failed to serialize value" };
  }
}

/**
 * Check whether a UTF-8 encoded byte array exceeds `effectiveMax` bytes,
 * returning a truncation marker if so, or `null` if the value fits.
 */
function checkOversized(encoded: Uint8Array, effectiveMax: number): { _truncated: true; _originalSize: number; _preview: string } | null {
  return encoded.byteLength > effectiveMax ? truncationMarker(encoded) : null;
}

/**
 * Check whether a value should be handled as a terminal primitive
 * (string, number, boolean, bigint, symbol, function, Date, null, undefined).
 * Returns the normalised form or undefined if the value is a non-primitive object.
 *
 * For strings, encodes directly via TextEncoder to avoid the intermediate
 * JSON.stringify round-trip (strings are JSON-safe by definition, so the
 * double encoding is pure waste). For other JSON-safe primitives (number,
 * boolean), the round-trip is kept because it canonicalises edge cases
 * (e.g. `NaN` → `"null"`, `Infinity` → `"null"`) and gives the correct
 * UTF-8 byte length for the size check.
 */
function normalisePrimitive(value: unknown, effectiveMax: number): { normalised: unknown; marker: ReturnType<typeof checkOversized> } | undefined {
  if (value === null) return { normalised: null, marker: null };
  if (value === undefined) return { normalised: undefined, marker: null };
  if (typeof value === "string") {
    // Strings are JSON-safe — encode directly to check byte length without
    // the intermediate JSON.stringify("string") → "\"string\"" expansion.
    return { normalised: value, marker: checkOversized(textEncoder.encode(value), effectiveMax) };
  }
  if (typeof value === "boolean" || typeof value === "number") {
    const serialised = JSON.stringify(value);
    return { normalised: value, marker: checkOversized(textEncoder.encode(serialised), effectiveMax) };
  }
  if (typeof value === "bigint") {
    return { normalised: value.toString(), marker: checkOversized(textEncoder.encode(value.toString()), effectiveMax) };
  }
  if (typeof value === "symbol") return { normalised: { _error: "Cannot serialize Symbol value" }, marker: null };
  if (typeof value === "function") return { normalised: { _error: "Cannot serialize Function value" }, marker: null };
  if (value instanceof Date) {
    const iso = value.toISOString();
    // Encode the ISO string directly — no JSON.stringify round-trip needed
    // since ISO strings are already valid JSON-safe content. The previous
    // code double-encoded (JSON.stringify wraps the string in quotes),
    // inflating the byte count by 2 and producing an inaccurate size check.
    return { normalised: iso, marker: checkOversized(textEncoder.encode(iso), effectiveMax) };
  }
  return undefined;
}

/**
 * Truncate a JSONB payload to `maxSize` bytes, replacing oversize values
 * with a structured marker. Never throws — returns an error marker on
 * serialisation failure.
 */
export function truncateValue(value: unknown, maxSize: number = MAX_STORED_PAYLOAD_SIZE): unknown {
  const effectiveMax = Math.max(1, maxSize);
  if (value === undefined) return undefined;

  const primitive = normalisePrimitive(value, effectiveMax);
  if (primitive) {
    return primitive.marker ?? primitive.normalised;
  }

  const result = serializeObjectValue(value);
  if ("_error" in result) return result;
  const encoded = textEncoder.encode(result.serialized);
  const marker = checkOversized(encoded, effectiveMax);
  if (marker) return marker;
  // Roundtrip through JSON.parse to normalise non-plain values
  // (class instances, Maps, Sets, BigInts, etc.) to plain JSON-safe
  // values before storage as JSONB.
  return JSON.parse(result.serialized);
}
