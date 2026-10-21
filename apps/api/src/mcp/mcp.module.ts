// MCP Module — Tool server with middleware pipeline.
//
// Registers the MCP tool registry with the full middleware stack:
//   1. errorHandlerMiddleware (outermost — catches all exceptions)
//   2. auditLogMiddleware (fire-and-forget durable audit writes)
//   3. confirmationGateMiddleware (high/critical-risk confirmation)
//   4. idempotencyMiddleware (deduplication via DB-backed records)
//   5. Tool-specific middlewares (registered per-tool)
//   6. Handler (Zod validation → service call)
//
// The confirmation gate MUST sit between the audit log and the idempotency
// middleware: a request rejected for a missing/invalid confirmation must not
// consume the caller's idempotency key. See McpService.onModuleInit for the
// full rationale.
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
import { McpController } from "./mcp.controller.js";
import { TOOL_REGISTRY } from "./mcp.tokens.js";

// Re-exported so `import { TOOL_REGISTRY } from "./mcp.module.js"` keeps
// working for existing consumers; the constant itself lives in
// `mcp.tokens.ts` so the module and the controller can both use it without
// importing each other.
export { TOOL_REGISTRY };

@Module({})
export class McpModule {
  static forRoot(): DynamicModule {
    return {
      module: McpModule,
      imports: [PrismaModule, PartyModule, SecurityModule, ProductModule],
      // The HTTP transport that makes the tool registry reachable at
      // runtime. Without it the registry — and the whole middleware pipeline
      // that makes it safe — was dead code.
      controllers: [McpController],
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
