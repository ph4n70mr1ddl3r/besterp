// Prisma Module — Provides the RLS-aware PrismaService to the application.
//
// PrismaService exposes three clients:
// - admin: cross-tenant operations (global reference data, audit/idempotency
//   sinks) that bypass RLS by design.
// - appClient: the RLS-enforced application client for tenant-scoped operations.
// - tenantScoped(tenantId): per-tenant proxies that call set_tenant_context()
//   at the database level, cached with WeakRef eviction + LRU replacement.
//
// The @Global() decorator makes PrismaService injectable across all modules
// without per-module imports.

import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
