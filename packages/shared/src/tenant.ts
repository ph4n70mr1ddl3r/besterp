// Shared tenant context utilities for Row-Level Security (RLS)
//
// IMPORTANT: RLS only works with a non-superuser role.
// SET LOCAL only persists within the current transaction.
// The validated pattern wraps SET LOCAL + query in the same $transaction.

import type { PrismaClient, Prisma } from "@prisma/client";

/** Prisma's interactive transaction client with all model delegates. */
type PrismaTransactionClient = Prisma.TransactionClient;

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a tenant ID to prevent SQL injection.
 *
 * SET LOCAL doesn't support parameterized queries via Prisma tagged templates,
 * so we validate the tenant ID format before interpolation.
 */
export function validateTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      `Invalid tenant ID: "${tenantId}". ` +
        `Tenant IDs must match ${TENANT_ID_PATTERN.source}.`
    );
  }
}

/**
 * Execute a function within a tenant-scoped database transaction.
 *
 * Sets `app.current_tenant` via SET LOCAL so that PostgreSQL RLS policies
 * filter rows to only those belonging to the specified tenant.
 *
 * The callback receives a fully-typed Prisma transaction client, so
 * `tx.party.findMany()`, etc. all resolve correctly.
 *
 * Usage:
 * ```ts
 * const parties = await withTenant(prisma, "tenant-acme", async (tx) => {
 *   return tx.party.findMany();  // tx is fully typed
 * });
 * ```
 *
 * @param prisma   - PrismaClient instance (must use non-superuser role for RLS)
 * @param tenantId - The tenant ID to scope queries to
 * @param fn       - Async function receiving the typed transaction client
 * @returns The return value of fn
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: PrismaTransactionClient) => Promise<T>
): Promise<T> {
  validateTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    // $executeRawUnsafe exists at runtime but isn't in the
    // TransactionClient type definition — cast is necessary.
    await (tx as any).$executeRawUnsafe(
      `SET LOCAL app.current_tenant = '${tenantId}'`
    );
    return fn(tx);
  });
}
