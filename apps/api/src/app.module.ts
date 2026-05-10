// BestERP API — Root Module
//
// Wires together all feature modules:
// - AuthModule: JWT authentication + tenant context (global guards)
// - PrismaModule: Database access with RLS-aware client (global)
// - PartyModule: Core party domain service + REST endpoints
// - McpModule: MCP tool server with middleware pipeline
// - QueueModule: Redis/BullMQ for domain events & async jobs

import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { TenantGuard } from "./auth/tenant.guard";
import { PrismaModule } from "./prisma/prisma.module";
import { PartyModule } from "./modules/core/party/party.module";
import { McpModule } from "./mcp/mcp.module";
import { QueueModule } from "./queue/queue.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    AuthModule,           // JWT authentication (must be early for guard registration)
    PrismaModule,         // Global — provides PrismaService everywhere
    PartyModule,          // Core party domain (imports PrismaModule)
    McpModule.forRoot(),  // MCP tool server (imports PartyModule + PrismaModule)
    QueueModule.forRoot(), // Redis/BullMQ — domain events & async jobs
  ],
  controllers: [HealthController],
  providers: [
    // Global guards — applied to ALL controllers in order:
    // 1. JwtAuthGuard: Validates JWT token, populates req.user
    // 2. TenantGuard: Extracts tenant context from req.user → req.tenantContext
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
})
export class AppModule {}
