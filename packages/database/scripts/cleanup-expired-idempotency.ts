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
  const before = await prisma.idempotencyRecord.count();
  const result = await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  const after = await prisma.idempotencyRecord.count();

  console.log(`🧹 Idempotency cleanup complete:`);
  console.log(`   Records before: ${before}`);
  console.log(`   Records deleted: ${result.count}`);
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
