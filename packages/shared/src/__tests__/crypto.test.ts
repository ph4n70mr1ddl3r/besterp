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
    const undefinedHash = hashInput(undefined);

    expect(stringHash).toMatch(/^[a-f0-9]{64}$/);\n    expect(numberHash).toMatch(/^[a-f0-9]{64}$/);\n    expect(booleanHash).toMatch(/^[a-f0-9]{64}$/);\n    expect(nullHash).toMatch(/^[a-f0-9]{64}$/);\n    expect(undefinedHash).toMatch(/^[a-f0-9]{64}$/);\n    \n    // All primitives should produce different hashes\n    expect(stringHash).not.toBe(numberHash);\n    expect(stringHash).not.toBe(booleanHash);\n    expect(numberHash).not.toBe(booleanHash);\n    expect(nullHash).not.toBe(undefinedHash);\n  });

  it("should handle arrays", () => {
    const array1 = [1, 2, 3];\n    const array2 = [1, 2, 3];\n    const array3 = [3, 2, 1];\n    \n    expect(hashInput(array1)).toBe(hashInput(array2)); // Same order = same hash\n    expect(hashInput(array1)).not.toBe(hashInput(array3)); // Different order = different hash\n  });

  it("should be independent of key insertion order in objects", () => {\n    const obj1 = { x: 1, y: 2, z: 3 };\n    const obj2 = { z: 3, y: 2, x: 1 };\n    const obj3 = { a: 1, b: 2, c: 3 };\n    \n    expect(hashInput(obj1)).toBe(hashInput(obj2)); // Same key-value pairs = same hash\n    expect(hashInput(obj1)).not.toBe(hashInput(obj3)); // Different keys = different hash\n  });

  it("should handle nested objects regardless of key order", () => {\n    const obj1 = { \n      outer: { inner: 1, other: 2 },\n      value: 3,\n      array: [1, 2, 3]\n    };\n    \n    const obj2 = {\n      value: 3,\n      array: [1, 2, 3],\n      outer: { other: 2, inner: 1 }\n    };\n    \n    expect(hashInput(obj1)).toBe(hashInput(obj2));\n  });\n\n  it("should handle special values", () => {\n    const zeroHash = hashInput(0);\n    const emptyStringHash = hashInput(\"\");\n    const falseHash = hashInput(false);\n    \n    expect(zeroHash).toMatch(/^[a-f0-9]{64}$/);\n    expect(emptyStringHash).toMatch(/^[a-f0-9]{64}$/);\n    expect(falseHash).toMatch(/^[a-f0-9]{64}$/);\n    \n    // All should be different\n    expect(zeroHash).not.toBe(emptyStringHash);\n    expect(zeroHash).not.toBe(falseHash);\n    expect(emptyStringHash).not.toBe(falseHash);\n  });\n\n  it("should handle large objects efficiently", () => {\n    const largeObject = {};\n    for (let i = 0; i < 1000; i++) {\n      largeObject[`key_${i}`] = `value_${i}`;\n    }\n    \n    // Should not throw and should produce a valid hash\n    expect(() => hashInput(largeObject)).not.toThrow();\n    const hash = hashInput(largeObject);\n    expect(hash).toMatch(/^[a-f0-9]{64}$/);\n  });\n\n  it("should handle circular references (throws error)", () => {\n    const circularObj: any = {};\n    circularObj.self = circularObj;\n    \n    expect(() => hashInput(circularObj)).toThrow();\n  });\n\n  it("should handle Date objects", () => {\n    const date1 = new Date(\"2024-01-01T00:00:00.000Z\");\n    const date2 = new Date(\"2024-01-01T00:00:00.000Z\");\n    const date3 = new Date(\"2024-01-02T00:00:00.000Z\");\n    \n    expect(hashInput(date1)).toBe(hashInput(date2)); // Same date = same hash\n    expect(hashInput(date1)).not.toBe(hashInput(date3)); // Different date = different hash\n  });\n\n  it("should handle BigInt values", () => {\n    const bigInt1 = BigInt(\"9007199254740991\");\n    const bigInt2 = BigInt(\"9007199254740992\");\n    \n    expect(() => hashInput(bigInt1)).not.toThrow();\n    expect(() => hashInput(bigInt2)).not.toThrow();\n    expect(hashInput(bigInt1)).not.toBe(hashInput(bigInt2));\n  });\n\n  it("should handle Symbol values", () => {\n    const symbol1 = Symbol(\"test\");\n    const symbol2 = Symbol(\"test\");\n    const symbol3 = Symbol(\"different\");\n    \n    expect(() => hashInput(symbol1)).not.toThrow();\n    expect(() => hashInput(symbol2)).not.toThrow();\n    expect(() => hashInput(symbol3)).not.toThrow();\n    \n    // Note: Different symbol instances with same description may still produce different hashes\n    // This is expected behavior as symbols are object instances\n  });\n\n  it("should handle mixed types in nested structures", () => {\n    const complexObj = {\n      string: \"hello\",\n      number: 42,\n      boolean: true,\n      nullValue: null,\n      array: [1, \"test\", true],\n      nested: {\n        date: new Date(),\n        symbol: Symbol(\"test\"),\n        bigint: BigInt(\"123\")\n      }\n    };\n    \n    expect(() => hashInput(complexObj)).not.toThrow();\n    const hash = hashInput(complexObj);\n    expect(hash).toMatch(/^[a-f0-9]{64}$/);\n    \n    // Same structure should produce same hash\n    const identicalComplexObj = {\n      string: \"hello\",\n      number: 42,\n      boolean: true,\n      nullValue: null,\n      array: [1, \"test\", true],\n      nested: {\n        date: complexObj.nested.date,\n        symbol: complexObj.nested.symbol,\n        bigint: BigInt(\"123\")\n      }\n    };\n    \n    expect(hashInput(complexObj)).toBe(hashInput(identicalComplexObj));\n  });\n\n  it("should be case-sensitive for strings", () => {\n    const hash1 = hashInput(\"Hello\");\n    const hash2 = hashInput(\"hello\");\n    \n    expect(hash1).not.toBe(hash2);\n  });\n\n  it("should handle whitespace in strings", () => {\n    const hash1 = hashInput(\"hello world\");\n    const hash2 = hashInput(\"helloworld\");\n    const hash3 = hashInput(\" hello world \");\n    \n    expect(hash1).not.toBe(hash2);\n    expect(hash1).not.toBe(hash3);\n    expect(hash2).not.toBe(hash3);\n  });\n});