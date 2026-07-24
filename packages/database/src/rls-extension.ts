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
// - Batch `$transaction([...promises])` calls are rejected with an error
//   because they cannot receive tenant context. Use interactive transactions.

import type { PrismaClient, Prisma } from "@prisma/client";
import { validateTenantId, InvalidTypeValueError, isDomainError, setTenantContext } from "@besterp/shared";

/** Default timeout for individual model operation transactions (ms). */
const DEFAULT_TX_TIMEOUT_MS = 30_000;

// ─── Blocked methods — single source of truth ─────────────────────
// These names must stay in sync with the TenantScopedClient type alias.
// If a method is omitted from the type, it should also be added here.

/** A PrismaClient-like interface with automatic RLS tenant context injection. */
export type TenantScopedClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$extends" | "$queryRaw" | "$queryRawTyped" | "$executeRaw" | "$executeRawTyped" | "$queryRawUnsafe" | "$executeRawUnsafe">;



// ─── LRU Cache ────────────────────────────────────────────────────

/** Simple LRU cache implementation using Map (preserves insertion order). */
class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new RangeError(`LruCache maxSize must be >= 1, got ${maxSize}`);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
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

}

// ─── Enhanced Validation Functions ────────────────────────────────

/**
 * Enhanced tenant ID validation — wraps validateTenantId with a structured DomainError.
 * Returns the trimmed tenant ID or throws InvalidTenantIdError.
 */
export function validateTenantIdEnhanced(tenantId: string): string {
  // Base validation enforces /^[a-zA-Z0-9_-]+$/ which rejects
  // all special characters (semicolons, quotes, comment delimiters, etc.).
  try {
    return validateTenantId(tenantId);
  } catch (e) {
    // Preserve original DomainError with its specific code (e.g. INVALID_TENANT_ID)
    // instead of wrapping it as INVALID_TYPE_VALUE, which loses error specificity.
    if (isDomainError(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new InvalidTypeValueError(
      message,
      { cause: e instanceof Error ? e : undefined, context: { field: "tenantId" } }
    );
  }
}

/**
 * Validate that a Prisma client has the required methods for RLS.
 */
export function validatePrismaClientForRls(prisma: PrismaClient): void {
  if (!prisma || typeof prisma.$transaction !== "function" || typeof prisma.$executeRaw !== "function") {
    throw new InvalidTypeValueError(
      "Prisma client does not support RLS operations. Make sure it's connected with the correct role.",
      { context: { provided: typeof prisma } }
    );
  }
}

// ─── Data-access methods to wrap with tenant context ──────────────

const DATA_METHODS = new Set([
  "findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy",
  "findUniqueOrThrow", "findFirstOrThrow",
  "create", "update", "delete", "upsert", "updateMany", "deleteMany",
  "createMany", "createManyAndReturn",
]);

/** Operations that should never be called on a tenant-scoped proxy. */
const BLOCKED_CLIENT_METHODS = new Set(["$connect", "$disconnect", "$extends"]);

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
    let options: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel } | undefined;

    if (typeof args[0] === "function") {
      fn = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
      options = typeof args[1] === "object" && args[1] !== null ? args[1] as { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel } : undefined;
    } else if (Array.isArray(args[0])) {
      throw new InvalidTypeValueError(
        "Batch $transaction([...promises]) is not supported on a tenant-scoped client. " +
        "Use an interactive transaction instead: $transaction(async (tx) => { ... }). " +
        "Note: interactive transactions run sequentially, unlike batch which runs concurrently."
      );
    }

    if (fn) {
      const wrappedFn = async (tx: Prisma.TransactionClient) => {
        await setTenantContext(tx, tenantId);
        return fn(tx);
      };
      return prisma.$transaction(wrappedFn, options);
    }

    throw new InvalidTypeValueError(
      `Unsupported $transaction argument: expected a function or array, got ${typeof args[0]}. ` +
      `Use $transaction(async (tx) => { ... })`
    );
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
      if (typeof method !== "string") {
        throw new Error(
          `Cannot access non-string property '${String(method)}' on model '${modelName}' of a tenant-scoped client — symbol access bypasses RLS.`
        );
      }

      // `$transaction` is NOT supported on a model delegate: the only
      // tenant-context-carrying transaction wrapper lives on the client proxy
      // (see createClientProxy). A `$transaction` reached here runs WITHOUT
      // `set_tenant_context` and thus silently bypasses RLS. Reject it
      // explicitly so a future caller cannot write cross-tenant — checked
      // before the function/non-function early-return below because Prisma does
      // not actually expose `$transaction` on model delegates, so `originalFn`
      // would otherwise be `undefined` and slip through.
      if (method === "$transaction") {
        throw new Error(
          `Cannot call '$transaction' on the '${modelName}' model delegate of a tenant-scoped client. ` +
          `Use the client-level '$transaction' so tenant context is applied.`
        );
      }

      const originalFn = (modelTarget as Record<string, unknown>)[method];
      if (typeof originalFn !== "function") return originalFn;
      if (!DATA_METHODS.has(method)) return originalFn;

      const cacheKey = `${modelName}.${method}`;
      const cached = methodCache.get(cacheKey);
      if (cached) return cached;

      const wrapped = async function (this: unknown, ...args: unknown[]) {
        return prisma.$transaction(async (tx) => {
          await setTenantContext(tx, tenantId);
          const txDelegate = (tx as unknown as Record<string, unknown>)[modelName];
          if (!txDelegate) throw new Error(`Model "${modelName}" not found on transaction client`);
          const txMethod = (txDelegate as Record<string, unknown>)[method];
          if (!txMethod || typeof txMethod !== "function") throw new Error(`Method "${method}" not found on model "${modelName}"`);
          return txMethod.apply(txDelegate, args);
        }, { timeout: DEFAULT_TX_TIMEOUT_MS });
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
      if (typeof prop !== "string") {
        throw new Error(
          `Cannot access non-string property '${String(prop)}' on a tenant-scoped client — symbol/number access bypasses RLS. Use string property names.`
        );
      }
      if (prop === "$transaction") return transactionWrapper;
      if (BLOCKED_CLIENT_METHODS.has(prop)) {
        throw new Error(`Cannot call '${prop}' on a tenant-scoped client. Use the base PrismaClient directly.`);
      }
      if (prop.startsWith("$")) {
        throw new Error(`Cannot call '${prop}' on a tenant-scoped client. Only $transaction is allowed. Use the base PrismaClient for other operations.`);
      }
      if (prop.startsWith("_")) {
        throw new Error(`Cannot access '${prop}' on a tenant-scoped client. Internal properties are not exposed.`);
      }

      const cachedDelegate = delegateCache.get(prop);
      if (cachedDelegate) return cachedDelegate;

      const delegate = (target as unknown as Record<string, unknown>)[prop];
      if (!delegate) {
        throw new Error(
          `Model '${prop}' does not exist on the Prisma schema. ` +
          `Check the model name and ensure it is included in schema.prisma.`
        );
      }
      // Any direct-function property on a model delegate would bypass RLS
      // because it returns unmodified — reject all non-object delegates to
      // ensure every access goes through the Proxy wrapper.
      if (typeof delegate === "function") {
        throw new Error(
          `Accessing '${prop}' on a tenant-scoped client is blocked. ` +
          `Direct function properties bypass RLS and are not allowed.`
        );
      }
      if (typeof delegate !== "object") {
        throw new Error(
          `Expected an object for model '${prop}', got ${typeof delegate}. ` +
          `This may indicate a future Prisma version added a non-object property.`
        );
      }

      const proxy = createModelDelegateProxy(delegate, prop, methodCache, prisma, tenantId);
      delegateCache.set(prop, proxy);
      return proxy;
    },
  }) as unknown as PrismaClient;
}

export function createTenantClient(prisma: PrismaClient, tenantId: string, options: CreateTenantClientOptions = {}): TenantScopedClient {
  const normalizedTenantId = validateTenantIdEnhanced(tenantId);
  validatePrismaClientForRls(prisma);

  const maxMethodCacheSize = options.maxMethodCacheSize ?? 1000;
  const maxDelegateCacheSize = options.maxDelegateCacheSize ?? 50;

  const methodCache = new LruCache<string, (...args: unknown[]) => Promise<unknown>>(maxMethodCacheSize);
  const delegateCache = new LruCache<string, object>(maxDelegateCacheSize);

  const transactionWrapper = createTransactionWrapper(prisma, normalizedTenantId);

  return createClientProxy(prisma, normalizedTenantId, methodCache, delegateCache, transactionWrapper);
}
