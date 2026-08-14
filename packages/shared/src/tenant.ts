// Shared tenant context utilities for Row-Level Security (RLS)
//
// IMPORTANT: RLS only works with a non-superuser role.
// SET LOCAL only persists within the current transaction.
// The validated pattern wraps SET LOCAL + query in the same $transaction.
//
// SECURITY: Uses the set_tenant_context() PostgreSQL function (defined in
// rls-setup.sql) via setTenantContext()'s $executeRawUnsafe with positional
// $1 binding. This eliminates the SQL injection surface area of string
// interpolation. validateTenantId() is retained as defense-in-depth.

import type { PrismaClient, Prisma } from "@prisma/client";
import { isDomainError, TenantContextFailedError, InvalidTenantIdError, InvalidTypeValueError } from "./errors.js";
import { MAX_TENANT_ID_LENGTH } from "./constants.js";
import { sanitizeLogMessage } from "./sanitize.js";

/** Prisma's interactive transaction client with all model delegates. */
type TxClient = Prisma.TransactionClient;

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Exported for reuse by auth boundaries that validate identity fields. */
export { TENANT_ID_PATTERN };

/**
 * Validates a tenant ID to prevent SQL injection and normalises it (trim).
 *
 * Defense-in-depth: the actual SQL call uses parameterized queries via
 * set_tenant_context(), but we validate the format upfront to catch
 * obviously invalid tenant IDs early with a clear error message.
 *
 * The function TRIMS the tenant ID before validating and RETURNS the trimmed
 * value so callers (withTenant, setTenantContext) operate on the same string
 * the validator accepted. Without this, a whitespace-padded tenant ID
 * (`"tenant-acme "`) would pass validation but then be set verbatim via
 * `set_tenant_context('tenant-acme '::text)`, producing an RLS context that
 * matches no stored `tenant_id` — an isolation bypass / data-invisibility
 * gap. The auth boundary's `validateTenantIdEnhancedForAuth` already trims;
 * this makes the RLS call path consistent with it.
 */
export function validateTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new InvalidTenantIdError(
      "Tenant ID must be a non-empty string."
    );
  }
  const trimmed = tenantId.trim();
  if (trimmed.length === 0) {
    throw new InvalidTenantIdError(
      "Tenant ID must not consist solely of whitespace."
    );
  }
  if (trimmed.length > MAX_TENANT_ID_LENGTH) {
    throw new InvalidTenantIdError(
      `Tenant ID is too long (max ${MAX_TENANT_ID_LENGTH} characters).`
    );
  }
  if (!TENANT_ID_PATTERN.test(trimmed)) {
    // Sanitize: show only first 20 chars to prevent log injection and
    // information disclosure from untrusted input. The tenant ID is
    // attacker-influenced at the auth boundary, so strip control characters
    // and ANSI escapes from the preview before interpolating it into the
    // error message — otherwise CR/LF or terminal-escape payloads reach
    // operator logs verbatim (the same log-injection class sanitized
    // everywhere else).
    const rawPreview = trimmed.length > 20 ? `${trimmed.slice(0, 20)}...` : trimmed;
    const preview = sanitizeLogMessage(rawPreview);
    throw new InvalidTenantIdError(
      `Invalid tenant ID: "${preview}". ` +
        "Tenant IDs may only contain alphanumeric characters, hyphens, and underscores."
    );
  }
  return trimmed;
}

/**
 * Validate that a tenant ID matches the expected format at the auth boundary.
 * Returns the trimmed tenant ID or throws InvalidTenantIdError.
 * Delegates to {@link validateTenantId} for shared logic.
 */
export function validateTenantIdEnhancedForAuth(tenantId: string): string {
  return validateTenantId(tenantId);
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
  tx: { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown> },
  tenantId: string,
): Promise<void> {
  // Always re-validate (and trim) here so every RLS-context call site — direct
  // withTenant callers AND the rls-extension proxy — operates on the exact
  // normalized tenant ID the validator accepts. A raw, untrimmed value reaching
  // set_tenant_context() would set an RLS context that matches no stored
  // tenant_id (isolation bypass / data invisibility).
  const normalizedTenantId = validateTenantId(tenantId);
  try {
    // Prisma's $executeRawUnsafe with array params parameterizes the value via
    // $1 binding, preventing SQL injection. The regex validation in
    // validateTenantId() is retained as defense-in-depth for early failure.
    await tx.$executeRawUnsafe("SELECT set_tenant_context($1::text)", normalizedTenantId);
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
 * packages/database/prisma/rls-setup.sql) via `setTenantContext()`, which
 * uses `$executeRawUnsafe` with positional `$1` parameter binding —
 * parameterized and safe from SQL injection without relying solely on
 * regex validation. See the accurate inline notes in setTenantContext.
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
  fn: (tx: TxClient) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }
): Promise<T> {
  if (!prisma || typeof prisma.$transaction !== "function") {
    throw new InvalidTypeValueError(
      "withTenant: Invalid PrismaClient. Provide a connected PrismaClient instance."
    );
  }
  if (typeof fn !== "function") {
    throw new InvalidTypeValueError(
      "withTenant: 'fn' must be a function receiving the transaction client."
    );
  }
  const normalizedTenantId = validateTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await setTenantContext(tx, normalizedTenantId);
    return fn(tx);
  }, {
    timeout: options?.timeout ?? DEFAULT_TRANSACTION_TIMEOUT_MS,
    ...(options?.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
  });
}
