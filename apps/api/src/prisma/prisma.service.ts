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
  private readonly appClient: PrismaClient;

  constructor() {
    // Base client uses admin URL for migrations, seed, cross-tenant ops
    super({
      datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
    });

    // App client uses the non-superuser URL for RLS-enforced operations
    this.appClient = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL, // must be the besterp_app role
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      await this.appClient.$connect();
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
    try {
      await this.$disconnect();
      await this.appClient.$disconnect();
    } catch (error) {
      this.logger.error(
        `Error disconnecting database: ${(error as Error).message}`
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
   * Create an RLS-scoped PrismaClient for a specific tenant.
   *
   * All operations on the returned client are wrapped in a transaction
   * that calls `set_tenant_context()` before each query. RLS policies
   * enforce tenant isolation at the database level.
   *
   * @param tenantId - The tenant to scope queries to
   * @returns A Proxy-wrapped PrismaClient with automatic RLS scoping
   */
  tenantScoped(tenantId: string): PrismaClient {
    return createTenantClient(this.appClient, tenantId);
  }
}
