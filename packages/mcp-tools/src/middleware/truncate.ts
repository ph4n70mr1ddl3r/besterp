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

/** Maximum size (bytes) of stored audit log and idempotency payloads. */
export const MAX_STORED_PAYLOAD_SIZE = 65536; // 64 KB

/** Preview length (bytes) when a payload is truncated. */
const PREVIEW_BYTES = 1024;

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
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  // Truncate to maxBytes, accounting for the marker length
  const marker = `... [truncated, original was ${encoded.byteLength} bytes]`;
  const markerBytes = encoder.encode(marker).byteLength;
  const truncated = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - markerBytes)));
  return `${truncated}${marker}`;
}

/**
 * Truncate a JSONB payload to `maxSize` bytes, replacing oversize values
 * with a structured marker. Never throws — returns an error marker on
 * serialisation failure.
 */
export function truncateValue(value: unknown, maxSize: number = MAX_STORED_PAYLOAD_SIZE): unknown {
  try {
    const serialized = JSON.stringify(value);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    if (byteLength > maxSize) {
      return {
        _truncated: true,
        _originalSize: byteLength,
        _preview: serialized.slice(0, PREVIEW_BYTES),
      };
    }
  } catch {
    return { _error: "Failed to serialize value" };
  }
  return value;
}
