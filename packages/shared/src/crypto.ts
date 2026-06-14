import * as crypto from "node:crypto";

/**
 * Deterministically sort object keys at all nesting levels.
 * Produces a canonical key ordering so JSON.stringify is consistent
 * regardless of insertion order.
 *
 * Handles:
 * - Plain objects: sorted by key
 * - Arrays: elements recursively processed
 * - Maps: converted to sorted [key, value] pairs
 * - Sets: converted to sorted array of values
 * - BigInt: converted to string representation
 * - Symbol: converted to string representation
 * - undefined/NaN/Infinity: normalized to null
 * - Date/Error/RegExp: passed through for JSON.stringify
 */
function checkCircular(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw new Error("Circular reference detected in hash input");
  }
}

function sortArray(value: unknown[], ancestors: Set<object>): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  const result = value.map((v) => sortKeysDeep(v, ancestors));
  ancestors.delete(value);
  return result;
}

function sortMap(value: Map<unknown, unknown>, ancestors: Set<object>): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  const sortedEntries = Array.from(value.entries())
    .sort(([a], [b]) => {
      const aStr = typeof a === "object" && a !== null ? JSON.stringify(sortKeysDeep(a, ancestors)) : String(a);
      const bStr = typeof b === "object" && b !== null ? JSON.stringify(sortKeysDeep(b, ancestors)) : String(b);
      return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    });
  const result = sortedEntries.map(([k, v]) => [sortKeysDeep(k, ancestors), sortKeysDeep(v, ancestors)]);
  ancestors.delete(value);
  return result;
}

function sortSet(value: Set<unknown>, ancestors: Set<object>): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  const result = Array.from(value).map((v) => sortKeysDeep(v, ancestors)).sort((a, b) => {
    const aStr = JSON.stringify(a);
    const bStr = JSON.stringify(b);
    return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
  });
  ancestors.delete(value);
  return result;
}

function sortPlainObject(value: object, ancestors: Set<object>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (key === "__proto__") continue;
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key], ancestors);
  }
  return sorted;
}

function sortObject(value: object, ancestors: Set<object>): unknown {
  checkCircular(value, ancestors);
  ancestors.add(value);

  const proto = Object.getPrototypeOf(value);
  const result = (proto === Object.prototype || proto === null)
    ? sortPlainObject(value, ancestors)
    : value;

  ancestors.delete(value);
  return result;
}

function sortKeysDeep(value: unknown, ancestors?: Set<object>): unknown {
  ancestors = ancestors ?? new Set<object>();
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return sortArray(value, ancestors);
  if (value instanceof Map) return sortMap(value, ancestors);
  if (value instanceof Set) return sortSet(value, ancestors);
  if (typeof value === "object") return sortObject(value, ancestors);
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
 * Handles problematic types like BigInt, Symbol, undefined values,
 * Maps, and Sets.
 */
export function hashInput(input: unknown): string {
  const canonical = sortKeysDeep(input);
  const serialized = JSON.stringify(canonical);
  return crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex");
}
