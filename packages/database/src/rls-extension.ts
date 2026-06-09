// Prisma Client Extension for automatic Row-Level Security (RLS) tenant scoping.
/* eslint-disable @typescript-eslint/no-explicit-any */
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
// - Batch `$transaction([...promises])` calls are rejected with an error
//   because they cannot receive tenant context. Use interactive transactions.

import { PrismaClient, Prisma } from "@prisma/client";
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
    // Sanitize preview to avoid leaking untrusted input in error context.
    const sanitized = tenantId.replace(/[^a-zA-Z0-9_-]/g, "?");
    const preview = sanitized.length > 20 ? `${sanitized.slice(0, 20)}...` : sanitized;
    throw new InvalidTypeValueError(
      (e as Error).message,
      { context: { field: "tenantId", received: preview } }
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

/** Read-only query methods that RLS-scope via SET LOCAL inside a transaction. */
const READ_METHODS = new Set([
  "findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy",
  "findUniqueOrThrow", "findFirstOrThrow",
]);

/** Write methods that RLS-scope via SET LOCAL inside a transaction. */
const WRITE_METHODS = new Set([
  "create", "update", "delete", "upsert", "updateMany", "deleteMany",
  "createMany", "createManyAndReturn",
]);

const DATA_METHODS = new Set([...READ_METHODS, ...WRITE_METHODS]);

/** Operations that should never be called on a tenant-scoped proxy. */
const BLOCKED_LIFECYCLE = new Set(["$connect", "$disconnect", "$extends"]);

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
  const methodCache = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  // Cache for model delegate proxies to avoid creating a new Proxy on every property access.
  // Without this, each access to `scoped.party` creates a new Proxy wrapping the delegate.
  const delegateCache = new Map<string, object>();

  // Pre-build the $transaction wrapper so it's allocated once, not per-access.
  const transactionWrapper = (...args: unknown[]) => {
    let fn: ((tx: Prisma.TransactionClient) => Promise<unknown>) | undefined;
    let options: unknown;

    // Prisma 5+ supports two overloads:
    //   $transaction(fn, options?)
    //   $transaction(options, fn)
    if (typeof args[0] === "function") {
      fn = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
      options = typeof args[1] === "object" && args[1] !== null ? args[1] : undefined;
    } else if (typeof args[0] === "object" && args[0] !== null) {
      // options-first syntax: $transaction({ maxWait, timeout }, fn)
      options = args[0];
      fn = typeof args[1] === "function"
        ? (args[1] as (tx: Prisma.TransactionClient) => Promise<unknown>)
        : undefined;
    }

    if (fn) {
      const wrappedFn = async (tx: Prisma.TransactionClient) => {
        // $executeRaw returns affected row count (number). set_tenant_context() returns
        // void, so Prisma coerces it to 0. This works in practice but is fragile —
        // if Prisma strictens type checking for $executeRaw results in the future,
        // this may need to switch to $queryRaw or a cast (SELECT set_tenant_context(...)::bigint).
        await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
        return fn(tx);
      };
      return options
        ? (prisma as any).$transaction(wrappedFn, options)
        : (prisma as any).$transaction(wrappedFn);
    }

    // Batch transaction: $transaction([...promises])
    // These pass through without tenant context, which is a silent RLS bypass.
    // Throw instead of silently passing through to prevent accidental
    // cross-tenant data leaks. Callers must use interactive transactions
    // ($transaction(fn)) for tenant-scoped batch operations.
    if (Array.isArray(args[0])) {
      throw new Error(
        "Batch $transaction([...promises]) is not supported on a tenant-scoped client. " +
        "Use an interactive transaction: $transaction(async (tx) => { ... })"
      );
    }

    // Unknown overload — throw instead of silently passing through,
    // which would bypass RLS scoping.
    throw new Error(
      "Unsupported $transaction arguments. Use $transaction(async (tx) => { ... })"
    );
  };

  return new Proxy(prisma, {
    // Prevent accidental mutation of the tenant-scoped proxy.
    // All writes should go through the base PrismaClient, not the
    // tenant-scoped wrapper.
    set(_target, prop) {
      throw new Error(
        `Cannot set '${String(prop)}' on a tenant-scoped client. Use the base PrismaClient directly.`
      );
    },
    deleteProperty(_target, prop) {
      throw new Error(
        `Cannot delete '${String(prop)}' on a tenant-scoped client. Use the base PrismaClient directly.`
      );
    },
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
        // Block property writes on the model delegate. Without these traps,
        // `scoped.party.someField = "x"` would silently mutate the underlying
        // shared model delegate and pollute it across all tenants.
        set(_modelTarget, modelProp) {
          throw new Error(
            `Cannot set '${String(modelProp)}' on model '${String(prop)}' of a tenant-scoped client.`
          );
        },
        deleteProperty(_modelTarget, modelProp) {
          throw new Error(
            `Cannot delete '${String(modelProp)}' on model '${String(prop)}' of a tenant-scoped client.`
          );
        },
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
          //
          // PERFORMANCE: Every standalone query is wrapped in its own $transaction
          // because PostgreSQL's SET LOCAL is scoped to the current transaction.
          // Without a transaction, SET LOCAL would log a WARNING and have no effect,
          // leaving the RLS setting unset and causing all queries to fail the
          // policies' current_setting('app.current_tenant', TRUE) != '' guard.
          //
          // For write operations the transaction is required for atomicity anyway.
          // For read operations the overhead of a lightweight PG transaction (just
          // BEGIN/COMMIT with no WAL fsync) is ~0.1ms — negligible for the Phase 0b
          // workload. If this becomes a bottleneck, options to remove the per-query
          // transaction include:
          //   1. Switch from SET LOCAL to set_config('app.current_tenant', id, false)
          //      (session-scoped) and pin connections to tenants at the pool level.
          //   2. Use Prisma middleware to set the context once per request at the
          //      NestJS/Express boundary, saving and restoring between requests.
          //   3. Let the caller manage transactions explicitly for batches of reads.
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
  }) as unknown as PrismaClient;
}
