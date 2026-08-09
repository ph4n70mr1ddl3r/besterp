// Unit tests for crypto utilities in @besterp/shared.
// Tests hashing functionality with various inputs and edge cases.

import { describe, it, expect } from "vitest";
import { hashInput } from "../crypto.js";
import { InvalidTypeValueError } from "../errors.js";

describe("hashInput", () => {
  it("should produce consistent SHA-256 hashes for the same input", () => {
    const input = { name: "test", value: 42, nested: { a: 1, b: 2 } };
    const hash1 = hashInput(input);
    const hash2 = hashInput(input);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64-character hex string
  });

  it("should produce different hashes for different inputs", () => {
    const hash1 = hashInput({ a: 1, b: 2 });
    const hash2 = hashInput({ a: 1, b: 3 });
    const hash3 = hashInput({ a: 2, b: 2 });

    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });

  it("should handle primitive types", () => {
    const stringHash = hashInput("hello world");
    const numberHash = hashInput(42);
    const booleanHash = hashInput(true);
    const nullHash = hashInput(null);
    // undefined is normalized to null in our implementation
    const undefinedHash = hashInput(undefined);

    expect(stringHash).toMatch(/^[a-f0-9]{64}$/);
    expect(numberHash).toMatch(/^[a-f0-9]{64}$/);
    expect(booleanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(nullHash).toMatch(/^[a-f0-9]{64}$/);
    expect(undefinedHash).toMatch(/^[a-f0-9]{64}$/);
    
    // All primitives should produce different hashes except undefined -> null
    expect(stringHash).not.toBe(numberHash);
    expect(stringHash).not.toBe(booleanHash);
    expect(numberHash).not.toBe(booleanHash);
    // undefined and null should produce the same hash after normalization
    expect(undefinedHash).toBe(nullHash);
  });

  it("should handle arrays", () => {
    const array1 = [1, 2, 3];
    const array2 = [1, 2, 3];
    const array3 = [3, 2, 1];
    
    expect(hashInput(array1)).toBe(hashInput(array2)); // Same order = same hash
    expect(hashInput(array1)).not.toBe(hashInput(array3)); // Different order = different hash
  });

  it("should be independent of key insertion order in objects", () => {
    const obj1 = { x: 1, y: 2, z: 3 };
    const obj2 = { z: 3, y: 2, x: 1 };
    const obj3 = { a: 1, b: 2, c: 3 };
    
    expect(hashInput(obj1)).toBe(hashInput(obj2)); // Same key-value pairs = same hash
    expect(hashInput(obj1)).not.toBe(hashInput(obj3)); // Different keys = different hash
  });

  it("should handle nested objects regardless of key order", () => {
    const obj1 = { 
      outer: { inner: 1, other: 2 },
      value: 3,
      array: [1, 2, 3]
    };
    
    const obj2 = {
      value: 3,
      array: [1, 2, 3],
      outer: { other: 2, inner: 1 }
    };
    
    expect(hashInput(obj1)).toBe(hashInput(obj2));
  });

  it("should handle special values", () => {
    const zeroHash = hashInput(0);
    const emptyStringHash = hashInput("");
    const falseHash = hashInput(false);
    
    expect(zeroHash).toMatch(/^[a-f0-9]{64}$/);
    expect(emptyStringHash).toMatch(/^[a-f0-9]{64}$/);
    expect(falseHash).toMatch(/^[a-f0-9]{64}$/);
    
    // All should be different
    expect(zeroHash).not.toBe(emptyStringHash);
    expect(zeroHash).not.toBe(falseHash);
    expect(emptyStringHash).not.toBe(falseHash);
  });

  it("should handle large objects efficiently", () => {
    const largeObject: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      largeObject[`key_${i}`] = `value_${i}`;
    }
    
    // Should not throw and should produce a valid hash
    expect(() => hashInput(largeObject)).not.toThrow();
    const hash = hashInput(largeObject);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should handle circular references (throws error)", () => {
    const circularObj: any = {};
    circularObj.self = circularObj;
    
    expect(() => hashInput(circularObj)).toThrow();
  });

  it("should handle objects with no prototype (Object.create(null))", () => {
    const noProto = Object.create(null);
    noProto.a = 1;
    noProto.b = 2;

    // Should sort keys like a regular object
    expect(() => hashInput(noProto)).not.toThrow();
    const hash = hashInput(noProto);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Same key-value pairs should produce same hash regardless of creation order
    const noProto2 = Object.create(null);
    noProto2.b = 2;
    noProto2.a = 1;
    expect(hashInput(noProto2)).toBe(hash);
  });

  it("should handle Date objects", () => {
    const date1 = new Date("2024-01-01T00:00:00.000Z");
    const date2 = new Date("2024-01-01T00:00:00.000Z");
    const date3 = new Date("2024-01-02T00:00:00.000Z");
    
    expect(hashInput(date1)).toBe(hashInput(date2)); // Same date = same hash
    expect(hashInput(date1)).not.toBe(hashInput(date3)); // Different date = different hash
  });

  it("should handle BigInt values", () => {
    const bigInt1 = BigInt("9007199254740991");
    const bigInt2 = BigInt("9007199254740992");
    
    expect(() => hashInput(bigInt1)).not.toThrow();
    expect(() => hashInput(bigInt2)).not.toThrow();
    expect(hashInput(bigInt1)).not.toBe(hashInput(bigInt2));
    
    // Big integers should be serialized consistently
    expect(hashInput(bigInt1)).toBe(hashInput(BigInt("9007199254740991")));
  });

  it("should handle Symbol values", () => {
    const symbol1 = Symbol("test");
    const symbol2 = Symbol("test");
    const symbol3 = Symbol("different");
    
    expect(() => hashInput(symbol1)).not.toThrow();
    expect(() => hashInput(symbol2)).not.toThrow();
    expect(() => hashInput(symbol3)).not.toThrow();
    
    // Symbols with the same description should produce the same hash
    // This is intentional behavior for idempotency - symbols with the same description
    // are treated as equivalent for hashing purposes
    expect(hashInput(symbol1)).toBe(hashInput(symbol2));
    
    // Symbols with different descriptions should produce different hashes
    expect(hashInput(symbol1)).not.toBe(hashInput(symbol3));
    
    // Same symbol should produce the same hash
    expect(hashInput(symbol1)).toBe(hashInput(symbol1));
  });

  it("should handle mixed types in nested structures", () => {
    const complexObj = {
      string: "hello",
      number: 42,
      boolean: true,
      nullValue: null,
      array: [1, "test", true],
      nested: {
        date: new Date("2024-01-01T00:00:00.000Z"),
        symbol: Symbol("test"),
        bigint: BigInt("123")
      }
    };
    
    expect(() => hashInput(complexObj)).not.toThrow();
    const hash = hashInput(complexObj);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    
    // Same structure should produce same hash
    const identicalComplexObj = {
      string: "hello",
      number: 42,
      boolean: true,
      nullValue: null,
      array: [1, "test", true],
      nested: {
        date: new Date("2024-01-01T00:00:00.000Z"),
        symbol: Symbol("test"),
        bigint: BigInt("123")
      }
    };
    
    expect(hashInput(complexObj)).toBe(hashInput(identicalComplexObj));
  });

  it("should normalize NaN and Infinity to null for deterministic hashing", () => {
    const nanHash = hashInput(NaN);
    const infHash = hashInput(Infinity);
    const negInfHash = hashInput(-Infinity);
    const nullHash = hashInput(null);

    // All non-finite numbers and null should produce the same hash
    expect(nanHash).toBe(nullHash);
    expect(infHash).toBe(nullHash);
    expect(negInfHash).toBe(nullHash);

    // Finite numbers should still hash distinctly
    const zeroHash = hashInput(0);
    expect(zeroHash).not.toBe(nullHash);
  });

  it("should be case-sensitive for strings", () => {
    const hash1 = hashInput("Hello");
    const hash2 = hashInput("hello");
    
    expect(hash1).not.toBe(hash2);
  });

  it("should handle whitespace in strings", () => {
    const hash1 = hashInput("hello world");
    const hash2 = hashInput("helloworld");
    const hash3 = hashInput(" hello world ");
    
    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });

  it("should be order-independent for Map keys (canonical [key,value] sorting)", () => {
    // Maps are converted to sorted [key, value] pairs so insertion order
    // doesn't affect the hash. This matters for idempotency: two tool calls
    // whose only difference is Map iteration order must hash identically.
    const m1 = new Map([
      ["b", 2],
      ["a", 1],
      ["c", 3],
    ]);
    const m2 = new Map([
      ["c", 3],
      ["a", 1],
      ["b", 2],
    ]);
    expect(hashInput({ m: m1 })).toBe(hashInput({ m: m2 }));

    // Different Map contents must still hash differently.
    const m3 = new Map([["a", 99]]);
    expect(hashInput({ m: m1 })).not.toBe(hashInput({ m: m3 }));
  });

  it("should be order-independent for Set values (sorted before hashing)", () => {
    // Sets are converted to a sorted array so iteration order doesn't
    // affect the hash.
    const s1 = new Set([3, 1, 2]);
    const s2 = new Set([1, 2, 3]);
    expect(hashInput({ s: s1 })).toBe(hashInput({ s: s2 }));

    // Different Set contents must still hash differently.
    const s3 = new Set([1, 2, 4]);
    expect(hashInput({ s: s1 })).not.toBe(hashInput({ s: s3 }));
  });

  it("should reject WeakMap/WeakSet instead of silently hashing them as {}", () => {
    // Regression guard: WeakMap/WeakSet are non-enumerable, so Object.keys()
    // returns [] and they previously fell through to sortPlainObject —
    // producing the SAME hash as an empty object (and as every other Weak
    // collection). That is silent data loss / a hash collision for an
    // idempotency hash. They cannot be enumerated, so they cannot be
    // deterministically hashed — reject them (mirrors the function guard).
    expect(() => hashInput(new WeakMap())).toThrow(InvalidTypeValueError);
    expect(() => hashInput(new WeakSet())).toThrow(InvalidTypeValueError);
    expect(() => hashInput(new WeakMap())).toThrow(/WeakMap\/WeakSet/);

    // A Weak collection nested inside an object must also reject, not silently
    // hash as `{ w: {} }`.
    expect(() => hashInput({ w: new WeakMap() })).toThrow(InvalidTypeValueError);
    expect(() => hashInput({ w: new WeakSet() })).toThrow(InvalidTypeValueError);

    // By contrast, a regular empty object still hashes successfully and must
    // NOT throw — ensures the guard targets Weak collections only.
    expect(() => hashInput({})).not.toThrow();
    expect(hashInput({})).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should refuse to hash input nested deeper than MAX_HASH_DEPTH (DoS guard)", () => {
    // Build nesting ~120 levels deep — beyond the MAX_HASH_DEPTH (100) cap.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i  < 120; i++) {
      deep = { nested: deep };
    }
    expect(() => hashInput(deep)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(deep)).toThrow(/maximum nesting depth/);

    // Shallow input is unaffected.
    expect(() => hashInput({ a: { b: { c: 1 } } })).not.toThrow();
  });

  it("should throw InvalidTypeValueError (not RangeError) on pathological nesting (stack-overflow regression)", () => {
    // Regression (round 115): countKeys recursed without any depth guard, so a
    // nested array ~15k levels deep blew the call stack with a RangeError
    // BEFORE sortKeysDeep's documented MAX_HASH_DEPTH (100) guard ever ran.
    // The depth check now lives in BOTH passes so the input is rejected at the
    // same depth by countKeys (the first recursion) instead of crashing.
    //
    // 15k levels is chosen to exceed the previous natural stack limit: with
    // ~2 frames per level the old code overflowed well below 15k, so this test
    // fails (RangeError, not InvalidTypeValueError) if the guard regresses.
    let deep: unknown = [];
    for (let i = 0; i < 15_000; i++) {
      deep = [deep];
    }
    expect(() => hashInput(deep)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(deep)).toThrow(/maximum nesting depth/);

    // Shallow input is unaffected.
    expect(() => hashInput([[[1]]])).not.toThrow();
  });

  it("should preserve full Error.cause depth (no silent collision across cause depths)", () => {
    // Regression guard: Error.cause is recursively serialized with the same
    // depth/canonicalisation as any other value. Two inputs whose only
    // difference is the depth of their `cause` chain must hash DISTINCTLY,
    // otherwise two different tool inputs could collide to the same
    // idempotency hash (defeating mismatch detection).
    const shallow = { e: Object.assign(new Error("boom"), { cause: new Error("inner") }) };
    const deeper = {
      e: Object.assign(new Error("boom"), {
        cause: Object.assign(new Error("mid"), { cause: new Error("inner") }),
      }),
    };
    expect(hashInput(shallow)).not.toBe(hashInput(deeper));
  });

  it("should throw on a circular Error.cause chain (consistent with other circular types)", () => {
    // Regression guard: a circular `cause` chain must be detected and throw
    // like every other circular reference (previously it was silently
    // flattened to one level and returned a hash without throwing).
    const a: Record<string, unknown> = new Error("a");
    const b: Record<string, unknown> = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(() => hashInput({ e: a })).toThrow(/Circular reference detected in hash input/);
  });

  it("should refuse to hash an oversized string value (DoS guard)", () => {
    // A single huge string slips past the MAX_HASH_KEYS structural guard
    // (countKeys counts 0 keys for a primitive string) and would otherwise be
    // JSON.stringified into a multi-hundred-MB buffer. The per-value byte cap
    // must reject it before that.
    const huge = "x".repeat(200_000);
    expect(() => hashInput(huge)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(huge)).toThrow(/longer than/);

    // A huge string nested inside an object is also rejected, not silently hashed.
    expect(() => hashInput({ note: huge })).toThrow(InvalidTypeValueError);

    // A string just under the cap is accepted (no false positives at the boundary).
    const nearLimit = "x".repeat(99_000);
    expect(() => hashInput(nearLimit)).not.toThrow();
    expect(hashInput(nearLimit)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should refuse to hash many near-limit strings that exceed the aggregate size budget (memory-DoS guard)", () => {
    // Each string is under MAX_HASH_STRING_BYTES (99 KB) and the key count
    // (1200) is under MAX_HASH_KEYS (10_000), so the per-string and per-key
    // guards alone pass — but JSON.stringifying 1200×99 KB ≈ 115 MB would
    // exhaust memory / block the event loop. The aggregate byte budget must
    // reject this before serialization.
    const wide = Array.from({ length: 1200 }, () => "x".repeat(99_000));
    expect(() => hashInput(wide)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(wide)).toThrow(/aggregate serialized size limit/);

    // A small number of near-limit strings stays well within budget.
    const modest = Array.from({ length: 8 }, () => "x".repeat(99_000));
    expect(() => hashInput(modest)).not.toThrow();
    expect(hashInput(modest)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should charge object/Map key-name bytes to the aggregate size budget (key-only over-flow guard)", () => {
    // Regression: checkStringBounds only fired for string *values*, so a wide
    // object of long *keys* with empty values escaped the aggregate guard and
    // JSON.stringified past MAX_HASH_TOTAL_BYTES. Each key is ~200 bytes; ~12k
    // keys would add ~2.4 MB of *key* bytes (plus quotes) on top of the value
    // budget — larger than the 2 MB aggregate cap — and must now be rejected.
    const wideKeys: Record<string, string> = {};
    for (let i = 0; i < 12_000; i++) {
      wideKeys[`k${"x".repeat(196)}_${i}`] = "";
    }
    expect(() => hashInput(wideKeys)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(wideKeys)).toThrow(/too many keys/);

    // A modest number of long keys stays within budget (no false positive).
    const modestKeys: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      modestKeys[`k${"x".repeat(196)}_${i}`] = "";
    }
    expect(() => hashInput(modestKeys)).not.toThrow();
  });

  it("should charge nested Map key bytes to the aggregate size budget", () => {
    const wideMap = new Map<string, string>();
    for (let i = 0; i < 12_000; i++) {
      wideMap.set(`k${"x".repeat(196)}_${i}`, "");
    }
    expect(() => hashInput(wideMap)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(wideMap)).toThrow(/too many keys/);
  });

  it("should charge Set element bytes to the aggregate size budget", () => {
    // Regression (round 50): sortSet ran JSON.stringify(v) only for sorting
    // and never charged the element bytes to the aggregate budget, while
    // object/Map values ARE charged via checkStringBounds/chargeKeyBytes. A
    // Set of ~30 × 99 KB string elements (≈3 MB) therefore hashed
    // successfully and emitted a ~3 MB buffer, bypassing the
    // MAX_HASH_TOTAL_BYTES DoS guard that every other container honored.
    // NOTE: elements must be DISTINCT — a Set de-duplicates identical
    // values, so we suffix each with its index.
    const wideSet = new Set(Array.from({ length: 30 }, (_, i) => `x${i}`.padEnd(99_000, "x")));
    expect(() => hashInput(wideSet)).toThrow(InvalidTypeValueError);
    expect(() => hashInput(wideSet)).toThrow(/aggregate serialized size limit/);

    // A modest Set of near-limit strings stays within budget (no false positive).
    const modestSet = new Set(Array.from({ length: 8 }, (_, i) => `x${i}`.padEnd(99_000, "x")));
    expect(() => hashInput(modestSet)).not.toThrow();
    expect(hashInput(modestSet)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should hash a Set containing BigInt/undefined without throwing", () => {
    // Regression: sortSet ran JSON.stringify() on the RAW element, so a Set
    // containing a BigInt threw "Do not know how to serialize a BigInt" rather
    // than normalizing it like every other container. sortKeysDeep converts
    // BigInt→"BigInt:…" and undefined→null, so now it hashes deterministically.
    const bigIntSet = new Set([1n, 2n, 3n]);
    expect(() => hashInput(bigIntSet)).not.toThrow();
    expect(hashInput(bigIntSet)).toMatch(/^[a-f0-9]{64}$/);
    // Deterministic: same elements yield same hash regardless of insertion order.
    expect(hashInput(new Set([3n, 1n, 2n]))).toBe(hashInput(bigIntSet));

    const mixedSet = new Set([1, "a", undefined, { k: 2 }, null]);
    expect(() => hashInput(mixedSet)).not.toThrow();
    expect(hashInput(mixedSet)).toMatch(/^[a-f0-9]{64}$/);
  });
});
