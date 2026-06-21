import * as crypto from "node:crypto";
import { InvalidTypeValueError } from "./errors.js";

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
  // Pre-compute sorted keys to avoid processing each key twice (once in
  // the comparator, once in the .map()). Each key is stringified once for
  // comparison and once for the final sorted-key-value output.
  const entries = Array.from(value.entries());
  const sortedEntries = entries
    .map(([k, v]) => ({
      k,
      v,
      kSorted: sortKeysDeep(k, ancestors),
    }))
    .sort((a, b) => {
      const aStr = typeof a.kSorted === "object" && a.kSorted !== null
        ? JSON.stringify(a.kSorted) : String(a.k);
      const bStr = typeof b.kSorted === "object" && b.kSorted !== null
        ? JSON.stringify(b.kSorted) : String(b.k);
      return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    });
  const result = sortedEntries.map(({ v, kSorted }) => [kSorted, sortKeysDeep(v, ancestors)]);
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
  // Use Object.create(null) to prevent prototype pollution — even if the
  // input contains __proto__, setting it on a null-prototype object creates
  // a data property rather than modifying the object's prototype chain.
  const sorted: Record<string, unknown> = Object.create(null);
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key], ancestors);
  }
  return sorted;
}

function serializeSpecialObject(value: object): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (value instanceof Error) {
    const serialized: Record<string, unknown> = { name: value.name, message: value.message };
    if (value.cause !== undefined && value.cause !== null) {
      serialized.cause = value.cause instanceof Error
        ? { name: value.cause.name, message: value.cause.message }
        : String(value.cause);
    }
    return serialized;
  }
  return value;
}

function sortObject(value: object, ancestors: Set<object>): unknown {
  checkCircular(value, ancestors);
  ancestors.add(value);

  const proto = Object.getPrototypeOf(value);
  let result: unknown;
  if (proto === Object.prototype || proto === null) {
    result = sortPlainObject(value, ancestors);
  } else {
    result = serializeSpecialObject(value);
  }

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
  try {
    const canonical = sortKeysDeep(input);
    const serialized = JSON.stringify(canonical);
    return crypto
      .createHash("sha256")
      .update(serialized)
      .digest("hex");
  } catch (e) {
    // Circular references and other serialization errors should result in a
    // clear error rather than an opaque crash deep in the hash pipeline.
    throw new InvalidTypeValueError(
      `Failed to hash input: ${e instanceof Error ? e.message : "serialization error"}. ` +
      `Ensure input does not contain circular references.`
    );
  }
}
