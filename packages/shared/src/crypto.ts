import { createHash } from "node:crypto";
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
    throw new InvalidTypeValueError("Circular reference detected in hash input");
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
    const prepared: Array<{ v: unknown; kSorted: unknown; kStr: string }> = entries
      .map(([k, v]) => {
        const kSorted = sortKeysDeep(k, ancestors, depth + 1, budget);
        return { v, kSorted, kStr: JSON.stringify(kSorted) };
      });
    for (const entry of prepared) {
      // Charge the key bytes to the aggregate budget. For string keys,
      // checkStringBounds already charged the key value via sortKeysDeep;
      // chargeKeyBytes here adds the JSON quote overhead (+2) for the
      // serialized form. For non-string keys, pass the JSON-stringified
      // form which has no outer quotes.
      if (typeof entry.kSorted !== "string") {
        chargeKeyBytes(entry.kStr, budget);
      } else {
        budget.bytes += 2;
        if (budget.bytes > MAX_HASH_TOTAL_BYTES) {
          throw new InvalidTypeValueError(
            `Input exceeds aggregate serialized size limit of ${MAX_HASH_TOTAL_BYTES} bytes. ` +
            `Refusing to hash to prevent denial of service.`
          );
        }
      }
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
    // in the comparator (same optimization as sortMap). Each element is first
    // run through sortKeysDeep (which charges its string *values* to the
    // budget) — but a Set of *strings* (the dominant case for large
    // payloads) produces elements that are already strings, so their bytes
    // are never charged here. Charge each element's serialized bytes to the
    // aggregate budget so a wide Set of large strings cannot bypass the
    // MAX_HASH_TOTAL_BYTES DoS guard (object/Map keys ARE charged via
    // chargeKeyBytes; this was the missing leg — a Set of ~30 × 99 KB
    // strings previously hashed successfully, emitting a ~3 MB buffer).
    //
    // Only charge structural bytes for the container itself (the JSON array
    // wrapper `[...]` plus separators between elements). Individual elements
    // are already charged via sortKeysDeep above, so we do NOT re-charge
    // their serialized form here — doing so double-counted every element
    // (sortKeysDeep charged string values, then JSON.stringify +
    // chargeKeyBytes charged them again), causing legitimate inputs to
    // exceed the budget and be rejected as DoS.
    const prepared = Array.from(value, (v) => {
      const sorted = sortKeysDeep(v, ancestors, depth + 1, budget);
      return { v: sorted, str: JSON.stringify(sorted) };
    });
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

const TEXT_ENCODER = new TextEncoder();

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
  const len = TEXT_ENCODER.encode(value).length;
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
  budget.bytes += TEXT_ENCODER.encode(value).length + 2;
  if (budget.bytes > MAX_HASH_TOTAL_BYTES) {
    throw new InvalidTypeValueError(
      `Input exceeds aggregate serialized size limit of ${MAX_HASH_TOTAL_BYTES} bytes. ` +
      `Refusing to hash to prevent denial of service.`
    );
  }
}

/**
 * Dispatch a non-null, non-undefined, non-string, non-number value to the
 * correct recursive sorter. Extracted from {@link sortKeysDeep} to keep that
 * entry point's cyclomatic complexity within the lint cap while preserving the
 * single budget/ancestors threading that every container sorter depends on.
 *
 * A missing `budget` (a caller passing only the first three args) is
 * materialized to a zeroed local so container and string sorters still charge
 * their keys/values, mirroring the previous inline `budget ?? { bytes: 0 }`
 * defaulting.
 */
function dispatchContainer(
  value: object,
  ancestors: Set<object>,
  depth: number,
  budget?: { bytes: number },
): unknown {
  const b = budget ?? { bytes: 0 };
  if (Array.isArray(value)) return sortArray(value, ancestors, depth, b);
  if (value instanceof Map) return sortMap(value, ancestors, depth, b);
  if (value instanceof Set) return sortSet(value, ancestors, depth, b);
  return sortObject(value, ancestors, depth, b);
}

function sortKeysDeep(value: unknown, ancestors?: Set<object>, depth = 0, budget?: { bytes: number }): unknown {
  if (depth > MAX_HASH_DEPTH) {
    throw new InvalidTypeValueError(
      `Input exceeds maximum nesting depth of ${MAX_HASH_DEPTH}. Refusing to hash to prevent stack overflow.`
    );
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === "string") {
    checkStringBounds(value, budget);
    return value;
  }
  ancestors = ancestors ?? new Set<object>();
  if (typeof value !== "object") return sortPrimitive(value);
  return dispatchContainer(value, ancestors, depth, budget);
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
function countKeys(value: unknown, ancestors?: Set<object>, depth = 0): number {
  if (value === null || value === undefined || typeof value !== "object") return 0;
  // Mirror sortKeysDeep's depth guard. Without this, a deeply-nested input
  // (e.g. a 15k-level nested array) would blow the call stack inside countKeys
  // with a RangeError BEFORE the documented MAX_HASH_DEPTH guard in
  // sortKeysDeep ever runs — defeating the stack-overflow DoS protection the
  // architecture explicitly documents. The range check uses `>` (depth must
  // exceed the limit) to match sortKeysDeep exactly, so both recursion passes
  // reject at the same depth.
  if (depth > MAX_HASH_DEPTH) {
    throw new InvalidTypeValueError(
      `Input exceeds maximum nesting depth of ${MAX_HASH_DEPTH}. Refusing to hash to prevent stack overflow.`
    );
  }
  ancestors = ancestors ?? new Set<object>();
  if (ancestors.has(value)) return 0;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return countArrayKeys(value, ancestors, depth);
    if (value instanceof Map) return countMapKeys(value, ancestors, depth);
    if (value instanceof Set) return countSetKeys(value, ancestors, depth);
    if (value instanceof Error) return countErrorKeys(value, ancestors, depth);
    return countObjectKeys(value as Record<string, unknown>, ancestors, depth);
  } finally {
    ancestors.delete(value);
  }
}

function countArrayKeys(value: unknown[], ancestors: Set<object>, depth: number): number {
  let count = value.length;
  for (const item of value) count += countKeys(item, ancestors, depth + 1);
  return count;
}

function countMapKeys(value: Map<unknown, unknown>, ancestors: Set<object>, depth: number): number {
  let count = value.size;
  for (const [k, v] of value) {
    count += countKeys(k, ancestors, depth + 1);
    count += countKeys(v, ancestors, depth + 1);
  }
  return count;
}

function countSetKeys(value: Set<unknown>, ancestors: Set<object>, depth: number): number {
  let count = value.size;
  for (const v of value) count += countKeys(v, ancestors, depth + 1);
  return count;
}

function countErrorKeys(value: Error, ancestors: Set<object>, depth: number): number {
  // Count the keys on the Error object itself (name, message, ...), then
  // recurse through cause so a deep cause chain is accurately counted —
  // otherwise an input like { cause: Error(cause: Error(cause: …)) }
  // undercounts and passes MAX_HASH_KEYS while sortKeysDeep still walks
  // the full chain, risking stack overflow before the depth guard fires.
  let count = Object.keys(value).length;
  if (value.cause != null && typeof value.cause === "object") {
    count += countKeys(value.cause, ancestors, depth + 1);
  }
  return count;
}

function countObjectKeys(value: Record<string, unknown>, ancestors: Set<object>, depth: number): number {
  const entries = Object.entries(value);
  let count = entries.length;
  for (const [, v] of entries) count += countKeys(v, ancestors, depth + 1);
  return count;
}

export function hashInput(input: unknown): string {
  try {
    const keyCount = countKeys(input);
    if (keyCount > MAX_HASH_KEYS) {
      throw new InvalidTypeValueError(
        `Input has too many keys (${keyCount}, max ${MAX_HASH_KEYS}). Refusing to hash to prevent DoS.`
      );
    }
    // Per-invocation CPU-time budget: a deeply nested but wide structure
    // (e.g. an array of thousands of 100-char strings) can pass the depth
    // and byte-budget guards yet still consume excessive CPU during
    // JSON.stringify + sortKeysDeep. Snapshot hrtime before the heavy work
    // and abort if the wall-clock budget is exceeded — this catches pathological
    // inputs that slip past the structural guards without requiring a full
    // performance profiler on every call.
    const budgetStart = performance.now();
    const BUDGET_MS = 50;
    const budget = { bytes: 0 };
    const canonical = sortKeysDeep(input, new Set(), 0, budget);
    const elapsed = performance.now() - budgetStart;
    if (elapsed > BUDGET_MS) {
      throw new InvalidTypeValueError(
        `Hashing exceeded the CPU-time budget of ${BUDGET_MS}ms (${elapsed.toFixed(1)}ms). ` +
        `Refusing to hash to prevent denial of service.`
      );
    }
    const serialized = JSON.stringify(canonical);
    return createHash("sha256")
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
