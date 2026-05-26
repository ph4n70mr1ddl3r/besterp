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
  private readonly cacheRegistry = new FinalizationRegistry<string>((tenantId: string) => {
    this.tenantClientCache.delete(tenantId);
  });

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
    const disconnectAll = await Promise.allSettled([
      this.$disconnect(),
      this.appClient_.$disconnect(),
    ]);
    const errors = disconnectAll.filter((r) => r.status === "rejected");
    if (errors.length > 0) {
      this.logger.error(
        `Error disconnecting database: ${errors.map((e) => (e as PromiseRejectedResult).reason).join(", ")}`
      );
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

    // Evict stale entries if cache exceeds max size.
    // WeakRef entries whose referent was already GC'd return undefined from .deref().
    if (this.tenantClientCache.size >= PrismaService.MAX_CACHE_SIZE) {
      for (const [key, ref] of this.tenantClientCache) {
        if (!ref.deref()) {
          this.tenantClientCache.delete(key);
        }
      }
    }

    const client = createTenantClient(this.appClient_, tenantId);
    this.tenantClientCache.set(tenantId, new WeakRef(client));
    this.cacheRegistry.register(client, tenantId);
    return client;
  }
}
