// Prisma Client Extension for automatic Row-Level Security (RLS) tenant scoping.
//
// Provides `createTenantClient()` which wraps all model operations in a
// transaction that calls `set_tenant_context()` before executing each query.
// This ensures every database operation is scoped to a specific tenant at the
// database level — defense-in-depth beyond application-level WHERE filters.
//
// IMPORTANT: RLS only works with a non-superuser database role.
// The PrismaClient passed here MUST connect as besterp_app (not besterp).
//
// TRANSACTION HANDLING:
// - `$transaction(fn)` calls are intercepted to inject `SET LOCAL` at the
//   start of the callback. The transaction client (`tx`) receives the tenant
//   context automatically — callers don't need to do anything special.
// - Individual model operations outside `$transaction` (e.g., `db.party.findMany()`)
//   are wrapped in their own transaction with `SET LOCAL`.
// - Batch `$transaction([...promises])` calls pass through without tenant
//   context. Use interactive transactions for tenant-scoped batch operations.

import { PrismaClient } from "@prisma/client";
import { validateTenantId, InvalidTypeValueError } from "@besterp/shared";

// ─── Validation ───────────────────────────────────────────────────

// ─── Enhanced Validation Functions ────────────────────────────────

/**
 * Enhanced tenant ID validation with additional security checks.
 * Extends the basic validation with more comprehensive security checks.
 */
export function validateTenantIdEnhanced(tenantId: string): void {
  // Base validation enforces /^[a-zA-Z0-9_-]+$/ which rejects
  // all special characters (semicolons, quotes, comment delimiters, etc.).
  try {
    validateTenantId(tenantId);
  } catch (e) {
    // Re-throw as a structured DomainError so callers only need to
    // catch InvalidTypeValueError instead of plain Error.
    throw new InvalidTypeValueError(
      (e as Error).message,
      { context: { field: "tenantId", received: tenantId } }
    );
  }

  if (tenantId.length > 100) {
    throw new InvalidTypeValueError(
      "Tenant ID is too long (max 100 characters)",
      { context: { field: "tenantId", received: tenantId, maxLength: 100 } }
    );
  }
}

/**
 * Validate that a Prisma client has the required methods for RLS.
 */
export function validatePrismaClientForRls(prisma: PrismaClient): void {
  if (!prisma || typeof prisma.$executeRaw !== "function") {
    throw new InvalidTypeValueError(
      "Prisma client does not support RLS operations. Make sure it's connected with the correct role.",
      { context: { provided: typeof prisma } }
    );
  }
}

// ─── Data-access methods to wrap with tenant context ──────────────

const DATA_METHODS = new Set([
  "findMany", "findUnique", "findFirst", "create", "update",
  "delete", "upsert", "count", "aggregate", "groupBy",
  "findUniqueOrThrow", "findFirstOrThrow", "updateMany", "deleteMany",
  "createMany", "createManyAndReturn",
]);

/** Operations that should never be called on a tenant-scoped proxy. */
const BLOCKED_LIFECYCLE = new Set(["$connect", "$disconnect", "$extends", "$on", "$use"]);

/** Raw SQL operations that bypass RLS scoping. */
const BLOCKED_RAW_SQL = new Set([
  "$queryRaw", "$queryRawTyped", "$executeRaw", "$executeRawTyped",
]);

/**
 * Create a tenant-scoped Prisma client.
 *
 * Returns a Proxy over the PrismaClient where every model operation
 * (`findMany`, `create`, etc.) is wrapped in a transaction that calls
 * `set_tenant_context()` first. This enforces RLS at the database level.
 *
 * **`$transaction` support:**
 * Interactive transactions (`$transaction(fn)`) are intercepted to inject
 * `SET LOCAL` at the start of the callback. The transaction client (`tx`)
 * inherits the tenant context for all its queries.
 *
 * Usage:
 * ```ts
 * const prisma = new PrismaClient();  // must use non-superuser role
 * const scoped = createTenantClient(prisma, "tenant-acme");
 *
 * // Standalone queries — automatically wrapped with RLS
 * await scoped.party.findMany();
 *
 * // Interactive transactions — SET LOCAL injected automatically
 * await scoped.$transaction(async (tx) => {
 *   await tx.party.create({ data: { ... } });
 *   await tx.partyRole.create({ data: { ... } });
 * });
 * ```
 *
 * @param prisma   - Base PrismaClient (must connect as non-superuser for RLS)
 * @param tenantId - The tenant ID to scope all queries to
 * @returns A Proxy-wrapped PrismaClient with automatic RLS scoping
 */
export function createTenantClient(prisma: PrismaClient, tenantId: string) {
  // Use enhanced validation with security checks
  validateTenantIdEnhanced(tenantId);
  
  // Validate that the Prisma client supports RLS operations
  validatePrismaClientForRls(prisma);

  return new Proxy(prisma, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return (target as any)[prop];

      // ─── Intercept $transaction to inject SET LOCAL ────────────
      // This is the critical fix: previously, $transaction passed through
      // to the raw client, so SET LOCAL was never called inside callbacks.
      // Now, interactive transactions get SET LOCAL injected at the start,
      // and the transaction client (tx) inherits the tenant context.
      if (prop === "$transaction") {
        return (...args: unknown[]) => {
          const [first, second] = args;

          // Interactive transaction: $transaction(fn) or $transaction(fn, options)
          if (typeof first === "function") {
            const options = (typeof second === "object" && second !== null) ? second : undefined;
            const wrappedFn = async (tx: any) => {
              await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
              return first(tx);
            };
            return options
              ? (target as any).$transaction(wrappedFn, options)
              : (target as any).$transaction(wrappedFn);
          }

          // Batch transaction: $transaction([...promises])
          // These pass through without tenant context. Use interactive
          // transactions for tenant-scoped batch operations.
          if (Array.isArray(first)) {
            return (target as any).$transaction(first);
          }

          // Fallback — unknown overload, pass through
          return (target as any).$transaction(...args);
        };
      }

      // Block operations that should never be called on a tenant-scoped proxy.
      // $connect/$disconnect affect the underlying client's connection pool;
      // $extends would bypass the Proxy's RLS wrapping.
      if (BLOCKED_LIFECYCLE.has(prop)) {
        throw new Error(
          `Cannot call '${prop}' on a tenant-scoped client. Use the base PrismaClient directly.`
        );
      }

      // Block operations that bypass RLS scoping.
      // $queryRawTyped/$queryRaw would execute without SET LOCAL.
      // $executeRaw/$executeRawTyped could mutate outside tenant context.
      if (BLOCKED_RAW_SQL.has(prop)) {
        throw new Error(
          `Cannot call '${prop}' on a tenant-scoped client. Raw SQL bypasses RLS. Use the base PrismaClient.`
        );
      }

      // Other internal Prisma properties pass through safely
      if (prop.startsWith("$") || prop.startsWith("_")) {
        return (target as any)[prop];
      }

      // Model delegate (party, person, organization, etc.)
      const delegate = (target as any)[prop];
      if (!delegate || typeof delegate !== "object") return delegate;

      return new Proxy(delegate, {
        get(modelTarget, method: string | symbol) {
          if (typeof method !== "string") return (modelTarget as any)[method];

          const originalFn = (modelTarget as any)[method];
          if (typeof originalFn !== "function") return originalFn;

          if (!DATA_METHODS.has(method)) return originalFn;

          // Return a wrapped function that sets tenant context for standalone queries.
          // Note: Queries inside $transaction use the intercepted $transaction path above.
          return async function (this: unknown, ...args: unknown[]) {
            return prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
              const txDelegate = (tx as any)[prop];
              if (!txDelegate) {
                throw new Error(`Model "${String(prop)}" not found on transaction client`);
              }
              const txMethod = txDelegate[method];
              if (!txMethod || typeof txMethod !== "function") {
                throw new Error(`Method "${method}" not found on model "${String(prop)}"`);
              }
              return txMethod.apply(txDelegate, args);
            });
          };
        },
      });
    },
  }) as any as PrismaClient;
}
