// Unit tests for ToolRegistry — tool registration, pipeline execution, Zod validation
// Tests the core registry mechanics: register, execute, middleware pipeline, discovery

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../registry/tool-registry.js";
import { ToolDefinition, ToolResult, ToolContext, ToolMiddleware } from "../schema/tool-definition.js";
import { z } from "zod";

const mockContext: ToolContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  services: {},
};

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    it("should register a tool and list its name", () => {
      const tool = makeTool("test_tool");
      registry.register(tool);
      expect(registry.names).toEqual(["test_tool"]);
    });

    it("should throw on duplicate registration", () => {
      registry.register(makeTool("test_tool"));
      expect(() => registry.register(makeTool("test_tool"))).toThrow("already registered");
    });

    it("should register multiple tools", () => {
      registry.register(makeTool("tool_a"));
      registry.register(makeTool("tool_b"));
      registry.register(makeTool("tool_c"));
      expect(registry.names).toEqual(["tool_a", "tool_b", "tool_c"]);
    });
  });

  describe("get", () => {
    it("should return undefined for unknown tool", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("should return registered entry", () => {
      const tool = makeTool("my_tool");
      registry.register(tool);
      const entry = registry.get("my_tool");
      expect(entry?.definition).toBe(tool);
    });
  });

  describe("execute", () => {
    it("should return UNKNOWN_TOOL for missing tool", async () => {
      const result = await registry.execute("ghost", {}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN_TOOL");
      expect(result.error?.suggestedTools).toContain("list_available_tools");
    });

    it("should execute a tool with valid Zod input", async () => {
      const handler = vi.fn().mockResolvedValue({ success: true, data: { name: "result" } });
      registry.register({
        name: "create_item",
        description: "Creates an item",
        inputSchema: z.object({ name: z.string().min(1) }),
        riskLevel: "low",
        handler,
      });

      const result = await registry.execute("create_item", { name: "Widget" }, mockContext);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "result" });
      expect(handler).toHaveBeenCalledWith({ name: "Widget" }, mockContext);
    });

    it("should reject invalid input via Zod schema", async () => {
      const handler = vi.fn();
      registry.register({
        name: "strict_tool",
        description: "A strict tool",
        inputSchema: z.object({ count: z.number().int().min(1).max(10) }),
        riskLevel: "low",
        handler,
      });

      const result = await registry.execute("strict_tool", { count: 999 }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("count");
      expect(handler).not.toHaveBeenCalled();
    });

    it("should run global middlewares before handler", async () => {
      const order: string[] = [];
      const mw: ToolMiddleware = async (input, ctx, def, next) => {
        order.push("mw1");
        const result = await next(input, ctx);
        order.push("mw1-after");
        return result;
      };

      registry.addGlobalMiddleware(mw);
      registry.register({
        name: "test",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "none",
        handler: async () => {
          order.push("handler");
          return { success: true, data: "ok" };
        },
      });

      await registry.execute("test", {}, mockContext);
      expect(order).toEqual(["mw1", "handler", "mw1-after"]);
    });

    it("should run global middlewares before tool-specific middlewares", async () => {
      const order: string[] = [];
      const globalMw: ToolMiddleware = async (input, ctx, def, next) => {
        order.push("global");
        return next(input, ctx);
      };
      const toolMw: ToolMiddleware = async (input, ctx, def, next) => {
        order.push("tool");
        return next(input, ctx);
      };

      registry.addGlobalMiddleware(globalMw);
      registry.register(
        {
          name: "test",
          description: "test",
          inputSchema: z.object({}),
          riskLevel: "none",
          handler: async () => {
            order.push("handler");
            return { success: true };
          },
        },
        [toolMw],
      );

      await registry.execute("test", {}, mockContext);
      expect(order).toEqual(["global", "tool", "handler"]);
    });
  });

  describe("getDiscoveryInfo", () => {
    it("should return first-line description for each tool", () => {
      registry.register({
        name: "tool_a",
        description: "First line.\nSecond line.",
        inputSchema: z.object({}),
        riskLevel: "low",
        entity: "party",
        tags: ["create"],
        handler: async () => ({ success: true }),
      });

      const info = registry.getDiscoveryInfo();
      expect(info).toHaveLength(1);
      expect(info[0].description).toBe("First line.");
      expect(info[0].entity).toBe("party");
      expect(info[0].tags).toEqual(["create"]);
    });
  });

  describe("findSimilarNames (hallucination guard)", () => {
    it("should suggest similar tool names for hallucinated requests", async () => {
      registry.register(makeTool("create_party"));
      registry.register(makeTool("search_parties"));
      registry.register(makeTool("get_party"));

      const result = await registry.execute("create_parties", {}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN_TOOL");
      // Should suggest at least one similar tool
      expect(result.error?.suggestedTools!.length).toBeGreaterThan(1); // includes list_available_tools
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: z.object({}),
    riskLevel: "none",
    handler: async () => ({ success: true, data: name }),
  };
}
