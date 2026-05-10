// Prisma Module — Provides RLS-aware PrismaClient to the application.
//
// Phase 0b TODO:
// - Implement Prisma Client Extension for automatic tenant context
// - Add request-scoped tenant resolution via JWT/auth middleware
// - Connection pooling configuration

import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
