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
 * - Date/RegExp: passed through for JSON.stringify
 * - Error: recursively serialized (name/message/cause) with the same
 *   circular-reference and depth guards applied to plain objects so a
 *   circular `cause` chain throws like every other circular type and
 *   differing `cause` depths produce distinct hashes.
 */
function checkCircular(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw new Error("Circular reference detected in hash input");
  }
}

function sortArray(value: unknown[], ancestors: Set<object>, depth: number, budget: { bytes: number }): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  try {
    return value.map((v) => sortKeysDeep(v, ancestors, depth + 1, budget));
  } finally {
    ancestors.delete(value);
  }
}

function sortMap(value: Map<unknown, unknown>, ancestors: Set<object>, depth: number, budget: { bytes: number }): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  try {
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
      // The key serializes as `"kStr"` on the wire; charge its quoted length to
      // the aggregate budget (object keys are charged in sortPlainObject, Map
      // keys were previously exempt — a wide Map of long keys escaped the guard).
      chargeKeyBytes(entry.kStr, budget);
    }
    const sortedEntries = prepared
      .sort((a, b) => a.kStr < b.kStr ? -1 : a.kStr > b.kStr ? 1 : 0);
    return sortedEntries.map(({ v, kSorted }) => [kSorted, sortKeysDeep(v, ancestors, depth + 1, budget)]);
  } finally {
    ancestors.delete(value);
  }
}

function sortSet(value: Set<unknown>, ancestors: Set<object>, depth: number, budget: { bytes: number }): unknown[] {
  checkCircular(value, ancestors);
  ancestors.add(value);
  try {
    // Pre-compute stringified forms to avoid redundant JSON.stringify calls
    // in the comparator (same optimization as sortMap).
    const sorted = Array.from(value).map((v) => sortKeysDeep(v, ancestors, depth + 1, budget));
    const prepared = sorted.map((v) => ({ v, str: JSON.stringify(v) }));
    return prepared
      .sort((a, b) => a.str < b.str ? -1 : a.str > b.str ? 1 : 0)
      .map(({ v }) => v);
  } finally {
    ancestors.delete(value);
  }
}

function sortPlainObject(value: object, ancestors: Set<object>, depth: number, budget: { bytes: number }): Record<string, unknown> {
  // Use Object.create(null) to prevent prototype pollution — even if the
  // input contains __proto__, setting it on a null-prototype object creates
  // a data property rather than modifying the object's prototype chain.
  const sorted: Record<string, unknown> = Object.create(null);
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    chargeKeyBytes(key, budget);
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key], ancestors, depth + 1, budget);
  }
  return sorted;
}

function serializeSpecialObject(value: object, ancestors: Set<object>, depth: number, budget: { bytes: number }): unknown {
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
      // Recurse through sortKeysDeep so the cause keeps full depth fidelity
      // (nested cause.cause is preserved) and is subject to the same
      // circular-reference + depth guards as any other value. A circular
      // cause chain therefore throws "Circular reference detected in hash
      // input" consistently, and inputs differing only in cause depth yield
      // distinct hashes (otherwise two different tool inputs could collide
      // to the same idempotency hash).
      serialized.cause = sortKeysDeep(value.cause, ancestors, depth + 1, budget);
    }
    return serialized;
  }
  return sortPlainObject(value, ancestors, depth, budget);
}

function sortObject(value: object, ancestors: Set<object>, depth: number, budget: { bytes: number }): unknown {
  checkCircular(value, ancestors);
  ancestors.add(value);
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return sortPlainObject(value, ancestors, depth, budget);
    }
    return serializeSpecialObject(value, ancestors, depth, budget);
  } finally {
    ancestors.delete(value);
  }
}

/** Maximum recursion depth to prevent stack overflow on deeply nested inputs. */
const MAX_HASH_DEPTH = 100;

/** Maximum number of keys in the canonical form to prevent DoS via wide/shallow objects. */
const MAX_HASH_KEYS = 10_000;

/**
 * Maximum aggregate serialized byte length across ALL string values in the
 * input. `MAX_HASH_STRING_BYTES` caps each *individual* string, but `countKeys`
 * only counts object/array/Map/Set structure — an input like
 * `Array(1200).fill("x".repeat(99000))` passes the key count (1200 < 10_000)
 * and the per-string cap (99 KB < 100 KB) yet `JSON.stringify`s into a
 * ~115 MB buffer, exhausting memory / blocking the event loop. This aggregate
 * budget bounds the total serialized output regardless of how the large
 * strings are distributed across containers.
 */
const MAX_HASH_TOTAL_BYTES = 2_000_000;

/**
 * Maximum byte length of a single string value to prevent DoS via an
 * oversized string. `countKeys` only counts object/array/Map/Set structure,
 * so a lone multi-hundred-MB string would slip past that guard and get
 * JSON.stringified into a proportionally large buffer — exhausting memory /
 * blocking the event loop. `MAX_INPUT_LENGTH` in sanitize.ts caps the same
 * class of input for HTML stripping; this is the idempotency-hash analogue,
 * bounded well above any legitimate tool input (the largest field is
 * MAX_PARTY_DESCRIPTION_LENGTH = 1000 chars).
 */
const MAX_HASH_STRING_BYTES = 100_000;

/**
 * Enforce the per-string byte cap (MAX_HASH_STRING_BYTES). A single oversized
 * string would otherwise be JSON.stringified into a multi-hundred-MB buffer
 * (countKeys only counts object/array/Map/Set structure, so a lone huge
 * string slips past it). Measure byte length, not char length, so a
 * 50k-CJK-char string (well above the limit) is caught even though its char
 * count looks moderate.
 */
function checkStringBounds(value: string, budget?: { bytes: number }): void {
  const len = Buffer.byteLength(value, "utf8");
  if (budget) {
    budget.bytes += len;
    if (budget.bytes > MAX_HASH_TOTAL_BYTES) {
      throw new InvalidTypeValueError(
        `Input exceeds aggregate serialized size limit of ${MAX_HASH_TOTAL_BYTES} bytes. ` +
        `Refusing to hash to prevent denial of service.`
      );
    }
  }
  if (len > MAX_HASH_STRING_BYTES) {
    throw new InvalidTypeValueError(
      `Input contains a string longer than ${MAX_HASH_STRING_BYTES} bytes. ` +
      `Refusing to hash to prevent denial of service.`
    );
  }
}

/**
 * Charge a structural string (object key, Map key, or quoted wrapper) to the
 * aggregate byte budget. `checkStringBounds` only fires for *string values*
 * reached through `sortKeysDeep`, so the JSON-serialized form of object/Map
 * *keys* — which are emitted verbatim into `JSON.stringify(canonical)` — would
 * otherwise exceed `MAX_HASH_TOTAL_BYTES` without tripping the guard. A key of
 * length L serializes as `"L"` (quote-wrapped), so we charge L + 2 to match the
 * wire size. Key names are bounded by `MAX_HASH_KEYS` (10k) but a 10k-array of
 * 200-char keys still adds ~2 MB of *key* bytes on top of the value budget; the
 * budget now covers both.
 */
function chargeKeyBytes(value: string, budget?: { bytes: number }): void {
  if (!budget) return;
  budget.bytes += Buffer.byteLength(value, "utf8") + 2;
  if (budget.bytes > MAX_HASH_TOTAL_BYTES) {
    throw new InvalidTypeValueError(
      `Input exceeds aggregate serialized size limit of ${MAX_HASH_TOTAL_BYTES} bytes. ` +
      `Refusing to hash to prevent denial of service.`
    );
  }
}

function sortKeysDeep(value: unknown, ancestors?: Set<object>, depth = 0, budget?: { bytes: number }): unknown {
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
  if (typeof value === "string") {
    checkStringBounds(value, budget);
    return value;
  }
  if (Array.isArray(value)) return sortArray(value, ancestors, depth, budget ?? { bytes: 0 });
  if (value instanceof Map) return sortMap(value, ancestors, depth, budget ?? { bytes: 0 });
  if (value instanceof Set) return sortSet(value, ancestors, depth, budget ?? { bytes: 0 });
  if (typeof value === "object") return sortObject(value, ancestors, depth, budget ?? { bytes: 0 });
  return sortPrimitive(value);
}

/** Serialize a non-container primitive (bigint/symbol/function/others) for hashing. */
function sortPrimitive(value: unknown): unknown {
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
function countKeys(value: unknown): number {
  if (value === null || value === undefined || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    let count = value.length;
    for (const item of value) count += countKeys(item);
    return count;
  }
  if (value instanceof Map) {
    let count = value.size;
    for (const v of value.values()) count += countKeys(v);
    return count;
  }
  if (value instanceof Set) {
    let count = value.size;
    for (const v of value) count += countKeys(v);
    return count;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let count = entries.length;
  for (const [, v] of entries) count += countKeys(v);
  return count;
}

export function hashInput(input: unknown): string {
  try {
    const budget = { bytes: 0 };
    const canonical = sortKeysDeep(input, undefined, 0, budget);
    const keyCount = countKeys(canonical);
    if (keyCount > MAX_HASH_KEYS) {
      throw new InvalidTypeValueError(
        `Input has too many keys (${keyCount}, max ${MAX_HASH_KEYS}). Refusing to hash to prevent DoS.`
      );
    }
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
