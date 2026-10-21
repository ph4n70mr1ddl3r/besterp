import { describe, it, expect } from "vitest";
import { decimalToNumber } from "../decimal.js";

// Minimal stand-in for Prisma.Decimal (decimal.js): an OBJECT with a
// `toNumber()` method. The bug this helper exists for was a `typeof x ===
// "number"` check, which is never true for a real DECIMAL column.
class FakeDecimal {
  constructor(private readonly value: number) {}
  toNumber(): number {
    return this.value;
  }
  toString(): string {
    return String(this.value);
  }
}

describe("decimalToNumber", () => {
  it("returns a plain number unchanged", () => {
    expect(decimalToNumber(10.5)).toBe(10.5);
    expect(decimalToNumber(0)).toBe(0);
    expect(decimalToNumber(-3)).toBe(-3);
  });

  it("converts a Prisma.Decimal-like object (the real driver shape)", () => {
    // A Prisma DECIMAL column comes back as an OBJECT — a `typeof ===
    // "number"` check therefore never took the numeric branch and every
    // stored amount was reported as null / an internal type error.
    expect(decimalToNumber(new FakeDecimal(19.99))).toBe(19.99);
  });

  it("falls back to the string representation when toNumber() is unavailable", () => {
    expect(decimalToNumber({ toString: () => "42.5" })).toBe(42.5);
  });

  it("parses a numeric string", () => {
    expect(decimalToNumber("7.25")).toBe(7.25);
    expect(decimalToNumber("  8  ")).toBe(8);
  });

  it("returns null for absent / non-numeric values", () => {
    expect(decimalToNumber(null)).toBeNull();
    expect(decimalToNumber(undefined)).toBeNull();
    expect(decimalToNumber("")).toBeNull();
    expect(decimalToNumber("   ")).toBeNull();
    expect(decimalToNumber("not-a-number")).toBeNull();
    expect(decimalToNumber(Number.NaN)).toBeNull();
    expect(decimalToNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(decimalToNumber({})).toBeNull();
  });

  it("returns null when toNumber() throws", () => {
    const broken = {
      toNumber: () => { throw new Error("boom"); },
      toString: () => { throw new Error("boom"); },
    };
    expect(decimalToNumber(broken)).toBeNull();
  });
});

describe("decimalToNumber — non-finite toNumber() falls back to toString()", () => {
  it("uses the string representation when toNumber() is not finite", () => {
    // The previous implementation returned null immediately on a non-finite
    // toNumber() result, discarding a perfectly parseable string form.
    const overflowing = {
      toNumber: () => Number.POSITIVE_INFINITY,
      toString: () => "42",
    };
    expect(decimalToNumber(overflowing)).toBe(42);
  });
});
