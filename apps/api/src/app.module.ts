// BestERP API — Root Module
//
// Wires together all feature modules:
// - AuthModule: JWT authentication + tenant context (global guards)
// - PrismaModule: Database access with RLS-aware client (global)
// - PartyModule: Core party domain service + REST endpoints
// - McpModule: MCP tool server with middleware pipeline
// - QueueModule: Redis/BullMQ for domain events & async jobs
// - HealthModule: Health check endpoints

// reflect-metadata is imported once in main.ts (the entry point). The first
// import enables the decorator metadata globally; subsequent imports are
// no-ops but pollute the dependency graph.
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module.js";
import { JwtAuthGuard } from "./auth/jwt-auth.guard.js";
import { TenantGuard } from "./auth/tenant.guard.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { PartyModule } from "./modules/core/party/party.module.js";
import { McpModule } from "./mcp/mcp.module.js";
import { QueueModule } from "./queue/queue.module.js";
import { HealthModule } from "./health.module.js";
import { DomainExceptionFilter } from "./common/domain-exception.filter.js";

@Module({
  imports: [
    AuthModule,           // JWT authentication (must be early for guard registration)
    PrismaModule,         // Global — provides PrismaService everywhere
    PartyModule,          // Core party domain (imports PrismaModule)
    McpModule.forRoot(),  // MCP tool server (imports PartyModule + PrismaModule)
    QueueModule.forRoot(), // Redis/BullMQ — domain events & async jobs
    HealthModule,        // Health check endpoints
  ],
  controllers: [],
  providers: [
    // Global exception filter — catches DomainError and maps to HTTP responses
    { provide: APP_FILTER, useClass: DomainExceptionFilter },

    // Global guards — applied to ALL controllers in order:
    // 1. JwtAuthGuard: Validates JWT token, populates req.user
    // 2. TenantGuard: Extracts tenant context from req.user → req.tenantContext
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
})
export class AppModule {}