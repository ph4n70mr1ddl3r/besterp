// Cleanup Expired Idempotency Records
//
// Removes idempotency records that have passed their expiration date.
// Run as a scheduled job (cron) to prevent unbounded table growth.
//
// Usage:
//   DATABASE_URL="..." npx tsx packages/database/scripts/cleanup-expired-idempotency.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
});

async function main() {
  const BATCH_SIZE = 5000;
  // Application-scoped advisory lock key — arbitrary constant. Two
  // concurrent runs of this script (e.g., overlapping cron triggers) will
  // serialise on this lock so they don't double-scan the same rows.
  const ADVISORY_LOCK_KEY = 0x62657374657270; // 'besterp' in ASCII hex bytes
  let lockAcquired = false;
  let totalDeleted = 0;
  let before: number;

  // Try to acquire the advisory lock. pg_try_advisory_lock returns false
  // immediately if another process already holds it — the script exits
  // cleanly rather than blocking indefinitely.
  try {
    const lockResult = await prisma.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY})
    `;
    lockAcquired = lockResult[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) {
      console.log("🧹 Another cleanup is already running — exiting without doing work.");
      return;
    }
  } catch (e) {
    console.error("❌ Could not query advisory lock — aborting:", e);
    process.exit(1);
  }

  // Capture count after lock acquisition for accurate before/after comparison
  before = await prisma.idempotencyRecord.count();

  try {
    // Delete in batches to avoid long-running transactions and lock contention
    // on large tables. Without batching, a single deleteMany with millions of
    // expired rows can hold a write lock for seconds.
    let deleted: number;
    do {
      // Find IDs to delete first, then delete by ID to avoid full-table scans
      // in the DELETE statement on databases with many non-expired rows.
      // orderBy ensures deterministic iteration so the oldest expired rows
      // are always cleaned first (helps with retention SLAs).
      const expired = await prisma.idempotencyRecord.findMany({
        where: { expiresAt: { lt: new Date() } },
        orderBy: { expiresAt: "asc" },
        select: { idempotencyKey: true },
        take: BATCH_SIZE,
      });
      if (expired.length === 0) break;

      const result = await prisma.idempotencyRecord.deleteMany({
        where: { idempotencyKey: { in: expired.map((r) => r.idempotencyKey) } },
      });
      deleted = result.count;
      totalDeleted += deleted;
    } while (deleted === BATCH_SIZE);
  } finally {
    if (lockAcquired) {
      try {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
      } catch (e) {
        console.warn("⚠️  Could not release advisory lock:", e);
      }
    }
  }

  const after = await prisma.idempotencyRecord.count();

  console.log(`🧹 Idempotency cleanup complete:`);
  console.log(`   Records before: ${before}`);
  console.log(`   Records deleted: ${totalDeleted}`);
  console.log(`   Records remaining: ${after}`);
}

main()
  .catch((e) => {
    console.error("❌ Cleanup failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
