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

// ─── LRU Cache ────────────────────────────────────────────────────

/** Simple LRU cache implementation using Map (preserves insertion order). */
class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new RangeError(`LruCache maxSize must be >= 1, got ${maxSize}`);
  }

  get(key: K): V | undefined {
    if (this.map.has(key)) {
      const value = this.map.get(key)!;
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }
    return undefined;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean { return this.map.has(key); }
  get size(): number { return this.map.size; }
}

// ─── Enhanced Validation Functions ────────────────────────────────

/**
 * Enhanced tenant ID validation — wraps validateTenantId with a structured DomainError.
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
    const safePreview = tenantId.replace(/[^a-zA-Z0-9_-]/g, "?");
    const preview = safePreview.length > 20 ? `${safePreview.slice(0, 20)}...` : safePreview;
    const message = e instanceof Error ? e.message : String(e);
    throw new InvalidTypeValueError(
      message,
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
 * @param options  - Optional configuration for cache sizes
 * @returns A Proxy-wrapped PrismaClient with automatic RLS scoping
 */
export interface CreateTenantClientOptions {
  maxMethodCacheSize?: number;
  maxDelegateCacheSize?: number;
}

function createTransactionWrapper(prisma: PrismaClient, tenantId: string) {
  return (...args: unknown[]) => {
    let fn: ((tx: Prisma.TransactionClient) => Promise<unknown>) | undefined;
    let options: unknown;

    if (typeof args[0] === "function") {
      fn = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
      options = typeof args[1] === "object" && args[1] !== null ? args[1] : undefined;
    } else if (typeof args[0] === "object" && args[0] !== null) {
      options = args[0];
      fn = typeof args[1] === "function" ? (args[1] as (tx: Prisma.TransactionClient) => Promise<unknown>) : undefined;
    }

    if (fn) {
      const wrappedFn = async (tx: Prisma.TransactionClient) => {
        try {
          await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
        } catch (e) {
          throw new Error(
            `Failed to set tenant context for '${tenantId}': ${e instanceof Error ? e.message : String(e)}`,
            { cause: e }
          );
        }
        return fn(tx);
      };
      return options ? (prisma as any).$transaction(wrappedFn, options) : (prisma as any).$transaction(wrappedFn);
    }

    if (Array.isArray(args[0])) {
      throw new Error(
        "Batch $transaction([...promises]) is not supported on a tenant-scoped client. " +
        "Use an interactive transaction: $transaction(async (tx) => { ... })"
      );
    }

    throw new Error("Unsupported $transaction arguments. Use $transaction(async (tx) => { ... })");
  };
}

function createModelDelegateProxy(
  delegate: object, modelName: string,
  methodCache: LruCache<string, (...args: unknown[]) => Promise<unknown>>,
  prisma: PrismaClient, tenantId: string,
) {
  return new Proxy(delegate, {
    set(_modelTarget, _prop, _value) {
      throw new Error(`Cannot set '${String(_prop)}' on model '${modelName}' of a tenant-scoped client.`);
    },
    deleteProperty(_modelTarget, modelProp) {
      throw new Error(`Cannot delete '${String(modelProp)}' on model '${modelName}' of a tenant-scoped client.`);
    },
    get(modelTarget, method: string | symbol) {
      if (typeof method !== "string") return (modelTarget as any)[method];

      const originalFn = (modelTarget as any)[method];
      if (typeof originalFn !== "function") return originalFn;
      if (!DATA_METHODS.has(method)) return originalFn;

      const cacheKey = `${modelName}.${method}`;
      const cached = methodCache.get(cacheKey);
      if (cached) return cached;

      const wrapped = async function (this: unknown, ...args: unknown[]) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_tenant_context(${tenantId})`;
          const txDelegate = (tx as any)[modelName];
          if (!txDelegate) throw new Error(`Model "${modelName}" not found on transaction client`);
          const txMethod = txDelegate[method];
          if (!txMethod || typeof txMethod !== "function") throw new Error(`Method "${method}" not found on model "${modelName}"`);
          return txMethod.apply(txDelegate, args);
        });
      };
      methodCache.set(cacheKey, wrapped);
      return wrapped;
    },
  });
}

function createClientProxy(
  prisma: PrismaClient, tenantId: string,
  methodCache: LruCache<string, (...args: unknown[]) => Promise<unknown>>,
  delegateCache: LruCache<string, object>,
  transactionWrapper: (...args: unknown[]) => unknown,
) {
  return new Proxy(prisma, {
    set(_target, prop) {
      throw new Error(`Cannot set '${String(prop)}' on a tenant-scoped client. Use the base PrismaClient directly.`);
    },
    deleteProperty(_target, prop) {
      throw new Error(`Cannot delete '${String(prop)}' on a tenant-scoped client. Use the base PrismaClient directly.`);
    },
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return (target as any)[prop];
      if (prop === "$transaction") return transactionWrapper;
      if (BLOCKED_LIFECYCLE.has(prop)) {
        throw new Error(`Cannot call '${prop}' on a tenant-scoped client. Use the base PrismaClient directly.`);
      }
      if (BLOCKED_RAW_SQL.has(prop)) {
        throw new Error(`Cannot call '${prop}' on a tenant-scoped client. Raw SQL (including unsafe variants) bypasses RLS. Use the base PrismaClient.`);
      }
      if (prop.startsWith("$")) {
        throw new Error(`Cannot call '${prop}' on a tenant-scoped client. Only $transaction is allowed. Use the base PrismaClient for other operations.`);
      }
      if (prop.startsWith("_")) {
        throw new Error(`Cannot access '${prop}' on a tenant-scoped client. Internal properties are not exposed.`);
      }

      const cachedDelegate = delegateCache.get(prop);
      if (cachedDelegate) return cachedDelegate;

      const delegate = (target as any)[prop];
      if (!delegate || typeof delegate !== "object") return delegate;

      const proxy = createModelDelegateProxy(delegate, prop, methodCache, prisma, tenantId);
      delegateCache.set(prop, proxy);
      return proxy;
    },
  }) as unknown as PrismaClient;
}

export function createTenantClient(prisma: PrismaClient, tenantId: string, options: CreateTenantClientOptions = {}) {
  validateTenantIdEnhanced(tenantId);
  validatePrismaClientForRls(prisma);

  const maxMethodCacheSize = options.maxMethodCacheSize ?? 1000;
  const maxDelegateCacheSize = options.maxDelegateCacheSize ?? 50;

  const methodCache = new LruCache<string, (...args: unknown[]) => Promise<unknown>>(maxMethodCacheSize);
  const delegateCache = new LruCache<string, object>(maxDelegateCacheSize);

  const transactionWrapper = createTransactionWrapper(prisma, tenantId);

  return createClientProxy(prisma, tenantId, methodCache, delegateCache, transactionWrapper);
}
