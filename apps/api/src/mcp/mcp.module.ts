import {
  DynamicModule,
  Module,
} from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PartyModule } from "../modules/core/party/party.module.js";
import { McpService } from "./mcp.service.js";

export const TOOL_REGISTRY = "TOOL_REGISTRY";

@Module({})
export class McpModule {
  static forRoot(): DynamicModule {
    return {
      module: McpModule,
      imports: [PrismaModule, PartyModule],
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
