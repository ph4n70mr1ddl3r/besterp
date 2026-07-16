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
import { isDomainError, TenantContextFailedError, InvalidTenantIdError } from "./errors.js";
import { MAX_TENANT_ID_LENGTH } from "./constants.js";
import { sanitizeLogMessage } from "./sanitize.js";

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
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new InvalidTenantIdError(
      "Tenant ID must be a non-empty string."
    );
  }
  if (tenantId.length > MAX_TENANT_ID_LENGTH) {
    throw new InvalidTenantIdError(
      `Tenant ID is too long (max ${MAX_TENANT_ID_LENGTH} characters).`
    );
  }
   if (!TENANT_ID_PATTERN.test(tenantId)) {
    // Sanitize: show only first 20 chars to prevent log injection and
    // information disclosure from untrusted input. The tenant ID is
    // attacker-influenced at the auth boundary, so strip control characters
    // and ANSI escapes from the preview before interpolating it into the
    // error message — otherwise CR/LF or terminal-escape payloads reach
    // operator logs verbatim (the same log-injection class sanitized
    // everywhere else).
    const rawPreview = tenantId.length > 20 ? `${tenantId.slice(0, 20)}...` : tenantId;
    const preview = sanitizeLogMessage(rawPreview);
    throw new InvalidTenantIdError(
      `Invalid tenant ID: "${preview}". ` +
        "Tenant IDs may only contain alphanumeric characters, hyphens, and underscores."
    );
  }
}

/**
 * Set the tenant context on a Prisma transaction client via the
 * `set_tenant_context()` PostgreSQL function.
 *
 * Used by both `withTenant` and the RLS extension to avoid duplicating the
 * parameterized call + error handling. Preserves DomainError as-is (e.g.,
 * INVALID_TENANT_ID) and wraps non-DomainError failures with
 * TENANT_CONTEXT_FAILED.
 *
 * @param tx       - Prisma transaction client
 * @param tenantId - validated tenant ID
 */
export async function setTenantContext(
  tx: { $executeRaw: PrismaClient["$executeRaw"] },
  tenantId: string,
): Promise<void> {
  try {
    await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
  } catch (e) {
    if (isDomainError(e)) throw e;
    throw new TenantContextFailedError(
      "Failed to set tenant context. Ensure the set_tenant_context() function exists and the database role has correct permissions.",
      { cause: e instanceof Error ? e : new Error(String(e)) }
    );
  }
}

/** Default transaction timeout in milliseconds (30 seconds). */
const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;

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
 * @param options  - Optional transaction configuration
 * @returns The return value of fn
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }
): Promise<T> {
  if (!prisma || typeof prisma.$transaction !== "function") {
    throw new Error(
      "withTenant: Invalid PrismaClient. Provide a connected PrismaClient instance."
    );
  }
  if (typeof fn !== "function") {
    throw new Error(
      "withTenant: 'fn' must be a function receiving the transaction client."
    );
  }
  validateTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await setTenantContext(tx, tenantId);
    return fn(tx);
  }, {
    timeout: options?.timeout ?? DEFAULT_TRANSACTION_TIMEOUT_MS,
    ...(options?.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
  });
}
