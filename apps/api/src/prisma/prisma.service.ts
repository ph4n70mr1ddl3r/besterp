// Prisma Service — NestJS-compatible PrismaClient wrapper with RLS support.
//
// Provides:
// - The base admin PrismaClient (for migrations, cross-tenant operations)
// - `createTenantClient(tenantId)` — returns an RLS-scoped client for a tenant
//
// IMPORTANT: The base client connects as the admin role (DATABASE_ADMIN_URL)
// for write operations that bypass RLS. The tenant-scoped client connects
// as the app role (DATABASE_URL) where RLS is enforced.

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createTenantClient, validateTenantIdEnhanced, CreateTenantClientOptions, TenantScopedClient } from "@besterp/database";
import { MAX_TENANT_CACHE_SIZE, sanitizeForLogOutput } from "@besterp/shared";

// Cache configuration constants — exported for testing and override via env
export const DEFAULT_MAX_METHOD_CACHE_SIZE = 1000;
export const DEFAULT_MAX_DELEGATE_CACHE_SIZE = 50;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly _appClient: PrismaClient;
  private _destroyed = false;
  /** Cache of tenant-scoped Proxy clients to avoid GC pressure from repeated creation. */
  private readonly tenantClientCache = new Map<string, WeakRef<TenantScopedClient>>();
  // FinalizationRegistry evicts cache entries when GC collects the Proxy.
  // Note: we do NOT try to $disconnect the tenant client because the Proxy
  // blocks $disconnect (tenant clients share the underlying _appClient connection).
  // Unregister tokens are stored separately so we can always unregister without
  // needing to deref the WeakRef (which may already be GC'd).
  private readonly cacheRegistry = new FinalizationRegistry<string>((tenantId: string) => {
    // Guard: the registry callback can fire after onModuleDestroy clears the maps.
    // The Map.delete() on a non-existent key is a no-op, so this is safe, but
    // we skip the token cleanup if the service is already destroyed.
    if (this._destroyed) return;
    // Race condition guard: between the old client being GC'd and this callback
    // firing, a NEW client for the same tenantId may have been created and cached.
    // Only delete the cache entry if the WeakRef for this tenantId is actually
    // dead — if a new client exists, its WeakRef would still be alive.
    const ref = this.tenantClientCache.get(tenantId);
    if (ref && ref.deref()) return;
    this.tenantClientCache.delete(tenantId);
    this.unregisterTokens.delete(tenantId);
    this.lastAccessed.delete(tenantId);
  });
  private readonly unregisterTokens = new Map<string, object>();
  /** Access timestamps for LRU eviction — updated on each cache hit. */
  private readonly lastAccessed = new Map<string, number>();

  /** Cache hit/miss counters for observability. */
  private cacheHits = 0;
  private cacheMisses = 0;

  // Cache sizes — configurable via env vars for tuning in production
  private readonly maxMethodCacheSize: number;
  private readonly maxDelegateCacheSize: number;

  constructor() {
    // Base client uses admin URL for migrations, seed, cross-tenant ops
    super({
      datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
      log: [
        { emit: "stdout", level: "warn" },
        { emit: "stdout", level: "error" },
      ],
    });

    // App client uses the non-superuser URL for RLS-enforced operations
    this._appClient = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL, // must be the besterp_app role
      log: [
        { emit: "stdout", level: "warn" },
        { emit: "stdout", level: "error" },
      ],
    });

    // Read cache sizes from env with defaults — clamp to [1, 100_000] to
    // prevent negative values (invalid LRU caches) and absurdly large values
    // (memory exhaustion). 100K entries is far above any realistic workload.
    this.maxMethodCacheSize = Math.min(100_000, Math.max(1, Number(process.env.PRISMA_MAX_METHOD_CACHE_SIZE) || DEFAULT_MAX_METHOD_CACHE_SIZE));
    this.maxDelegateCacheSize = Math.min(100_000, Math.max(1, Number(process.env.PRISMA_MAX_DELEGATE_CACHE_SIZE) || DEFAULT_MAX_DELEGATE_CACHE_SIZE));
  }

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL environment variable is not set. " +
        "The app client requires DATABASE_URL to connect as the RLS-enforced role."
      );
    }
    if (!process.env.DATABASE_ADMIN_URL) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "DATABASE_ADMIN_URL must be set in production. " +
          "The admin client requires a superuser connection to bypass RLS for " +
          "audit logs, idempotency records, and cross-tenant operations."
        );
      }
      // In dev, warn so the operator notices the fallback.
      this.logger.warn(
        "DATABASE_ADMIN_URL is not set — admin client falls back to DATABASE_URL. " +
        "Audit logs and idempotency records (which use the admin client to bypass RLS) " +
        "will be silently rejected by RLS policies. Set DATABASE_ADMIN_URL to a superuser " +
        "connection string to fix."
      );
    }
    try {
      const connectResults = await Promise.allSettled([
        this.$connect(),
        this._appClient.$connect(),
      ]);
      for (const result of connectResults) {
        if (result.status === "rejected") {
          // Disconnect any successfully connected clients before re-throwing
          await Promise.allSettled([this.$disconnect(), this._appClient.$disconnect()]);
          throw result.reason;
        }
      }
      this.logger.log("Database connections established (admin + app)");
    } catch (error: unknown) {
      // Sanitize before logging: Prisma/driver connection errors frequently
      // embed the datasource URL (credentials + hostname) in their message
      // and stack. main.ts's shutdown paths and the global error handler both
      // scrub these via sanitizeForLogOutput — do the same here so the admin
      // and app client connection failures don't leak secrets to operator logs.
      this.logger.error(
        `Failed to connect to database: ${sanitizeForLogOutput(error instanceof Error ? error.message : String(error))}`,
        error instanceof Error && error.stack ? sanitizeForLogOutput(error.stack) : undefined
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    // Mark as destroyed to reject new tenant client requests and prevent
    // FinalizationRegistry callbacks from operating on cleared maps.
    this._destroyed = true;

    // Clear tenant client cache and unregister from FinalizationRegistry
    // to prevent phantom callbacks after the service is destroyed.
    for (const [, token] of this.unregisterTokens) {
      this.cacheRegistry.unregister(token);
    }
    this.tenantClientCache.clear();
    this.unregisterTokens.clear();
    this.lastAccessed.clear();

    const disconnectResults = await Promise.allSettled([
      this.$disconnect(),
      this._appClient.$disconnect(),
    ]);
    const labels: ReadonlyArray<string> = ["admin", "app"];
    for (let i = 0; i < disconnectResults.length; i++) {
      const result = disconnectResults[i]!;
      if (result.status === "rejected") {
        // Sanitize: a disconnect rejection can carry a driver error whose
        // message includes the datasource URL. `${reason}` stringifies an
        // Error as `name: message`, so the URL would reach the log verbatim
        // without this scrub.
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error(`Error disconnecting ${labels[i]} client: ${sanitizeForLogOutput(reason)}`);
      }
    }
  }

  /**
   * Get the admin PrismaClient (bypasses RLS).
   * Use ONLY for: migrations, seed, audit log writes, cross-tenant admin ops.
   */
  get admin(): PrismaClient {
    return this;
  }

  /**
   * Get the app PrismaClient (RLS-enforced path).
   * Use for health checks and other runtime connectivity verification.
   */
  get appClient(): PrismaClient {
    return this._appClient;
  }

  /**
   * Create an RLS-scoped PrismaClient for a specific tenant.
   *
   * All operations on the returned client are wrapped in a transaction
   * that calls `set_tenant_context()` before each query. RLS policies
   * enforce tenant isolation at the database level.
   *
   * Tenant clients are cached via WeakRef to avoid creating a new Proxy
   * on every call. Entries are automatically evicted when GC collects them.
   *
   * @param tenantId - The tenant to scope queries to
   * @returns A Proxy-wrapped PrismaClient with automatic RLS scoping
   */
  tenantScoped(tenantId: string): TenantScopedClient {
    if (this._destroyed) {
      throw new Error(
        "PrismaService is destroyed — cannot create tenant-scoped client. " +
        "This usually means the application is shutting down."
      );
    }

    validateTenantIdEnhanced(tenantId);

    const cached = this.tenantClientCache.get(tenantId)?.deref();
    if (cached) {
      this.cacheHits++;
      this.lastAccessed.set(tenantId, Date.now());
      return cached;
    }

    this.cacheMisses++;

    if (this.tenantClientCache.size >= MAX_TENANT_CACHE_SIZE) {
      this.evictTenantClient();
    }

    const options: CreateTenantClientOptions = {
      maxMethodCacheSize: this.maxMethodCacheSize,
      maxDelegateCacheSize: this.maxDelegateCacheSize,
    };
    const client = createTenantClient(this._appClient, tenantId, options);
    const token = {};
    this.tenantClientCache.set(tenantId, new WeakRef(client));
    this.unregisterTokens.set(tenantId, token);
    this.cacheRegistry.register(client, tenantId, token);
    this.lastAccessed.set(tenantId, Date.now());
    return client;
  }

  /**
   * Get cache statistics for observability.
   * @returns Object with hits, misses, hit rate, and current cache size
   */
  getTenantCacheStats(): {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    maxSize: number;
  } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      size: this.tenantClientCache.size,
      maxSize: MAX_TENANT_CACHE_SIZE,
    };
  }

  /**
   * Evict a tenant client from the cache when at capacity.
   * Priority: 1) Stale entries (GC'd), 2) Least recently used live entry.
   */
  private evictTenantClient(): void {
    // First pass: collect stale entries and find LRU among live entries
    const staleKeys: string[] = [];
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, ref] of this.tenantClientCache) {
      if (!ref.deref()) {
        staleKeys.push(key);
      } else {
        const ts = this.lastAccessed.get(key) ?? 0;
        if (ts < lruTime) {
          lruTime = ts;
          lruKey = key;
        }
      }
    }

    // Evict all stale entries first
    for (const key of staleKeys) {
      this.removeTenantClient(key);
    }

    // After evicting stale entries, check if we're still at capacity.
    // WeakRef targets may not be GC'd yet, so staleKeys could be empty
    // even though the cache is logically full. Evict LRU if still at capacity.
    if (this.tenantClientCache.size >= MAX_TENANT_CACHE_SIZE && lruKey) {
      this.logger.debug(
        `Tenant client cache full (${MAX_TENANT_CACHE_SIZE}). Evicting LRU entry: '${lruKey}'.`
      );
      this.removeTenantClient(lruKey);
    }
  }

  /**
   * Force cleanup of the tenant client cache.
   * Useful for testing or manual cache clearing.
   */
  clearTenantCache(): void {
    for (const [, token] of this.unregisterTokens) {
      this.cacheRegistry.unregister(token);
    }
    this.tenantClientCache.clear();
    this.unregisterTokens.clear();
    this.lastAccessed.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /** Remove a tenant client and its associated tracking data. */
  private removeTenantClient(tenantId: string): void {
    const token = this.unregisterTokens.get(tenantId);
    if (token) {
      this.cacheRegistry.unregister(token);
      this.unregisterTokens.delete(tenantId);
    }
    this.tenantClientCache.delete(tenantId);
    this.lastAccessed.delete(tenantId);
  }
}
