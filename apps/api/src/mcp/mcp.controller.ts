// MCP Controller — HTTP transport for the MCP tool registry.
//
// The MCP tool registry is the documented PRIMARY agent interface
// (ADR-001: "Every business operation is an MCP tool"), and the README
// lists the 21 registered tools as the way an agent talks to the system.
//
// Until now NOTHING could invoke them: `McpModule` provided and exported
// the `TOOL_REGISTRY` token and nothing ever injected it, and
// `McpService.buildContext()` — the only place a `ToolContext` was ever
// constructed — had no production caller. The entire tool surface, and the
// middleware pipeline that makes it safe (confirmation gate, idempotency
// dedup, durable audit trail, agent-facing redaction), was unreachable at
// runtime.
//
// This controller is the transport that closes the gap.
//
// Request shape (mirrors the MCP `tools/call` request):
//
//   POST /api/mcp/tools/call
//   {
//     "name": "create_party",
//     "arguments": { "partyType": "PERSON", "name": "Jane", ...,
//                    "idempotencyKey": "...", "confirmation": "..." },
//     "reasoning": "Why the agent is making this call"
//   }
//
// Auth: the global JwtAuthGuard + TenantGuard apply, so the tenant and
// user identity come from the validated JWT — NEVER from the request body.
// The caller cannot choose the tenant it acts in.
//
// Response: the tool result verbatim (`{ success, data | error,
// nextActions }`). The HTTP status reports the TRANSPORT outcome (the call
// was delivered and executed); the tool's own outcome is in the body —
// which is the MCP convention (`tools/call` reports tool errors in the
// result, not as a transport error). A genuine transport failure (a missing
// tenant context) still produces the usual HTTP error status through the
// global DomainExceptionFilter.

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Request,
  Inject,
  HttpCode,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request as ExpressRequest } from "express";
import { ToolRegistry, type ToolResult } from "@besterp/mcp-tools";
import { McpService } from "./mcp.service.js";
import { TOOL_REGISTRY } from "./mcp.tokens.js";
import { McpToolCallDto } from "./mcp.dto.js";

@Controller("mcp")
export class McpController {
  constructor(
    private readonly mcpService: McpService,
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry,
  ) {}

  /**
   * List the registered tools.
   *
   * The same discovery payload the `list_available_tools` MCP tool returns,
   * exposed over HTTP for clients that want to enumerate the surface before
   * authenticating a conversation.
   */
  @Get("tools")
  listTools(): { tools: ReturnType<ToolRegistry["getDiscoveryInfo"]> } {
    return { tools: this.registry.getDiscoveryInfo() };
  }

  /**
   * Invoke a tool using the MCP `tools/call` request shape (the tool name
   * is in the body).
   *
   * This route is declared BEFORE the `:name` route so it is matched first
   * — Nest registers routes in declaration order, and `tools/call` is more
   * specific than `tools/:name`.
   */
  @Post("tools/call")
  @HttpCode(200)
  async call(@Request() req: ExpressRequest, @Body() body: McpToolCallDto): Promise<ToolResult> {
    return this.invoke(req, body?.name, body);
  }

  /**
   * Invoke a tool using the tool name in the path — a convenience for
   * clients that cannot send a body.
   */
  @Post("tools/:name")
  @HttpCode(200)
  async callWithPathName(
    @Request() req: ExpressRequest,
    @Param("name") name: string,
    @Body() body: McpToolCallDto,
  ): Promise<ToolResult> {
    return this.invoke(req, name, body);
  }

  private async invoke(
    req: ExpressRequest,
    name: string | undefined,
    body: McpToolCallDto | undefined,
  ): Promise<ToolResult> {
    if (!name) {
      throw new UnauthorizedException("MCP tool name is required.");
    }

    const tenantContext = req.tenantContext;
    if (!tenantContext?.tenantId || !tenantContext.userId) {
      throw new UnauthorizedException("Tenant context is missing. Authentication failed.");
    }

    // The identity comes from the validated JWT — never from the request
    // body — so a caller cannot act in another tenant's scope.
    const context = this.mcpService.buildContext({
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId,
      agentId: tenantContext.agentId,
      reasoning: body?.reasoning,
    });

    // The arguments are passed through UNVALIDATED on purpose: the tool's
    // own Zod schema is the validation boundary for MCP tools (the REST
    // endpoints use class-validator DTOs instead). The registry strips the
    // envelope keys and promotes them into the context before validation.
    return this.registry.execute(name, body?.arguments ?? {}, context);
  }
}
