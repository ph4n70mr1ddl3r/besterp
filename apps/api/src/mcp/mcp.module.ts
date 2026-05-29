// MCP Module — Integrates the MCP Tool Server into NestJS.
//
// This module:
// 1. Creates the ToolRegistry and registers all tools
// 2. Sets up the global middleware pipeline (error handler, idempotency, audit)
// 3. Provides an MCP server adapter that translates MCP protocol calls → registry
// 4. Injects NestJS domain services into tool context via the services map
//
// Auth: MCP tool calls require a valid JWT with tenantId. The MCP transport
// adapter validates the token and passes the tenant context to buildContext().
//
// The MCP server can be exposed via:
// - stdio transport (for local CLI agents)
// - HTTP/SSE transport (for remote agents) — future

import {
  DynamicModule,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { validateTenantIdEnhanced } from "@besterp/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PartyService } from "../modules/core/party/party.service.js";
import { PartyModule } from "../modules/core/party/party.module.js";
import {
  ToolRegistry,
  errorHandlerMiddleware,
  idempotencyMiddleware,
  auditLogMiddleware,
} from "@besterp/mcp-tools";
import { registerPartyTools } from "./tools/party-tools.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";

@Injectable()
export class McpModule implements OnModuleInit {
  private readonly logger = new Logger(McpModule.name);
  private readonly registry = new ToolRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly partyService: PartyService,
  ) {}

  onModuleInit() {
    // ─── Register global middlewares (outermost first) ──────────
    // Order matters: error handler wraps everything, then idempotency, then audit
    // NOTE: Middleware uses the admin client (this.prisma) intentionally:
    //   - Audit logs must be writable cross-tenant (bypass RLS)
    //   - Idempotency records need cross-tenant visibility
    this.registry.addGlobalMiddleware(errorHandlerMiddleware);
    this.registry.addGlobalMiddleware(idempotencyMiddleware(this.prisma.admin));
    this.registry.addGlobalMiddleware(auditLogMiddleware(this.prisma.admin));

    // ─── Register tools ────────────────────────────────────────
    registerPartyTools(this.registry);
    registerDiscoveryTools(this.registry, this.prisma.admin);

    this.logger.log(
      `MCP Tool Server initialized with ${this.registry.names.length} tools: ` +
      this.registry.names.join(", ")
    );
  }

  /**
   * Build a ToolContext with injected services for a given request.
   * Called by the MCP transport adapter after validating JWT.
   */
  buildContext(overrides: {
    tenantId: string;
    userId: string;
    agentId?: string;
    conversationId?: string;
    idempotencyKey?: string;
  }) {
    // Validate tenant ID format before building context. This catches invalid
    // tenant IDs from forged JWT tokens before any database operations.
    validateTenantIdEnhanced(overrides.tenantId);

    // Validate userId — prevents null/empty user IDs in audit logs.
    if (!overrides.userId || overrides.userId.trim().length === 0) {
      throw new Error("McpModule.buildContext: userId is required and cannot be empty.");
    }

    return {
      ...overrides,
      services: {
        partyService: this.partyService,
      },
    };
  }

  /**
   * Get the tool registry.
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  static forRoot(): DynamicModule {
    return {
      module: McpModule,
      imports: [PrismaModule, PartyModule],
      providers: [
        McpModule,
        {
          provide: "TOOL_REGISTRY",
          useFactory: (mcpModule: McpModule) => mcpModule.getRegistry(),
          inject: [McpModule],
        },
      ],
      exports: ["TOOL_REGISTRY", McpModule],
    };
  }
}
