// Unit tests for ToolRegistry — tool registration, pipeline execution, Zod validation
// Tests the core registry mechanics: register, execute, middleware pipeline, discovery

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../registry/tool-registry.js";
import { ToolDefinition, ToolContext, ToolMiddleware } from "../schema/tool-definition.js";
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

    it("should reject a tool whose inputSchema lacks .safeParse()", () => {
      // The registry calls inputSchema.safeParse(input) when executing a
      // tool. A plain JSONSchema object (or any non-Zod schema) would
      // otherwise crash with `TypeError: ... .safeParse is not a function`
      // at first execution — far from the registration site. Failing
      // fast at registration time produces a clear error.
      const badTool: ToolDefinition = {
        name: "bad_schema_tool",
        description: "uses a plain JSONSchema object, not Zod",
        inputSchema: { type: "object", properties: { x: { type: "string" } } } as any,
        riskLevel: "none",
        handler: async () => ({ success: true }),
      };

      expect(() => registry.register(badTool)).toThrow(/invalid inputSchema/);
      expect(() => registry.register(badTool)).toThrow(/bad_schema_tool/);
    });

    it("should accept a tool whose inputSchema exposes .safeParse()", () => {
      // Positive case: any object with a safeParse method works. We don't
      // require it to be a Zod schema specifically — the contract is the
      // method, not the class.
      const customSchema = {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      };
      const customTool: ToolDefinition = {
        name: "custom_schema_tool",
        description: "uses a non-Zod schema that still exposes safeParse",
        inputSchema: customSchema as any,
        riskLevel: "none",
        handler: async () => ({ success: true }),
      };

      expect(() => registry.register(customTool)).not.toThrow();
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

    it("should sanitize URLs/paths embedded in validation issue messages", async () => {
      const handler = vi.fn();
      const schema = z.object({
        name: z.string().refine(() => false, { message: "bad value at https://secret.example.com/v1/key?api_key=sk_live_abc" }),
      });
      registry.register({
        name: "leaky_tool",
        description: "A tool whose schema echoes a secret URL in the issue message",
        inputSchema: schema,
        riskLevel: "low",
        handler,
      });

      const result = await registry.execute("leaky_tool", { name: "x" }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      const issues = result.error?.context?.issues as Array<{ message: string }> | undefined;
      expect(issues).toBeDefined();
      expect(JSON.stringify(issues)).not.toContain("sk_live_abc");
      expect(JSON.stringify(issues)).toContain("[HOST]/[PATH]");
    });

    it("should redact a secret value echoed in a validation issue under a sensitive-named path", async () => {
      const handler = vi.fn();
      // A custom errorMap echoes the received input (a pattern real schemas use).
      const schema = z.object({
        password: z.string().min(1).superRefine(() => {}),
      }).superRefine((val, ctx) => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["password"],
          message: "invalid password",
          // @ts-expect-error custom schema carrying the received value
          received: val.password,
        });
      });
      registry.register({
        name: "secret_tool",
        description: "A tool that echoes a secret field value into validation issues",
        inputSchema: schema,
        riskLevel: "low",
        handler,
      });

      const result = await registry.execute("secret_tool", { password: "hunter2" }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
      const issues = result.error?.context?.issues as Array<{ received?: string }> | undefined;
      expect(issues).toBeDefined();
      expect(issues!.some((i) => i.received === "[REDACTED]")).toBe(true);
      expect(JSON.stringify(issues)).not.toContain("hunter2");
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
      const suggested = result.error?.suggestedTools;
      expect(suggested).toBeDefined();
      expect(suggested!.length).toBeGreaterThan(1); // includes list_available_tools
    });
  });

  describe("tool name validation", () => {
    it("should reject non-snake_case tool names with camelCase", () => {
      expect(() => registry.register(makeTool("camelCase"))).toThrow(/snake_case/);
    });

    it("should reject non-snake_case tool names with hyphens", () => {
      expect(() => registry.register(makeTool("tool-name"))).toThrow(/snake_case/);
    });

    it("should reject tool names starting with __", () => {
      expect(() => registry.register(makeTool("__reserved"))).toThrow(/reserved prefix/);
    });

    it("should reject tool names with spaces", () => {
      expect(() => registry.register(makeTool("tool name"))).toThrow(/snake_case/);
    });
  });

  describe("idempotency key promotion", () => {
    it("should promote idempotencyKey from raw input into context", async () => {
      const handler = vi.fn().mockResolvedValue({ success: true, data: "ok" });
      const contextReceived: ToolContext[] = [];

      // Use a middleware that captures the context to verify promotion
      const captureMw: ToolMiddleware = async (_input, ctx, _def, next) => {
        contextReceived.push(ctx);
        return next(_input, ctx);
      };

      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "test_idem_tool",
        description: "test",
        inputSchema: z.object({ idempotencyKey: z.string() }),
        riskLevel: "low",
        handler,
      });

      await registry.execute(
        "test_idem_tool",
        { idempotencyKey: "key-from-input" },
        { tenantId: "t1", userId: "u1", services: {} },
      );

      expect(contextReceived[0].idempotencyKey).toBe("key-from-input");
      expect(handler).toHaveBeenCalled();
    });

    it("should not override context.idempotencyKey if already set", async () => {
      const contextReceived: ToolContext[] = [];
      const captureMw: ToolMiddleware = async (_input, ctx, _def, next) => {
        contextReceived.push(ctx);
        return next(_input, ctx);
      };

      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "test_idem_tool2",
        description: "test",
        inputSchema: z.object({ idempotencyKey: z.string() }),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      await registry.execute(
        "test_idem_tool2",
        { idempotencyKey: "from-input" },
        { tenantId: "t1", userId: "u1", idempotencyKey: "from-context", services: {} },
      );

      // Context value should win — input should not override it
      expect(contextReceived[0].idempotencyKey).toBe("from-context");
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
