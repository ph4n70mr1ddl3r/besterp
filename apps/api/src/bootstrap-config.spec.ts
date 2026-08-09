import { describe, it, expect } from "vitest";
import {
  resolveRateLimitConfig,
  resolveHardExitTimeoutMs,
  resolveTrustProxyHops,
  normalizeEnvironmentValue,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_MAX_PER_WINDOW,
  DEFAULT_HARD_EXIT_TIMEOUT_MS,
  DEFAULT_TRUST_PROXY_HOPS,
  MAX_TRUST_PROXY_HOPS,
  MAX_RATE_LIMIT_WINDOW_MS,
  MAX_RATE_LIMIT_MAX_PER_WINDOW,
} from "./bootstrap-config.js";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("resolveRateLimitConfig", () => {
  it("uses defaults when the variables are unset", () => {
    expect(resolveRateLimitConfig(env({}))).toEqual({
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
      max: DEFAULT_RATE_LIMIT_MAX_PER_WINDOW,
    });
  });

  it("uses defaults when the variables are empty strings", () => {
    expect(resolveRateLimitConfig(env({ RATE_LIMIT_WINDOW_MS: "", RATE_LIMIT_MAX_PER_WINDOW: "" }))).toEqual({
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
      max: DEFAULT_RATE_LIMIT_MAX_PER_WINDOW,
    });
  });

  it("parses valid positive integers", () => {
    expect(resolveRateLimitConfig(env({ RATE_LIMIT_WINDOW_MS: "120000", RATE_LIMIT_MAX_PER_WINDOW: "600" }))).toEqual({
      windowMs: 120_000,
      max: 600,
    });
  });

  it("throws on a non-numeric value instead of silently disabling rate limiting", () => {
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_MAX_PER_WINDOW: "abc" }))).toThrow("RATE_LIMIT_MAX_PER_WINDOW");
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_WINDOW_MS: "10s" }))).toThrow("RATE_LIMIT_WINDOW_MS");
  });

  it("throws on zero, negative, or non-integer values", () => {
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_MAX_PER_WINDOW: "0" }))).toThrow();
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_MAX_PER_WINDOW: "-5" }))).toThrow();
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_WINDOW_MS: "1.5" }))).toThrow();
  });

  it("rejects values above the sane maximum (bounded-knob regression)", () => {
    // Regression (round 115): parsePositiveInteger accepted any magnitude, so a
    // typo like RATE_LIMIT_MAX_PER_WINDOW=999999999999 disabled rate limiting
    // for all practical purposes (never hit) — a silent security downgrade.
    // Both knobs now clamp/reject at explicit caps.
    expect(resolveRateLimitConfig(env({ RATE_LIMIT_WINDOW_MS: String(MAX_RATE_LIMIT_WINDOW_MS), RATE_LIMIT_MAX_PER_WINDOW: String(MAX_RATE_LIMIT_MAX_PER_WINDOW) }))).toEqual({
      windowMs: MAX_RATE_LIMIT_WINDOW_MS,
      max: MAX_RATE_LIMIT_MAX_PER_WINDOW,
    });
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_WINDOW_MS: String(MAX_RATE_LIMIT_WINDOW_MS + 1) }))).toThrow("RATE_LIMIT_WINDOW_MS");
    expect(() => resolveRateLimitConfig(env({ RATE_LIMIT_MAX_PER_WINDOW: String(MAX_RATE_LIMIT_MAX_PER_WINDOW + 1) }))).toThrow("RATE_LIMIT_MAX_PER_WINDOW");
  });
});

describe("resolveHardExitTimeoutMs", () => {
  it("uses the default when unset or empty", () => {
    expect(resolveHardExitTimeoutMs(env({}))).toBe(DEFAULT_HARD_EXIT_TIMEOUT_MS);
    expect(resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "" }))).toBe(DEFAULT_HARD_EXIT_TIMEOUT_MS);
  });

  it("accepts a valid non-negative timeout", () => {
    expect(resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "25000" }))).toBe(25_000);
  });

  it("accepts 0 (immediate hard exit is a legitimate failover choice)", () => {
    expect(resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "0" }))).toBe(0);
  });

  it("throws on a negative value, which would otherwise silently force an immediate exit", () => {
    expect(() => resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "-30" }))).toThrow("HARD_EXIT_TIMEOUT_MS");
  });

  it("throws on an unparseable value", () => {
    expect(() => resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "abc" }))).toThrow("HARD_EXIT_TIMEOUT_MS");
  });

  it("treats a whitespace-only value as unset — NOT as an explicit 0ms hard exit", () => {
    // Regression guard (round 107): `Number("  ")` is 0, so a whitespace-only
    // value was previously parsed as an explicit 0 — a 0ms hard-exit timer
    // forces an immediate process.exit on any shutdown, silently destroying
    // graceful shutdown (the same damage class as the negative-value case).
    expect(resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "   " }))).toBe(DEFAULT_HARD_EXIT_TIMEOUT_MS);
    expect(resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: "\t" }))).toBe(DEFAULT_HARD_EXIT_TIMEOUT_MS);
  });

  it("parses a whitespace-padded valid value", () => {
    expect(resolveHardExitTimeoutMs(env({ HARD_EXIT_TIMEOUT_MS: " 25000 " }))).toBe(25_000);
  });
});

describe("normalizeEnvironmentValue", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeEnvironmentValue(undefined)).toBeUndefined();
  });

  it("lowercases and trims surrounding whitespace", () => {
    expect(normalizeEnvironmentValue("PRODUCTION")).toBe("production");
    expect(normalizeEnvironmentValue(" Development ")).toBe("development");
    expect(normalizeEnvironmentValue("production ")).toBe("production");
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeEnvironmentValue("")).toBe("");
  });
});

describe("resolveTrustProxyHops", () => {
  it("uses 0 (disabled) when unset or empty, keeping the fail-closed default", () => {
    expect(resolveTrustProxyHops(env({}))).toBe(DEFAULT_TRUST_PROXY_HOPS);
    expect(resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "" }))).toBe(DEFAULT_TRUST_PROXY_HOPS);
  });

  it("accepts 0 as an explicit opt-out", () => {
    expect(resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "0" }))).toBe(0);
  });

  it("parses a valid hop count", () => {
    expect(resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "1" }))).toBe(1);
    expect(resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "3" }))).toBe(3);
  });

  it("rejects negative, fractional, and unparseable values", () => {
    expect(() => resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "-1" }))).toThrow("TRUST_PROXY_HOPS");
    expect(() => resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "1.5" }))).toThrow("TRUST_PROXY_HOPS");
    expect(() => resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "abc" }))).toThrow("TRUST_PROXY_HOPS");
    expect(() => resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "1abc" }))).toThrow("TRUST_PROXY_HOPS");
  });

  it("rejects hop counts above the sane maximum", () => {
    expect(resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: String(MAX_TRUST_PROXY_HOPS) }))).toBe(MAX_TRUST_PROXY_HOPS);
    expect(() => resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: String(MAX_TRUST_PROXY_HOPS + 1) }))).toThrow("TRUST_PROXY_HOPS");
  });

  it("treats a whitespace-only value as unset (the fail-closed 0 default)", () => {
    expect(resolveTrustProxyHops(env({ TRUST_PROXY_HOPS: "   " }))).toBe(DEFAULT_TRUST_PROXY_HOPS);
  });
});
