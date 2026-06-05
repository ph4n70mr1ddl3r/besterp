// Unit tests for crypto utilities in @besterp/shared.
// Tests hashing functionality with various inputs and edge cases.

import { describe, it, expect } from "vitest";
import { hashInput } from "../crypto.js";

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
    
    // Ensure hashes are consistent for the same symbol instance
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
});