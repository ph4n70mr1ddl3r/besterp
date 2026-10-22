// Unit tests for assertSeedAllowed (prisma/seed.ts environment guard).
// The seed inserts hard-coded test tenants (tenant-acme, tenant-globex) into
// whatever DATABASE_ADMIN_URL points at, so the guard must refuse every
// non-local environment AND require an explicit ALLOW_SEED=1 opt-in.

import { describe, it, expect } from "vitest";
import { sanitizeForLogOutput } from "@besterp/shared";
import { assertSeedAllowed } from "../seed-guard.js";

describe("assertSeedAllowed", () => {
  it("allows unset NODE_ENV with ALLOW_SEED=1 (CI seeds an ephemeral DB)", () => {
    expect(() => assertSeedAllowed(undefined, "1")).not.toThrow();
  });

  it("allows empty, development, and test environments with ALLOW_SEED=1", () => {
    expect(() => assertSeedAllowed("", "1")).not.toThrow();
    expect(() => assertSeedAllowed("development", "1")).not.toThrow();
    expect(() => assertSeedAllowed("test", "1")).not.toThrow();
  });

  it("normalizes case/whitespace before evaluating the environment", () => {
    expect(() => assertSeedAllowed(" Development ", "1")).not.toThrow();
  });

  it("refuses without an explicit ALLOW_SEED=1 even in a safe environment", () => {
    // The NODE_ENV check alone is bypassable (an operator can point
    // DATABASE_ADMIN_URL at prod while leaving NODE_ENV unset/development), so
    // there is no safe default that permits the destructive insert.
    expect(() => assertSeedAllowed("development", undefined)).toThrow(/ALLOW_SEED is not set/);
    expect(() => assertSeedAllowed("development", "")).toThrow(/ALLOW_SEED is not set/);
    expect(() => assertSeedAllowed("development", "true")).toThrow(/ALLOW_SEED is not set/);
    expect(() => assertSeedAllowed("development", "0")).toThrow(/ALLOW_SEED is not set/);
  });

  it("refuses production/staging", () => {
    expect(() => assertSeedAllowed("production", "1")).toThrow(/Refusing to seed/);
    expect(() => assertSeedAllowed("staging", "1")).toThrow(/Refusing to seed/);
  });

  it("refuses production aliases that previously bypassed the denylist", () => {
    // Regression (round 115): the old guard denylisted the literal strings
    // "production"/"staging" only, so aliases like "prod", "prd", "uat",
    // "preview", "Production" fell through to the ALLOW_SEED opt-in and seeded
    // test tenants into a real database.
    for (const alias of ["prod", "prd", "uat", "preview", "Production", " staging "]) {
      expect(() => assertSeedAllowed(alias, "1"), `NODE_ENV=${alias}`).toThrow(/Refusing to seed/);
    }
  });

  it("reports the exact offending NODE_ENV value", () => {
    expect(() => assertSeedAllowed("production", "1")).toThrow('the environment is set to "production"');
  });

  it("keeps the refusal message readable after log sanitization", () => {
    // The seed prints every error through `sanitizeForLogOutput`, because a
    // Prisma connection error embeds the datasource URL (credentials and all)
    // verbatim. The old wording — "Refusing to seed in NODE_ENV=production" —
    // was 20 characters of `[A-Za-z0-9_./=+-]`, so the generic long-token
    // rule replaced it with "[REDACTED_TOKEN]" and the operator was left
    // with "Refusing to seed in [REDACTED_TOKEN]" — neither the rejected
    // environment nor the remediation survived.
    let message = "";
    try {
      assertSeedAllowed("production", "1");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const sanitized = sanitizeForLogOutput(message);
    expect(sanitized).not.toContain("[REDACTED_TOKEN]");
    expect(sanitized).toContain("production");
    expect(sanitized).toContain("ALLOW_SEED");
  });
});
