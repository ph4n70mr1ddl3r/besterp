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
import { createTenantClient } from "@besterp/database";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly appClient_: PrismaClient;
  /** Cache of tenant-scoped Proxy clients to avoid GC pressure from repeated creation. */
  private readonly tenantClientCache = new Map<string, WeakRef<PrismaClient>>();
  /** Maximum number of tenant clients to cache before eviction. */
  private static readonly MAX_CACHE_SIZE = 256;
  // FinalizationRegistry evicts cache entries when GC collects the Proxy.
  // Note: we do NOT try to $disconnect the tenant client because the Proxy
  // blocks $disconnect (tenant clients share the underlying appClient_ connection).
  // Unregister tokens are stored separately so we can always unregister without
  // needing to deref the WeakRef (which may already be GC'd).
  private readonly cacheRegistry = new FinalizationRegistry<string>((tenantId: string) => {
    this.tenantClientCache.delete(tenantId);
  });
  private readonly unregisterTokens = new Map<string, object>();

  constructor() {
    // Base client uses admin URL for migrations, seed, cross-tenant ops
    super({
      datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
    });

    // App client uses the non-superuser URL for RLS-enforced operations
    this.appClient_ = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL, // must be the besterp_app role
    });
  }

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL environment variable is not set. " +
        "The app client requires DATABASE_URL to connect as the RLS-enforced role."
      );
    }
    if (!process.env.DATABASE_ADMIN_URL && process.env.NODE_ENV === "production") {
      this.logger.warn(
        "DATABASE_ADMIN_URL is not set — admin client falls back to DATABASE_URL. " +
        "In production the admin client should use a superuser connection to bypass RLS. " +
        "Without it, admin/cross-tenant operations may be silently blocked by RLS policies."
      );
    }
    try {
      await this.$connect();
      await this.appClient_.$connect();
      this.logger.log("Database connections established (admin + app)");
    } catch (error) {
      this.logger.error(
        `Failed to connect to database: ${(error as Error).message}`,
        (error as Error).stack
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    // Clear tenant client cache and unregister from FinalizationRegistry
    // to prevent phantom callbacks after the service is destroyed.
    for (const [tenantId, token] of this.unregisterTokens) {
      this.cacheRegistry.unregister(token);
    }
    this.tenantClientCache.clear();
    this.unregisterTokens.clear();

    const disconnectResults = await Promise.allSettled([
      this.$disconnect(),
      this.appClient_.$disconnect(),
    ]);
    const labels = ["admin", "app"];
    for (let i = 0; i < disconnectResults.length; i++) {
      const result = disconnectResults[i];
      if (result.status === "rejected") {
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
    return this.appClient_;
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
    const cached = this.tenantClientCache.get(tenantId)?.deref();
    if (cached) return cached;

    // Only run eviction when the cache is full.
    if (this.tenantClientCache.size >= PrismaService.MAX_CACHE_SIZE) {
      // Collect stale (GC'd) entries first to avoid mutating the map during iteration.
      const staleKeys: string[] = [];
      let oldestKey: string | null = null;
      for (const [key, ref] of this.tenantClientCache) {
        if (!ref.deref()) {
          staleKeys.push(key);
        } else if (!oldestKey) {
          oldestKey = key;
        }
      }

      // Delete stale entries (safe — keys collected before mutation).
      for (const key of staleKeys) {
        const staleToken = this.unregisterTokens.get(key);
        if (staleToken) {
          this.cacheRegistry.unregister(staleToken);
          this.unregisterTokens.delete(key);
        }
        this.tenantClientCache.delete(key);
      }

      // No stale entries found — evict the oldest live entry to make room.
      if (staleKeys.length === 0 && oldestKey) {
        const token = this.unregisterTokens.get(oldestKey);
        if (token) {
          this.cacheRegistry.unregister(token);
        }
        this.tenantClientCache.delete(oldestKey);
        this.unregisterTokens.delete(oldestKey);
      }
    }

    const client = createTenantClient(this.appClient_, tenantId);
    // Use a dedicated object as the unregister token so we can always
    // call unregister without needing to deref the WeakRef.
    const token = {};
    this.tenantClientCache.set(tenantId, new WeakRef(client));
    this.unregisterTokens.set(tenantId, token);
    this.cacheRegistry.register(client, tenantId, token);
    return client;
  }
}
