// Prisma Module — Provides RLS-aware PrismaClient to the application.
//
// Phase 0b:
// - Implement Prisma Client Extension for automatic tenant context
// - Add request-scoped tenant resolution via JWT/auth middleware
// - Connection pooling configuration
//
// NOTE: PrismaService extends PrismaClient directly. This works because
// the DATABASE_URL env var is set at import time. For production, consider
// constructor injection of the connection string for testability.

import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
