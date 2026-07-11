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

function sortArray(value: unknown[], ancestors: Set<object>, depth: number): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  const result = value.map((v) => sortKeysDeep(v, ancestors, depth + 1));
  ancestors.delete(value);
  return result;
}

function sortMap(value: Map<unknown, unknown>, ancestors: Set<object>, depth: number): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  // Pre-compute sorted keys and their stringified forms to avoid redundant
  // JSON.stringify calls in the comparator. Without pre-computation, each
  // comparison re-stringifies both keys — O(n log n) stringifications total.
  // Pre-computing reduces this to O(n).
  const entries = Array.from(value.entries());
  const prepared = entries
    .map(([k, v]) => ({
      v,
      kSorted: sortKeysDeep(k, ancestors, depth + 1),
      kStr: "", // populated below
    }));
  for (const entry of prepared) {
    entry.kStr = JSON.stringify(entry.kSorted);
  }
  const sortedEntries = prepared
    .sort((a, b) => a.kStr < b.kStr ? -1 : a.kStr > b.kStr ? 1 : 0);
  const result = sortedEntries.map(({ v, kSorted }) => [kSorted, sortKeysDeep(v, ancestors, depth + 1)]);
  ancestors.delete(value);
  return result;
}

function sortSet(value: Set<unknown>, ancestors: Set<object>, depth: number): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  // Pre-compute stringified forms to avoid redundant JSON.stringify calls
  // in the comparator (same optimization as sortMap).
  const sorted = Array.from(value).map((v) => sortKeysDeep(v, ancestors, depth + 1));
  const prepared = sorted.map((v) => ({ v, str: JSON.stringify(v) }));
  const result = prepared
    .sort((a, b) => a.str < b.str ? -1 : a.str > b.str ? 1 : 0)
    .map(({ v }) => v);
  ancestors.delete(value);
  return result;
}

function sortPlainObject(value: object, ancestors: Set<object>, depth: number): Record<string, unknown> {
  // Use Object.create(null) to prevent prototype pollution — even if the
  // input contains __proto__, setting it on a null-prototype object creates
  // a data property rather than modifying the object's prototype chain.
  const sorted: Record<string, unknown> = Object.create(null);
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key], ancestors, depth + 1);
  }
  return sorted;
}

function serializeSpecialObject(value: object, ancestors: Set<object>, depth: number): unknown {
  // WeakMap/WeakSet are non-enumerable: Object.keys() returns [], so they
  // would otherwise fall through to sortPlainObject and hash as `{}` —
  // colliding with an empty object and with every other Weak collection
  // (confirmed by probe). That is silent data loss for an idempotency hash.
  // audit-log.ts and error-handler.ts both explicitly guard Weak collections;
  // since their entries cannot be enumerated, they cannot be deterministically
  // hashed, so reject them (mirroring the function guard in sortKeysDeep).
  if (value instanceof WeakMap || value instanceof WeakSet) {
    throw new InvalidTypeValueError(
      "Cannot hash a WeakMap/WeakSet value. Weak collections are non-enumerable and cannot be serialized for idempotency hashing."
    );
  }
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
  return sortPlainObject(value, ancestors, depth);
}

function sortObject(value: object, ancestors: Set<object>, depth: number): unknown {
  checkCircular(value, ancestors);
  ancestors.add(value);

  const proto = Object.getPrototypeOf(value);
  let result: unknown;
  if (proto === Object.prototype || proto === null) {
    result = sortPlainObject(value, ancestors, depth);
  } else {
    result = serializeSpecialObject(value, ancestors, depth);
  }

  ancestors.delete(value);
  return result;
}

/** Maximum recursion depth to prevent stack overflow on deeply nested inputs. */
const MAX_HASH_DEPTH = 100;

function sortKeysDeep(value: unknown, ancestors?: Set<object>, depth = 0): unknown {
  if (depth > MAX_HASH_DEPTH) {
    throw new InvalidTypeValueError(
      `Input exceeds maximum nesting depth of ${MAX_HASH_DEPTH}. Refusing to hash to prevent stack overflow.`
    );
  }
  ancestors = ancestors ?? new Set<object>();
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return sortArray(value, ancestors, depth);
  if (value instanceof Map) return sortMap(value, ancestors, depth);
  if (value instanceof Set) return sortSet(value, ancestors, depth);
  if (typeof value === "object") return sortObject(value, ancestors, depth);
  if (typeof value === "bigint") return `BigInt:${value.toString()}`;
  if (typeof value === "symbol") return `Symbol:${value.toString()}`;
  if (typeof value === "function") {
    throw new InvalidTypeValueError(
      "Cannot hash a function value. Functions are not serializable and cannot be included in idempotency hashes."
    );
  }
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
    // Re-throw InvalidTypeValueError as-is to preserve the original code
    // and context; wrap other errors so consumers always get a structured error.
    if (e instanceof InvalidTypeValueError) throw e;
    throw new InvalidTypeValueError(
      `Failed to hash input: ${e instanceof Error ? e.message : "serialization error"}.`,
      { cause: e instanceof Error ? e : undefined }
    );
  }
}
