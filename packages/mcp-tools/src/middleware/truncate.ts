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

import { MAX_STORED_PAYLOAD_SIZE, sanitizeForLogOutput, TRUNCATE_PREVIEW_BYTES } from "@besterp/shared";
export { MAX_STORED_PAYLOAD_SIZE };

/** Shared TextEncoder/TextDecoder instances — avoids allocation in hot paths. */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Slice a UTF-8 byte array at a byte boundary WITHOUT splitting a multi-byte
 * character. Walks backwards over continuation bytes (0x80–0xBF, the
 * `10xxxxxx` pattern) so the returned string never ends with a lone
 * replacement character (U+FFFD) from a half-decoded trail.
 *
 * The loop starts at `sliceEnd` which points to the first byte AFTER the
 * intended slice (i.e., the first excluded byte). If that byte is a UTF-8
 * continuation byte, it means the lead byte of the character lies before
 * `sliceEnd`, so [0, sliceEnd) would cut the character in half — keep walking
 * backwards until we find a non-continuation byte (or reach 0). When
 * `sliceEnd === encoded.byteLength`, `encoded[sliceEnd]` is `undefined`, and
 * the explicit check handles this as a valid character boundary since there is
 * no partial character beyond the end of the buffer.
 *
 * Both `capString` and the truncation preview must agree on this behaviour —
 * previously only `capString` walked back, so a preview could end with U+FFFD
 * whenever the byte limit landed mid-character (CJK, emoji, accented chars).
 */
function safeSliceUtf8(encoded: Uint8Array, byteLimit: number): string {
  let sliceEnd = Math.min(byteLimit, encoded.byteLength);
  while (sliceEnd > 0) {
    const byte = encoded[sliceEnd];
    // `sliceEnd` points at the first EXCLUDED byte. If it is beyond the buffer
    // (undefined), or not a UTF-8 continuation byte (10xxxxxx / 0x80–0xBF),
    // we are on a character boundary and can stop.
    if (byte === undefined || (byte & 0xC0) !== 0x80) break;
    sliceEnd--;
  }
  return textDecoder.decode(encoded.slice(0, sliceEnd));
}

/**
 * Private discriminator that uniquely identifies a truncation marker. A plain
 * `_truncated` flag alone could collide with a real user field named
 * `_truncated`, causing the idempotency replay path to falsely report an
 * original result as "truncated for storage". The high-entropy private key
 * (`__besterp_trunc`) makes such a collision effectively impossible.
 */
const TRUNCATION_MARKER_KEY = "__besterp_trunc";

/** Structured marker stored in place of an oversized payload.
 *
 * Note: Symbol/Function normalisation returns `{ _error: "..." }` which is
 * NOT a truncation marker (no `__besterp_trunc` key), so `isTruncationMarker`
 * correctly returns `false` for those paths. The `_error` marker is a
 * serialisation-failure indicator, not a truncation indicator — consumers
 * that check `isTruncationMarker` will never misidentify it as truncated data.
 */
function truncationMarker(encoded: Uint8Array): {
  __besterp_trunc: true;
  _truncated: true;
  _originalSize: number;
  _preview: string;
} {
  return {
    [TRUNCATION_MARKER_KEY]: true,
    _truncated: true,
    _originalSize: encoded.byteLength,
    // Run the preview through sanitizeForLogOutput as defense-in-depth: the
    // value handed to truncateValue is normally pre-redacted by key name
    // (redactSensitiveFields / redactSensitiveFieldValues), but a secret
    // under a NON-sensitive key name (e.g. `{"config": {"value":
    // "AKIAIOSFODNN7EXAMPLE"}}`) survives key-name redaction and would
    // otherwise land verbatim in the durable ai_action_log / idempotency
    // `_preview` field — an asymmetric leak into the cross-tenant audit sink.
    // sanitizeForLogOutput scrubs high-entropy bearer/secret tokens by shape,
    // so the preview can never carry a raw secret.
    _preview: sanitizeForLogOutput(safeSliceUtf8(encoded, TRUNCATE_PREVIEW_BYTES)),
  };
}

export function isTruncationMarker(value: unknown): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[TRUNCATION_MARKER_KEY] === true
  );
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
 * Recursively normalise a value to a JSON-safe form, converting nested
 * Map/Set to arrays. `JSON.stringify` silently converts Map/Set to `{}`,
 * so a Map nested inside an array/object would otherwise be dropped entirely
 * from the persisted payload (data-loss, not a leak). A depth guard prevents
 * a pathological/cyclic nested structure from running away — circular
 * references within Map/Set values are rejected rather than silently lost.
 */
function normaliseForTruncation(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (value instanceof Map) {
    if (seen.has(value)) throw new Error("Circular reference in Map value");
    seen.add(value);
    try {
      return Array.from(value.entries()).map(([k, v]) => [normaliseForTruncation(k, seen), normaliseForTruncation(v, seen)]);
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Set) {
    if (seen.has(value)) throw new Error("Circular reference in Set value");
    seen.add(value);
    try {
      return Array.from(value.values()).map((v) => normaliseForTruncation(v, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => normaliseForTruncation(v, seen));
  }
  // Defer to JSON.stringify's built-in handling for special objects (Date,
  // RegExp, Error, BigInt wrappers, class instances with toJSON) rather than
  // flattening their enumerable own properties — otherwise a Date would be
  // spread into { } and lose its value. Only plain objects / null-prototype
  // objects are recursed into for nested Map/Set normalisation.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  // Plain object (null-prototype safe since WeakSet only keys objects).
  if (seen.has(value)) throw new Error("Circular reference in object value");
  seen.add(value);
  try {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normaliseForTruncation(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Serialize a non-primitive value to a JSON-safe form, handling nested Map/Set
 * conversion. Returns a structured error marker on serialisation failure.
 * Never throws.
 */
function serializeObjectValue(value: unknown): { serialized: string } | { _error: string } {
  try {
    // Convert Map/Set (including nested ones) to arrays before serialisation —
    // JSON.stringify silently converts Map/Set to "{}", losing all data. This
    // conversion mirrors the audit-log middleware's pre-processing but recurses
    // so a Map nested inside an array/object isn't dropped from the payload.
    const normalised = normaliseForTruncation(value);
    const serialized = JSON.stringify(normalised);
    return { serialized };
  } catch {
    return { _error: "Failed to serialize value" };
  }
}

/**
 * Parse JSON without throwing. Returns `undefined` if `JSON.parse` fails
 * (e.g. a custom `toJSON` that emits a lone surrogate the parser rejects).
 * Kept local to truncateValue because the surrounding code path has already
 * produced a valid JSON *text* form via JSON.stringify, which the JSONB
 * writer can store even when the round-trip re-parse is not possible.
 */
function safeParse(serialized: string): unknown | undefined {
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

/**
 * Check whether a UTF-8 encoded byte array exceeds `effectiveMax` bytes,
 * returning a truncation marker if so, or `null` if the value fits.
 */
function checkOversized(encoded: Uint8Array, effectiveMax: number): ReturnType<typeof truncationMarker> | null {
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
  // The parsed value is a plain JSON-safe form (Maps/Sets converted to arrays,
  // class instances serialised via toJSON, etc.). It is safe to store as JSONB.
  // Roundtrip through JSON.parse to normalise non-plain values
  // (class instances, Maps, Sets, BigInts, etc.) to plain JSON-safe
  // values before storage as JSONB.
  const parsed = safeParse(result.serialized);
  if (parsed === undefined) {
    // JSON.parse threw on a value JSON.stringify emitted but cannot re-parse
    // (e.g. a custom toJSON that emits a lone UTF-16 surrogate). The string
    // form is still valid JSON text for storage as JSONB, so fall back to the
    // pre-parse form rather than throwing — this middleware must never throw
    // from a fire-and-forget audit/idempotency write.
    return result.serialized;
  }
  // Re-validate the bound AFTER normalisation. The size check above measured
  // `result.serialized` (the value going in), but JSON.parse → re-serialise by
  // the JSONB writer can expand the stored form (e.g. Date → ISO string,
  // Map[Symbol] keys, BigInt → string) beyond `maxSize` for pathological
  // inputs. Apply the truncation marker to the normalised form so the stored
  // payload can never exceed the bound.
  const reparsed = textEncoder.encode(JSON.stringify(parsed));
  const postMarker = checkOversized(reparsed, effectiveMax);
  return postMarker ?? parsed;
}
