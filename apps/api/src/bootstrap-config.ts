// Bootstrap configuration resolvers — pure, side-effect-free helpers for
// reading and validating boot-time environment knobs.
//
// Isolated from main.ts so the resolution logic can be unit-tested without
// executing bootstrap(). main.ts owns the process-facing consequences
// (logging, process.exit, or falling back to a default).

import type { Logger } from "@nestjs/common";

// Re-export normalizeEnvironmentValue from @besterp/shared so existing
// @besterp/api import sites (main.ts, health.service.ts) continue to work
// without changing their import paths. The canonical definition lives in
// @besterp/shared; this barrel-style re-export preserves backwards compat
// for any future internal consumers that import from bootstrap-config.
export { normalizeEnvironmentValue } from "@besterp/shared";

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_PER_WINDOW = 300;
export const DEFAULT_HARD_EXIT_TIMEOUT_MS = 10_000;
export const DEFAULT_TRUST_PROXY_HOPS = 0;
export const MAX_TRUST_PROXY_HOPS = 10;

function parsePositiveInteger(name: string, raw: string | undefined, fallback: number): number {
  // An unset or empty value means "use the default". Any value that is set but
  // not a positive integer is an operator misconfiguration — fail loudly
  // rather than silently disabling the control (e.g. RATE_LIMIT_MAX_PER_WINDOW
  // feeding NaN into the rate limiter would silently stop rate limiting).
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} "${raw}". Must be a positive integer.`);
  }
  return value;
}

export function resolveRateLimitConfig(env: NodeJS.ProcessEnv): RateLimitConfig {
  return {
    windowMs: parsePositiveInteger("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveInteger("RATE_LIMIT_MAX_PER_WINDOW", env.RATE_LIMIT_MAX_PER_WINDOW, DEFAULT_RATE_LIMIT_MAX_PER_WINDOW),
  };
}

/**
 * Resolve the hard-exit timer for graceful shutdown.
 *
 * Returns the configured value when it is a valid non-negative number of
 * milliseconds (0 means "force exit immediately", a legitimate failover
 * choice). Throws on an unparseable or negative value so main.ts can warn and
 * fall back to the default — a negative value would otherwise silently turn
 * graceful shutdown into an immediate forced exit (Node clamps negative
 * `setTimeout` delays to 1 ms).
 */
export function resolveHardExitTimeoutMs(env: NodeJS.ProcessEnv): number {
  // Trim FIRST so a whitespace-only value is treated as "unset" (default)
  // rather than parsed as an explicit `0`. `Number("  ")` is 0, and a 0ms
  // hard-exit timer fires an immediate `process.exit(1)` on the first
  // shutdown — silently destroying graceful shutdown (in-flight requests
  // killed). This is the same damage class as the negative-value guard below,
  // and mirrors the whitespace-as-unset convention applied to PRISMA cache
  // sizes in round 106 (`Number("   ")` === 0 must not be mistaken for an
  // explicit value).
  const raw = env.HARD_EXIT_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_HARD_EXIT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid HARD_EXIT_TIMEOUT_MS "${raw}". Must be a non-negative number of milliseconds — defaulting to ${DEFAULT_HARD_EXIT_TIMEOUT_MS}ms.`
    );
  }
  return value;
}

/**
 * Read and clamp a cache-size env var to a valid range [1, 100_000].
 *
 * Treats unset/empty/whitespace-only values as "use the default". `Number("   ")`
 * is 0, so the raw value is trimmed first to avoid mistaking whitespace-only
 * input for an explicit `0`. An explicit `0` is clamped to 1 (caches must stay
 * functional); an unparseable value emits a warning and falls back to the
 * default. Exported so PrismaService can delegate to it rather than duplicating
 * the guard logic.
 */
export function normalizeCacheSize(
  raw: string | undefined,
  defaultSize: number,
  varName: string,
  logger: Logger,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return defaultSize;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) {
    logger.warn(`${varName}="${raw}" is not a valid number — using default ${defaultSize}.`);
    return defaultSize;
  }
  if (parsed === 0) {
    logger.warn(`${varName}=0 is not allowed — clamping to minimum of 1.`);
  }
  return Math.min(100_000, Math.max(1, parsed));
}

/**
 * Resolve the number of trusted reverse-proxy hops (`app.set("trust proxy", N)`).
 *
 * Returns 0 (the Express default) when unset, which keeps the current
 * fail-closed behavior: client IPs resolve to the socket peer address and
 * cannot be spoofed via `X-Forwarded-For`. When an operator opts in with
 * TRUST_PROXY_HOPS > 0, the value must match the real proxy topology — every
 * proxy in front must overwrite inbound `X-Forwarded-For` headers, otherwise a
 * directly-connected client can forge the header and bypass IP-based rate
 * limiting. Throws on an unparseable/out-of-range value so a typo fails fast at
 * boot rather than silently keying the rate limiter on the proxy IP (which also
 * makes express-rate-limit log ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
 * proxied request).
 */
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv): number {
  // Trim FIRST so whitespace-only is treated as unset (→ the fail-closed 0
  // default), mirroring resolveHardExitTimeoutMs. `Number("  ")` is 0 so the
  // result is identical to today, but the intent is explicit and the value
  // cannot be confused with an operator-typed `0`.
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TRUST_PROXY_HOPS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_TRUST_PROXY_HOPS) {
    throw new Error(
      `Invalid TRUST_PROXY_HOPS "${raw}". Must be an integer between 0 and ${MAX_TRUST_PROXY_HOPS} ` +
      "representing the number of reverse-proxy hops in front of this app (0 disables proxy IP resolution)."
    );
  }
  return value;
}
