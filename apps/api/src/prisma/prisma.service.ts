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
import { createTenantClient, validateTenantIdEnhanced, CreateTenantClientOptions } from "@besterp/database";
import { MAX_TENANT_CACHE_SIZE } from "@besterp/shared";

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
  private readonly tenantClientCache = new Map<string, WeakRef<PrismaClient>>();
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
    this.tenantClientCache.delete(tenantId);
    this.unregisterTokens.delete(tenantId);
    this.lastAccessed.delete(tenantId);
  });
  private readonly unregisterTokens = new Map<string, object>();
  /** Access timestamps for LRU eviction — updated on each cache hit. */
  private readonly lastAccessed = new Map<string, number>();

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

     // Read cache sizes from env with defaults
     this.maxMethodCacheSize = Number(process.env.PRISMA_MAX_METHOD_CACHE_SIZE) || DEFAULT_MAX_METHOD_CACHE_SIZE;
     this.maxDelegateCacheSize = Number(process.env.PRISMA_MAX_DELEGATE_CACHE_SIZE) || DEFAULT_MAX_DELEGATE_CACHE_SIZE;
   }

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL environment variable is not set. " +
        "The app client requires DATABASE_URL to connect as the RLS-enforced role."
      );
    }
    if (!process.env.DATABASE_ADMIN_URL) {
      // The admin client falls back to DATABASE_URL when DATABASE_ADMIN_URL
      // is unset. In production this is a misconfiguration; in dev it often
      // works (operators may only set DATABASE_URL) but it means the admin
      // client connects as besterp_app — so any write that bypasses RLS
      // (audit logs, idempotency records) will silently hit RLS policies
      // and fail. Warn in all environments so the operator notices.
      const severity = process.env.NODE_ENV === "production" ? "warn" : "log";
      this.logger[severity](
        "DATABASE_ADMIN_URL is not set — admin client falls back to DATABASE_URL. " +
        "In production the admin client should use a superuser connection to bypass RLS. " +
        "In dev, this means audit logs and idempotency records (which use this client " +
        "to bypass RLS) will be silently rejected by RLS policies. Set DATABASE_ADMIN_URL " +
        "to a superuser connection string to fix."
      );
    }
    try {
      await this.$connect();
      await this._appClient.$connect();
      this.logger.log("Database connections established (admin + app)");
    } catch (error: unknown) {
      this.logger.error(
        `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined
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
    const labels = ["admin", "app"] as const;
    for (let i = 0; i < disconnectResults.length; i++) {
      const result = disconnectResults[i];
      if (result?.status === "rejected") {
        this.logger.error(`Error disconnecting ${labels[i]} client: ${result.reason}`);
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
  tenantScoped(tenantId: string): PrismaClient {
    if (this._destroyed) {
      throw new Error(
        "PrismaService is destroyed — cannot create tenant-scoped client. " +
        "This usually means the application is shutting down."
      );
    }

    validateTenantIdEnhanced(tenantId);

    const cached = this.tenantClientCache.get(tenantId)?.deref();
    if (cached) {
      this.lastAccessed.set(tenantId, Date.now());
      return cached;
    }

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

    // If no stale entries, evict LRU live entry
    if (staleKeys.length === 0 && lruKey) {
      this.logger.warn(
        `Tenant client cache full (${MAX_TENANT_CACHE_SIZE}). Evicting LRU entry: '${lruKey}'.`
      );
      this.removeTenantClient(lruKey);
    }
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
