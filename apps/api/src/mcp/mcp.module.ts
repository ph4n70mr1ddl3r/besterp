// MCP Module — Tool server with middleware pipeline.
//
// Registers the MCP tool registry with the full middleware stack:
//   1. errorHandlerMiddleware (outermost — catches all exceptions)
//   2. auditLogMiddleware (fire-and-forget durable audit writes)
//   3. idempotencyMiddleware (deduplication via DB-backed records)
//   4. Tool-specific middlewares (registered per-tool)
//   5. Handler (Zod validation → service call)
//
// Tools are registered in McpService.onModuleInit() after the module
// wiring is complete, so the registry factory can resolve services.

import {
  DynamicModule,
  Module,
} from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PartyModule } from "../modules/core/party/party.module.js";
import { SecurityModule } from "../modules/core/security/security.module.js";
import { ProductModule } from "../modules/core/product/product.module.js";
import { McpService } from "./mcp.service.js";

export const TOOL_REGISTRY = "TOOL_REGISTRY";

@Module({})
export class McpModule {
  static forRoot(): DynamicModule {
    return {
      module: McpModule,
      imports: [PrismaModule, PartyModule, SecurityModule, ProductModule],
      providers: [
        McpService,
        {
          provide: TOOL_REGISTRY,
          useFactory: (mcpService: McpService) => mcpService.getRegistry(),
          inject: [McpService],
        },
      ],
      exports: [TOOL_REGISTRY],
    };
  }
}
