// Unit tests for the MCP HTTP transport.
//
// The transport is what makes the registered tool surface reachable at
// runtime: before it existed, `TOOL_REGISTRY` was provided and exported by
// `McpModule` and never injected anywhere, and `McpService.buildContext()`
// — the only place a `ToolContext` was ever constructed — had no production
// caller.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnauthorizedException, BadRequestException, ValidationPipe } from "@nestjs/common";
import type { Request as ExpressRequest } from "express";
import { McpController } from "./mcp.controller.js";
import { McpToolCallDto, McpToolCallPathDto } from "./mcp.dto.js";
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
    // The HTTP discovery endpoint delegates to the SAME builder the
    // `list_available_tools` MCP tool uses, so the payload includes the
    // `confirmationRequired` flag.
    getDiscoveryPayload: vi.fn().mockResolvedValue({
      tools: [
        { name: "create_party", description: "Creates a party.", riskLevel: "high", entity: "party", confirmationRequired: true },
      ],
      totalAvailable: 1,
      note: "note",
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

  it("lists the registered tools", async () => {
    const result = await controller.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("create_party");
    // The HTTP discovery payload must carry the same `confirmationRequired`
    // flag the `list_available_tools` MCP tool reports — otherwise an HTTP
    // client cannot learn that a write tool needs a confirmation until it is
    // rejected with CONFIRMATION_REQUIRED on its first write.
    expect(result.tools[0]!.confirmationRequired).toBe(true);
    expect(result.totalAvailable).toBe(1);
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

  it("ACCEPTS a body without a name on the path route (the global ValidationPipe)", async () => {
    // Regression guard (round 273): the path route reused the body DTO, whose
    // `name` is a REQUIRED property. The global ValidationPipe therefore
    // rejected EVERY request to `POST /api/mcp/tools/:name` with "name must
    // be a string" (HTTP 400) — the tool name is in the URL, so a body that
    // omits it is exactly the intended request shape. One of the three
    // documented MCP entry points was dead in production.
    //
    // The test drives the REAL ValidationPipe, exactly as main.ts installs
    // it, so the DTO constraint is exercised rather than bypassed.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const body = { arguments: { partyType: "PERSON" } };

    const validated = await pipe.transform(body, { type: "body", metatype: McpToolCallPathDto });
    expect(validated).toEqual(body);

    await controller.callWithPathName(requestWithContext(), "create_party", validated as any);
    expect(registry.execute).toHaveBeenCalledWith(
      "create_party",
      { partyType: "PERSON" },
      expect.anything(),
    );
  });

  it("still REQUIRES a name on the body route", async () => {
    // The body route has no path parameter to fall back to, so `name` stays
    // mandatory there.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(
      pipe.transform({ arguments: {} }, { type: "body", metatype: McpToolCallDto }),
    ).rejects.toThrow();
  });

  it("rejects a body whose name disagrees with the path", async () => {
    // The previous behaviour silently preferred the path and ignored the
    // body, so a client that disagreed with itself got a different tool
    // executed than the one it asked for in the body.
    await expect(
      controller.callWithPathName(requestWithContext(), "create_party", {
        name: "delete_party",
        arguments: {},
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("accepts a body whose name AGREES with the path", async () => {
    await controller.callWithPathName(requestWithContext(), "create_party", {
      name: "create_party",
      arguments: { partyType: "PERSON" },
    } as any);
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
    // A missing tool name is a MALFORMED REQUEST, not an authentication
    // failure — the caller IS authenticated at this point. Answering 401
    // sent the client looking for a credential problem that did not exist.
    await expect(
      controller.call(requestWithContext(), { name: "" } as any),
    ).rejects.toThrow(BadRequestException);
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("exports the registry token used for injection", () => {
    expect(TOOL_REGISTRY).toBe("TOOL_REGISTRY");
  });
});
