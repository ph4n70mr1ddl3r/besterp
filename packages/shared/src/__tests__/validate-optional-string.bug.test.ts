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
