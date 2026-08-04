// Bootstrap configuration resolvers — pure, side-effect-free helpers for
// reading and validating boot-time environment knobs.
//
// Isolated from main.ts so the resolution logic can be unit-tested without
// executing bootstrap(). main.ts owns the process-facing consequences
// (logging, process.exit, or falling back to a default).

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_PER_WINDOW = 300;
export const DEFAULT_HARD_EXIT_TIMEOUT_MS = 10_000;

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
  const raw = env.HARD_EXIT_TIMEOUT_MS;
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
 * Normalize NODE_ENV: trim surrounding whitespace and lowercase.
 *
 * Trimming matters because `" production "` (whitespace-padded) would bypass
 * every `process.env.NODE_ENV === "production"` guard in main.ts, QueueModule,
 * and HealthService — exactly the class of silent config drift the existing
 * lowercase normalization was added to prevent.
 */
export function normalizeEnvironmentValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase();
}
