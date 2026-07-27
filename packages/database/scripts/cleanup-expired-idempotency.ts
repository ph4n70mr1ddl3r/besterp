// Cleanup Expired Idempotency Records
//
// Removes idempotency records that have passed their expiration date.
// Run as a scheduled job (cron) to prevent unbounded table growth.
//
// Usage:
//   DATABASE_ADMIN_URL="..." npx tsx packages/database/scripts/cleanup-expired-idempotency.ts

import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_ADMIN_URL) {
    console.error("DATABASE_ADMIN_URL is required for idempotency cleanup (bypasses RLS). " +
    "The app role cannot see expired records due to tenant-scoped RLS policies."
  );
  process.exit(1);
}

// Normalize NODE_ENV early (case-insensitive) so "Production"/"PRODUCTION"
// cannot bypass the guard below. This script runs as a standalone process
// that does NOT go through main.ts's normalizeEnvironment().
if (process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.NODE_ENV.toLowerCase();
}

// Destructive admin operation that bypasses RLS. Refuse to run against
// production unless explicitly opted in via ALLOW_CLEANUP_PRODUCTION=1 — a
// cron misconfiguration pointing DATABASE_ADMIN_URL at prod must not wipe
// expired idempotency records unattended.
if (process.env.NODE_ENV === "production" && process.env.ALLOW_CLEANUP_PRODUCTION !== "1") {
  console.error(
    "Refusing to run idempotency cleanup in production without opt-in. " +
    "Set ALLOW_CLEANUP_PRODUCTION=1 to run against a production database."
  );
  process.exit(1);
}

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_ADMIN_URL,
});

// Interactive-transaction timeout (ms). Prisma's default is 5000ms, so any
// non-trivial cleanup (a few thousand expired rows, or a single transaction
// that holds the advisory lock past 5s) times out, the whole transaction
// ROLLS BACK (deleting nothing), and the script exits non-zero having cleaned
// 0 rows — silently defeating its only purpose while the table grows unbounded.
// Raise the default well above the expected runtime and allow tuning via env.
const TX_TIMEOUT_MS = (() => {
  const raw = process.env.CLEANUP_TX_TIMEOUT_MS;
  if (raw === undefined) return 600_000;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(`Invalid CLEANUP_TX_TIMEOUT_MS: "${raw}" — must be a positive number.`);
    process.exit(1);
  }
  return parsed;
})();

// Idempotency records use a COMPOSITE primary key (idempotencyKey, tenantId)
// — there is no surrogate `id` column. Deletion must therefore target the
// composite key. We select the (idempotencyKey, tenantId) pair for each
// expired row and delete by that compound selector. (The previous revision
// selected/deleted by a non-existent `id` column, which would throw
// "Unknown field 'id'" at runtime and clean nothing.) Batching bounds
// transaction size and lock contention on large tables.
const BATCH_SIZE = 5000;

async function main() {
  // Application-scoped advisory lock key — arbitrary constant. Two
  // concurrent runs of this script (e.g., overlapping cron triggers) will
  // serialise on this lock so they don't double-scan the same rows.
  const ADVISORY_LOCK_KEY = 0x62657374657270; // 'besterp' in ASCII hex bytes
  let totalDeleted = 0;
  let before = 0;
  let after = 0;

  // Run the entire cleanup — advisory lock acquisition, scan, and
  // batched deletes — inside a single interactive transaction so every
  // statement executes on the SAME backend connection. pg_advisory_lock is
  // *session* scoped: under Prisma's default connection pool the lock and
  // the subsequent findMany/deleteMany could otherwise land on different
  // pooled connections, voiding the serialisation guarantee. Bounding the
  // work to one transaction keeps the lock effective and lets the server
  // release it automatically on commit/rollback (an explicit
  // pg_advisory_unlock is still issued for clarity/early release).
  const result = await prisma.$transaction(
    async (tx) => {
    const lockResult = await tx.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY})
    `;
    const lockAcquired = lockResult[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) {
      return { skipped: true as const, deleted: 0, before: 0, after: 0 };
    }

    // Capture count after lock acquisition for accurate before/after comparison.
    const beforeCount = await tx.idempotencyRecord.count();

    let deleted = 0;
    // Capture a single cutoff ONCE so every batch deletes the same point-in-
    // time snapshot. Re-evaluating `expiresAt < now()` per batch would also
    // delete `pending` records whose in-flight request is still executing
    // (the request created the record with `expiresAt = now + TTL`, but a
    // slow/retried call or clock skew can leave a just-created pending row
    // already "expired" by a later batch's fresh timestamp) — silently
    // breaking idempotency (a retried client then re-executes the side
    // effect). Exclude `pending` explicitly so only terminal (completed/
    // failed) records are reaped; a stale pending row is recovered by the
    // runtime STALE_PENDING_THRESHOLD_MS reset, not by this job.
    const cutoff = new Date();
    let batchDeleted: number;
    // Declared OUTSIDE the do block so the while condition can reference it.
    let expired: Array<{ idempotencyKey: string; tenantId: string }>;
    do {
      // orderBy ensures deterministic iteration so the oldest expired rows
      // are always cleaned first (helps with retention SLAs).
      expired = await tx.idempotencyRecord.findMany({
        where: { expiresAt: { lt: cutoff }, status: { not: "pending" } },
        orderBy: { expiresAt: "asc" },
        select: { idempotencyKey: true, tenantId: true },
        take: BATCH_SIZE,
      });
      if (expired.length === 0) break;

      const del = await tx.idempotencyRecord.deleteMany({
        where: {
          OR: expired.map((r) => ({
            idempotencyKey_tenantId: { idempotencyKey: r.idempotencyKey, tenantId: r.tenantId },
          })),
        },
      });
      batchDeleted = del.count;
      deleted += batchDeleted;
    } while (expired.length === BATCH_SIZE);

    const afterCount = await tx.idempotencyRecord.count();
    try {
      await tx.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    } catch (e) {
      console.warn("Could not release advisory lock:", e);
    }

    return { skipped: false as const, deleted, before: beforeCount, after: afterCount };
  },
  { timeout: TX_TIMEOUT_MS },
);

  if (result.skipped) {
    console.log("Another cleanup is already running — exiting without doing work.");
    return;
  }

  totalDeleted = result.deleted;
  before = result.before;
  after = result.after;

  console.log("Idempotency cleanup complete:");
  console.log(`   Records before: ${before}`);
  console.log(`   Records deleted: ${totalDeleted}`);
  console.log(`   Records remaining: ${after}`);
}

main()
  .catch((e) => {
    console.error("Cleanup failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
