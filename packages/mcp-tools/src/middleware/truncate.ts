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
 * Cap an individual string at `maxBytes` characters (approximated as
 * UTF-16 code units — sufficient for soft-failure error messages where
 * each "character" is at most a few bytes in practice).
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
  if (value.length <= maxBytes) {
    return value;
  }
  // Slice to the byte cap, then append a marker so operators can tell
  // the message was elided (rather than assuming the text just ends).
  return `${value.slice(0, maxBytes)}... [truncated, original was ${value.length} chars]`;
}

/**
 * Truncate a JSONB payload to `maxSize` bytes, replacing oversize values
 * with a structured marker. Never throws — returns an error marker on
 * serialisation failure.
 */
export function truncateValue(value: unknown, maxSize: number = MAX_STORED_PAYLOAD_SIZE): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > maxSize) {
      return {
        _truncated: true,
        _originalSize: serialized.length,
        _preview: serialized.slice(0, PREVIEW_BYTES),
      };
    }
  } catch {
    return { _error: "Failed to serialize value" };
  }
  return value;
}
