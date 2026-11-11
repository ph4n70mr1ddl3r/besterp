import { describe, it, expect } from "vitest";
import { validateOptionalString, isValidOptionalId } from "../validation.js";

describe("validateOptionalString", () => {
  it("should reject control character \\x1f", () => {
    expect(() => validateOptionalString('field', '\x1f', 10)).toThrow();
    expect(isValidOptionalId('\x1f')).toBe(false);
  });

  it("should accept empty string and return undefined", () => {
    const result = validateOptionalString('field', '', 10);
    expect(result).toBeUndefined();
  });

  it("should throw on whitespace-only string", () => {
    expect(() => validateOptionalString('field', '   ', 10)).toThrow();
  });

  it("should accept normal string", () => {
    const result = validateOptionalString('field', 'hello', 10);
    expect(result).toBe('hello');
  });
});

describe("isValidOptionalId", () => {
  it("should now trim before pattern check (consistent with validateOptionalString)", () => {
    // After the fix, isValidOptionalId trims input before pattern-checking,
    // making it consistent with validateOptionalString.
    // Both now accept 'hello' after trimming whitespace.
    expect(isValidOptionalId(' hello ')).toBe(true);
    expect(validateOptionalString('field', ' hello ', 10)).toBe('hello');
  });

  it("should reject control character \\x1f", () => {
    expect(isValidOptionalId('\x1f')).toBe(false);
  });

  it("should accept normal string", () => {
    expect(isValidOptionalId('hello')).toBe(true);
  });
});
