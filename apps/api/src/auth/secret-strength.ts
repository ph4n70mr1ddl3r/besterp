// JWT secret strength heuristics.
//
// Used by main.ts at startup to warn when JWT_SECRET looks like a default,
// test, or zero-entropy value. Kept in a standalone module so the heuristics
// can be unit-tested without invoking the bootstrap (which calls process.exit).

/**
 * Minimum acceptable length for JWT_SECRET, in characters.
 * Exported so main.ts and tests reference a single source of truth.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Known default / test / placeholder secret literals (case-insensitive exact
 * match). These are values an operator might copy from a tutorial or leave
 * from initial scaffolding.
 */
const DEFAULT_SECRET_LITERALS: readonly RegExp[] = [
  /^secret$/i,
  /^changeme$/i,
  /^test$/i,
  /^dev$/i,
  /^development$/i,
];

/**
 * Zero-entropy secret: a single character repeated for the entire length.
 *
 * Covers "000...0" (all zeros), "ffff...f" (all hex f), "    ... " (spaces),
 * etc. — anything an operator might pad out to pass a length check without
 * adding any actual entropy.
 *
 * NOTE: a previous implementation used `/^(0{32}|[a-f]{32})$/i`, intending to
 * flag "all-same-case hex". That regex actually matched ANY 32-character
 * string composed solely of a–f letters (e.g. "abcdefabcdefabcdef..."), which
 * has full entropy (~82 bits) — a false positive that warned operators about
 * legitimate random hex secrets. Matching a single repeated character is the
 * correct expression of "no entropy" and avoids the false positive.
 *
 * The `{31,}` quantifier (1 lead char + 31+ repeats) ensures this only fires
 * for secrets that meet MIN_JWT_SECRET_LENGTH, which the caller also enforces.
 */
const ZERO_ENTROPY_SECRET = /^(.)\1{31,}$/;

/**
 * Returns true if `secret` matches a known default/test value OR is a single
 * character repeated throughout (zero entropy). Such secrets must never be
 * used outside local development.
 *
 * This is a WARNING-grade heuristic, not a hard rejection — the caller logs a
 * warning but continues to start. The hard gate is the minimum-length check in
 * main.ts (which exits the process).
 *
 * @param secret - The candidate JWT secret string.
 */
export function isWeakSecret(secret: string): boolean {
  if (typeof secret !== "string" || secret.length === 0) return true;
  if (DEFAULT_SECRET_LITERALS.some((p) => p.test(secret))) return true;
  if (ZERO_ENTROPY_SECRET.test(secret)) return true;
  return false;
}
