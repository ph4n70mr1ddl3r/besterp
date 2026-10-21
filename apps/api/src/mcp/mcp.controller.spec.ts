// Unit tests for the MCP HTTP transport.
//
// The transport is what makes the registered tool surface reachable at
// runtime: before it existed, `TOOL_REGISTRY` was provided and exported by
// `McpModule` and never injected anywhere, and `McpService.buildContext()`
// — the only place a `ToolContext` was ever constructed — had no production
// caller.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { Request as ExpressRequest } from "express";
import { McpController } from "./mcp.controller.js";
import { TOOL_REGISTRY } from "./mcp.tokens.js";
import type { ToolRegistry } from "@besterp/mcp-tools";

function createRegistry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getDiscoveryInfo: vi.fn().mockReturnValue([
      { name: "create_party", description: "Creates a party.", riskLevel: "high", entity: "party" },
    ]),
    execute: vi.fn().mockResolvedValue({ success: true, data: { partyId: "p1" } }),
    ...overrides,
  } as unknown as ToolRegistry;
}

function createMcpService() {
  return {
    buildContext: vi.fn().mockReturnValue({
      tenantId: "tenant-1",
      userId: "user-1",
      services: {},
    }),
  } as any;
}

function requestWithContext(tenantId = "tenant-1", userId = "user-1") {
  return { tenantContext: { tenantId, userId } } as unknown as ExpressRequest;
}

describe("McpController", () => {
  let registry: ToolRegistry;
  let mcpService: ReturnType<typeof createMcpService>;
  let controller: McpController;

  beforeEach(() => {
    registry = createRegistry();
    mcpService = createMcpService();
    controller = new McpController(mcpService, registry);
  });

  it("lists the registered tools", () => {
    const result = controller.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("create_party");
  });

  it("invokes a tool with the name in the body (MCP tools/call shape)", async () => {
    const result = await controller.call(requestWithContext(), {
      name: "create_party",
      arguments: { partyType: "PERSON" },
    });
    expect(result.success).toBe(true);
    expect(registry.execute).toHaveBeenCalledWith(
      "create_party",
      { partyType: "PERSON" },
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
    );
  });

  it("invokes a tool with the name in the path", async () => {
    await controller.callWithPathName(
      requestWithContext(),
      "create_party",
      { arguments: { partyType: "PERSON" } } as any,
    );
    expect(registry.execute).toHaveBeenCalledWith(
      "create_party",
      { partyType: "PERSON" },
      expect.anything(),
    );
  });

  it("takes the tenant and user identity from the JWT context, never from the body", async () => {
    await controller.call(requestWithContext("tenant-9", "user-9"), {
      name: "create_party",
      arguments: { partyType: "PERSON" },
    });
    const context = mcpService.buildContext.mock.calls[0]![0];
    expect(context.tenantId).toBe("tenant-9");
    expect(context.userId).toBe("user-9");
    // The request body must not be able to inject an identity.
    expect(context).not.toHaveProperty("idempotencyKey");
  });

  it("passes the agent's reasoning through to the context", async () => {
    await controller.call(requestWithContext(), {
      name: "create_party",
      arguments: {},
      reasoning: "The customer asked for a new contact.",
    });
    const context = mcpService.buildContext.mock.calls[0]![0];
    expect(context.reasoning).toBe("The customer asked for a new contact.");
  });

  it("refuses the call when the tenant context is missing", async () => {
    await expect(
      controller.call({} as ExpressRequest, { name: "create_party" }),
    ).rejects.toThrow(UnauthorizedException);
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("refuses the call when the tool name is missing", async () => {
    await expect(
      controller.call(requestWithContext(), { name: "" } as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("exports the registry token used for injection", () => {
    expect(TOOL_REGISTRY).toBe("TOOL_REGISTRY");
  });
});
