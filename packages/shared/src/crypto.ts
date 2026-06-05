import * as crypto from "crypto";

/**
 * Deterministically sort object keys at all nesting levels.
 * Produces a canonical key ordering so JSON.stringify is consistent
 * regardless of insertion order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return null; // Normalize undefined to null
  if (typeof value === 'number') {
    // Normalize NaN and Infinity to null — JSON.stringify converts them to null,
    // so without this normalization NaN and null would collide. This ensures
    // deterministic hashing for edge-case numeric inputs.
    if (!Number.isFinite(value)) return null;
  }
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    // Handle plain objects: {}, Object.create(null), etc.
    // Skip custom class instances (Date, etc.) that have their own serialization.
    if (proto === Object.prototype || proto === null) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    // Non-plain objects (Date, class instances, etc.) pass through for JSON.stringify to handle
    return value;
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
