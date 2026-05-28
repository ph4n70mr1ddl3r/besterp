// Shared tenant context utilities for Row-Level Security (RLS)
//
// IMPORTANT: RLS only works with a non-superuser role.
// SET LOCAL only persists within the current transaction.
// The validated pattern wraps SET LOCAL + query in the same $transaction.
//
// SECURITY: Uses the set_tenant_context() PostgreSQL function (defined in
// rls-setup.sql) called via Prisma's tagged template $executeRaw, which
// sends the tenant ID as a parameterized query ($1). This eliminates the
// SQL injection surface area of string interpolation. validateTenantId()
// is retained as defense-in-depth.

import type { PrismaClient, Prisma } from "@prisma/client";

/** Prisma's interactive transaction client with all model delegates. */
type PrismaTransactionClient = Prisma.TransactionClient;

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a tenant ID to prevent SQL injection.
 *
 * Defense-in-depth: the actual SQL call uses parameterized queries via
 * set_tenant_context(), but we validate the format upfront to catch
 * obviously invalid tenant IDs early with a clear error message.
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
 * Calls the `set_tenant_context()` PostgreSQL function (defined in
 * packages/database/prisma/rls-setup.sql) via Prisma's $executeRaw
 * tagged template, which uses parameterized queries — safe from SQL
 * injection without relying solely on regex validation.
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
  if (!prisma || typeof prisma.$transaction !== "function") {
    throw new Error(
      "withTenant: Invalid PrismaClient. Provide a connected PrismaClient instance."
    );
  }
  validateTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    // Parameterized query via tagged template — tenant ID is sent as $1,
    // not interpolated into the SQL string. No string-concat injection risk.
    await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
    return fn(tx);
  });
}
