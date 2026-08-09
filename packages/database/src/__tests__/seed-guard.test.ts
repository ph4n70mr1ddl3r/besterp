// Unit tests for assertSeedAllowed (prisma/seed.ts environment guard).
// The seed inserts hard-coded test tenants (tenant-acme, tenant-globex) into
// whatever DATABASE_ADMIN_URL points at, so the guard must refuse every
// non-local environment AND require an explicit ALLOW_SEED=1 opt-in.

import { describe, it, expect } from "vitest";
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
    expect(() => assertSeedAllowed("production", "1")).toThrow(/Refusing to seed in NODE_ENV=production/);
    expect(() => assertSeedAllowed("staging", "1")).toThrow(/Refusing to seed in NODE_ENV=staging/);
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
    expect(() => assertSeedAllowed("production", "1")).toThrow("Refusing to seed in NODE_ENV=production");
  });
});
