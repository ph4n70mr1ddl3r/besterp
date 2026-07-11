import { describe, it, expect } from "vitest";
import { isWeakSecret, MIN_JWT_SECRET_LENGTH } from "./secret-strength.js";

describe("isWeakSecret", () => {
  // ─── Default / test literals ────────────────────────────────
  it("flags obvious default/test literals (case-insensitive)", () => {
    for (const v of ["secret", "SECRET", "ChAnGeMe", "test", "dev", "development"]) {
      expect(isWeakSecret(v), `expected '${v}' to be weak`).toBe(true);
    }
  });

  // ─── Zero-entropy (single repeated char) ────────────────────
  it("flags a single repeated character at/above the min length", () => {
    expect(isWeakSecret("0".repeat(MIN_JWT_SECRET_LENGTH))).toBe(true);
    expect(isWeakSecret("f".repeat(MIN_JWT_SECRET_LENGTH))).toBe(true);
    expect(isWeakSecret("F".repeat(MIN_JWT_SECRET_LENGTH))).toBe(true);
    expect(isWeakSecret("a".repeat(64))).toBe(true);
    expect(isWeakSecret(" ".repeat(MIN_JWT_SECRET_LENGTH))).toBe(true);
    expect(isWeakSecret("-".repeat(100))).toBe(true);
  });

  // ─── The regression this guards against ─────────────────────
  it("does NOT flag high-entropy 32-char hex secrets composed only of a–f", () => {
    // "abcdef..." repeated to 32 chars has full entropy. The previous
    // regex /^(0{32}|[a-f]{32})$/i incorrectly flagged this as weak.
    const highEntropyHexLetters = "abcdefabcdefabcdefabcdefabcdefab";
    expect(highEntropyHexLetters.length).toBe(MIN_JWT_SECRET_LENGTH);
    expect(isWeakSecret(highEntropyHexLetters)).toBe(false);

    // A random 32-char hex (includes digits) must also pass.
    const randomHex = "43a83b7dc2fc892360db6c2f954fe950";
    expect(isWeakSecret(randomHex)).toBe(false);
  });

  // ─── Strong secrets ─────────────────────────────────────────
  it("accepts realistic strong secrets", () => {
    // openssl rand -hex 32 → 64 hex chars
    expect(isWeakSecret("9f4c2b8e7a1d0f3c5b6e8d2a4f1c7b9e3a6d0c2b4f8e1a7d9c3b5e2f4a8d1c6")).toBe(false);
    // A passphrase-style secret with mixed chars
    expect(isWeakSecret("correct-horse-battery-staple-99!")).toBe(false);
  });

  // ─── Edge cases ─────────────────────────────────────────────
  it("treats empty / non-string input as weak", () => {
    expect(isWeakSecret("")).toBe(true);
    expect(isWeakSecret(undefined as unknown as string)).toBe(true);
    expect(isWeakSecret(null as unknown as string)).toBe(true);
  });

  it("does not apply the repeated-char heuristic below the min length", () => {
    // A short repeated string is rejected by the caller's length gate, not by
    // this heuristic — but ensure we don't misclassify odd short inputs.
    expect(isWeakSecret("aaa")).toBe(false);
  });
});
