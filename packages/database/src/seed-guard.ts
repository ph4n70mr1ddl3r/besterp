// Environment guard for the Prisma seed script.
//
// Extracted from prisma/seed.ts so the allowlist logic is unit-testable (the
// seed script self-executes on import and cannot be imported by tests). The
// seed inserts hard-coded test tenants (tenant-acme, tenant-globex) into
// whatever database DATABASE_ADMIN_URL points at, so both the environment and
// the ALLOW_SEED opt-in must be validated before any insert runs.

import { normalizeEnvironmentValue } from "@besterp/shared";

/**
 * Throw unless the caller has (a) selected a safe local/dev/test environment
 * AND (b) explicitly opted in via ALLOW_SEED=1.
 *
 * The environment check uses an ALLOWLIST of safe values (unset, empty,
 * "development", "test") rather than denylisting "production"/"staging": a
 * denylist was previously bypassed by common production aliases
 * (`NODE_ENV=prod`, `prd`, `uat`, `preview`, …), which fell through to the
 * ALLOW_SEED=1 opt-in and seeded test tenants into a real database.
 *
 * The NODE_ENV check alone is still bypassable — an operator pointing
 * DATABASE_ADMIN_URL at a production database while leaving NODE_ENV unset or
 * "development" (a common container-env reuse mistake) would seed test tenants
 * into prod — so seeding additionally requires the explicit ALLOW_SEED=1
 * signal. There is no safe default that permits the destructive insert.
 */
export function assertSeedAllowed(rawNodeEnv: string | undefined, allowSeed: string | undefined): void {
  const env = normalizeEnvironmentValue(rawNodeEnv);
  const isSafeSeedEnv = env === undefined || env === "" || env === "development" || env === "test";
  if (!isSafeSeedEnv) {
    // The message is printed through `sanitizeForLogOutput` (the seed
    // scrubs every error it prints, because a Prisma connection error embeds
    // the datasource URL — credentials and all — verbatim).
    //
    // The previous wording — "Refusing to seed in NODE_ENV=production" —
    // was destroyed by that sanitizer: "NODE_ENV=production" is exactly 20
    // characters of `[A-Za-z0-9_./=+-]`, so the generic long-token rule
    // matched it and replaced it with "[REDACTED_TOKEN]" — the rejected
    // environment AND the remediation both disappeared, and the operator
    // was left with "Refusing to seed in [REDACTED_TOKEN]". The wording
    // below keeps every run under the 20-character threshold and avoids the
    // `name=value` shape entirely, so the message survives sanitization.
    throw new Error(
      'Refusing to seed: the environment is set to "' + (rawNodeEnv ?? "") + '". ' +
      "Seed is for local/dev/test databases only — set NODE_ENV to development, " +
      "or unset it, together with ALLOW_SEED=1, to run the seed."
    );
  }
  if (!allowSeed || allowSeed !== "1") {
    throw new Error(
      "Refusing to seed: ALLOW_SEED is not set to '1'. " +
      "Seeding inserts hard-coded test tenants and must be explicitly enabled. " +
      "Run with ALLOW_SEED=1 to seed local/dev databases only."
    );
  }
}
