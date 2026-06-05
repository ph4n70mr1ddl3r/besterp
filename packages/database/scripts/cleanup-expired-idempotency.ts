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
  let totalDeleted = 0;
  let before = await prisma.idempotencyRecord.count();

  // Delete in batches to avoid long-running transactions and lock contention
  // on large tables. Without batching, a single deleteMany with millions of
  // expired rows can hold a write lock for seconds.
  let deleted: number;
  do {
    // Find IDs to delete first, then delete by ID to avoid full-table scans
    // in the DELETE statement on databases with many non-expired rows.
    const expired = await prisma.idempotencyRecord.findMany({
      where: { expiresAt: { lt: new Date() } },
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
