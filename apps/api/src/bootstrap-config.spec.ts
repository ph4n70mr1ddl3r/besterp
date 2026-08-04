import { describe, it, expect } from "vitest";
import {
  resolveRateLimitConfig,
  resolveHardExitTimeoutMs,
  normalizeEnvironmentValue,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_MAX_PER_WINDOW,
  DEFAULT_HARD_EXIT_TIMEOUT_MS,
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
