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
  if (typeof value !== "string") {
    return "Tool returned a soft failure";
  }
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  const marker = `... [truncated, original was ${encoded.byteLength} bytes]`;
  const markerBytes = textEncoder.encode(marker).byteLength;
  if (maxBytes <= markerBytes) {
    return marker.slice(0, maxBytes);
  }
  const truncated = textDecoder.decode(encoded.slice(0, maxBytes - markerBytes));
  return `${truncated}${marker}`;
}

/**
 * Truncate a JSONB payload to `maxSize` bytes, replacing oversize values
 * with a structured marker. Never throws — returns an error marker on
 * serialisation failure.
 */
export function truncateValue(value: unknown, maxSize: number = MAX_STORED_PAYLOAD_SIZE): unknown {
  if (value === undefined) return undefined;

  // Fast path: null, primitives are always JSON-safe — skip the
  // stringify+parse roundtrip that class instances, Maps, etc. need.
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") {
    const encoded = textEncoder.encode(String(value));
    if (encoded.byteLength > maxSize) {
      return {
        _truncated: true,
        _originalSize: encoded.byteLength,
        _preview: textDecoder.decode(encoded.slice(0, PREVIEW_BYTES)),
      };
    }
    return value;
  }
  if (typeof value === "number") {
    // Use JSON.stringify for numbers — String(1e21) vs JSON.stringify(1e21)
    // produce different byte lengths ("1e+21" vs "1000000000000000000000").
    // The stored value will be serialized via JSON.stringify, so measure that.
    const serialized = JSON.stringify(value);
    const encoded = textEncoder.encode(serialized);
    if (encoded.byteLength > maxSize) {
      return {
        _truncated: true,
        _originalSize: encoded.byteLength,
        _preview: textDecoder.decode(encoded.slice(0, PREVIEW_BYTES)),
      };
    }
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    const encoded = textEncoder.encode(serialized);
    if (encoded.byteLength > maxSize) {
      return {
        _truncated: true,
        _originalSize: encoded.byteLength,
        _preview: textDecoder.decode(encoded.slice(0, PREVIEW_BYTES)),
      };
    }
    // Roundtrip through JSON.parse to normalise non-plain values
    // (class instances, Maps, Sets, BigInts, etc.) to plain JSON-safe
    // values before storage as JSONB.
    return JSON.parse(serialized);
  } catch {
    return { _error: "Failed to serialize value" };
  }
}
