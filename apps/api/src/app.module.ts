// BestERP API — Root Module
//
// Wires together all feature modules:
// - PrismaModule: Database access with RLS-aware client
// - McpModule: MCP tool server integration (Phase 0b)
// - HealthModule: Health check endpoints

import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
