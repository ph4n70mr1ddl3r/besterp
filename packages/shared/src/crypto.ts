import * as crypto from "crypto";

/**
 * Deterministically sort object keys at all nesting levels.
 * Produces a canonical key ordering so JSON.stringify is consistent
 * regardless of insertion order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return null; // Normalize undefined to null
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value.constructor === Object) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  if (typeof value === "bigint") return `BigInt:${value.toString()}`;
  if (typeof value === "symbol") return `Symbol:${value.toString()}`;
  return value;
}

/**
 * Hash a tool input for idempotency mismatch detection.
 *
 * Produces a deterministic SHA-256 hash of the JSON-serialized input.
 * Keys are sorted recursively so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`
 * produce the same hash.
 * Handles problematic types like BigInt, Symbol, and undefined values.
 */
export function hashInput(input: unknown): string {
  const canonical = sortKeysDeep(input);
  const serialized = JSON.stringify(canonical);
  return crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex");
}
