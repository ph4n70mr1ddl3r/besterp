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

// Whitelist of known safe $ properties on the tenant-scoped proxy.
// Only $transaction is allowed — all others are blocked to prevent
// future Prisma methods from silently bypassing RLS scoping.
const SAFE_DOLLAR_PROPS = new Set(["$transaction"]);

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
  "$queryRawUnsafe", "$executeRawUnsafe",
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

  // Cache for wrapped methods to avoid creating new closures on every access.
  // This reduces GC pressure in high-throughput scenarios where the same methods
  // (e.g., party.findMany, $transaction) are called repeatedly.
  const methodCache = new Map<string, Function>();

  // Cache for model delegate proxies to avoid creating a new Proxy on every property access.
  // Without this, each access to `scoped.party` creates a new Proxy wrapping the delegate.
  const delegateCache = new Map<string, any>();

  // Pre-build the $transaction wrapper so it's allocated once, not per-access.
  const transactionWrapper = (...args: unknown[]) => {
    const [first, second] = args;

    // Interactive transaction: $transaction(fn) or $transaction(fn, options)
    if (typeof first === "function") {
      const options = (typeof second === "object" && second !== null) ? second : undefined;
      const wrappedFn = async (tx: any) => {
        await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
        return first(tx);
      };
      return options
        ? (prisma as any).$transaction(wrappedFn, options)
        : (prisma as any).$transaction(wrappedFn);
    }

    // Batch transaction: $transaction([...promises])
    // These pass through without tenant context. Use interactive
    // transactions for tenant-scoped batch operations.
    if (Array.isArray(first)) {
      return (prisma as any).$transaction(first);
    }

    // Fallback — unknown overload, pass through
    return (prisma as any).$transaction(...args);
  };

  return new Proxy(prisma, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return (target as any)[prop];

      // ─── Intercept $transaction to inject SET LOCAL ────────────
      // Returns the pre-built wrapper (single allocation).
      if (prop === "$transaction") {
        return transactionWrapper;
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
          `Cannot call '${prop}' on a tenant-scoped client. Raw SQL (including unsafe variants) bypasses RLS. Use the base PrismaClient.`
        );
      }

      // Whitelist known safe $ properties instead of allowing all unknown ones.
      // This prevents future Prisma methods (e.g., $metrics, $queryRawSafe)
      // from silently bypassing RLS scoping.
      if (prop.startsWith("$")) {
        if (SAFE_DOLLAR_PROPS.has(prop)) {
          // $transaction is already intercepted above; this branch is
          // unreachable but kept for clarity.
          return transactionWrapper;
        }
        throw new Error(
          `Cannot call '${prop}' on a tenant-scoped client. Only $transaction is allowed. Use the base PrismaClient for other operations.`
        );
      }
      if (prop.startsWith("_")) {
        throw new Error(
          `Cannot access '${prop}' on a tenant-scoped client. Internal properties are not exposed.`
        );
      }

      // Model delegate (party, person, organization, etc.)
      const cachedDelegate = delegateCache.get(prop);
      if (cachedDelegate) return cachedDelegate;

      const delegate = (target as any)[prop];
      if (!delegate || typeof delegate !== "object") return delegate;

      const proxy = new Proxy(delegate, {
        get(modelTarget, method: string | symbol) {
          if (typeof method !== "string") return (modelTarget as any)[method];

          const originalFn = (modelTarget as any)[method];
          if (typeof originalFn !== "function") return originalFn;

          if (!DATA_METHODS.has(method)) return originalFn;

          // Cache the wrapped function to avoid re-creating it on every call.
          const cacheKey = `${String(prop)}.${method}`;
          const cached = methodCache.get(cacheKey);
          if (cached) return cached;

          // Return a wrapped function that sets tenant context for standalone queries.
          // Note: Queries inside $transaction use the intercepted $transaction path above.
          const wrapped = async function (this: unknown, ...args: unknown[]) {
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
          methodCache.set(cacheKey, wrapped);
          return wrapped;
        },
      });

      delegateCache.set(prop, proxy);
      return proxy;
    },
  }) as any as PrismaClient;
}
