// Unit tests for ToolRegistry — tool registration, pipeline execution, Zod validation
// Tests the core registry mechanics: register, execute, middleware pipeline, discovery

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../registry/tool-registry.js";
import { ToolDefinition, ToolContext, ToolMiddleware } from "../schema/tool-definition.js";
import { z } from "zod";
import { InvalidTypeValueError, MAX_ERROR_MESSAGE_LENGTH } from "@besterp/shared";
import { errorHandlerMiddleware } from "../middleware/error-handler.js";

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

    it("should reject a schema that accepts the object probe but has a non-compliant error shape on null", () => {
      // Regression (round 166): a schema that accepts arbitrary objects
      // (like z.any()) passes the object probe successfully, so the
      // original guard skipped shape validation entirely. A real
      // validation failure on a scalar would then produce an error
      // without .issues and crash at parsed.error.issues.map(...).
      // The second null probe now catches this class of schema.
      const badSchema = {
        safeParse: (input: unknown) => {
          if (typeof input === "object" && input !== null) {
            return { success: true, data: input };
          }
          return { success: false, error: { message: "must be an object" } };
        },
      };
      const tool: ToolDefinition = {
        name: "bad_shape_tool",
        description: "schema accepts objects but has bad error shape",
        inputSchema: badSchema as any,
        riskLevel: "none",
        handler: async () => ({ success: true }),
      };

      expect(() => registry.register(tool)).toThrow(/inputSchema.safeParse.*issues/);
    });

    it("should accept a schema where both probes succeed (z.any()-like)", () => {
      // A schema that accepts everything (like z.any()) passes both probes
      // with success:true, so no error shape exists to validate. This is
      // safe because validation never fails, so parsed.error is never accessed.
      const anySchema = {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      };
      const tool: ToolDefinition = {
        name: "any_tool",
        description: "accepts any input",
        inputSchema: anySchema as any,
        riskLevel: "none",
        handler: async () => ({ success: true }),
      };

      expect(() => registry.register(tool)).not.toThrow();
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

    it("returns a structured error for a NON-STRING tool name instead of throwing", async () => {
      // `name` is typed `string`, but `execute` is an exported entry point
      // and the value can come from a caller that does not honour the type.
      // The old code reached `name.toLowerCase()` inside findSimilarNames()
      // and threw a raw TypeError that ESCAPED execute() entirely — the
      // errorHandlerMiddleware sits inside the pipeline and can only convert
      // errors raised by a middleware or the handler.
      for (const bad of [123, null, undefined, {}, []]) {
        const result = await registry.execute(bad as never, {}, mockContext);
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNKNOWN_TOOL");
      }
    });

    it("caps the UNKNOWN_TOOL message and context at the agent-facing bound", async () => {
      // `sanitizeForLogOutput` only truncates at its own 100 KB internal
      // guard, so a 120 KB tool name produced a 100 KB agent-facing response
      // — 50x the documented MAX_ERROR_MESSAGE_LENGTH bound that every other
      // agent-facing error surface honours.
      const huge = "x".repeat(120_000);
      const result = await registry.execute(huge, {}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.message!.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH + 1);
      expect(String(result.error?.context?.requestedTool).length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH + 1);
    });

    it("passes a NON-OBJECT input through to the tool's own schema", async () => {
      // The raw input was nulled for every non-object input before
      // validation, so a tool whose schema is not an object was uncallable
      // and the agent got a misleading "expected array, received null".
      const arrayRegistry = new ToolRegistry();
      const handler = vi.fn().mockResolvedValue({ success: true, data: "ok" });
      arrayRegistry.register({
        name: "list_things",
        description: "takes an array",
        inputSchema: z.array(z.string()),
        riskLevel: "none",
        entity: "thing",
        tags: ["test"],
        handler,
      });
      const result = await arrayRegistry.execute("list_things", ["a", "b"], mockContext);
      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledWith(["a", "b"], expect.anything());
    });

    it("reports the ACTUAL input in the validation error for a non-object input", async () => {
      const arrayRegistry = new ToolRegistry();
      arrayRegistry.register({
        name: "list_things",
        description: "takes an array",
        inputSchema: z.array(z.string()),
        riskLevel: "none",
        entity: "thing",
        tags: ["test"],
        handler: vi.fn().mockResolvedValue({ success: true, data: "ok" }),
      });
      const result = await arrayRegistry.execute("list_things", 42, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.message).not.toContain("received null");
    });

    it("should sanitize a crafted unknown tool name before reflecting it", async () => {
      // Regression guard (round 48): the requested tool name is
      // attacker-controlled and the UNKNOWN_TOOL result bypasses
      // errorHandlerMiddleware, so a name embedding a secret-bearing URL
      // reached the agent unsanitized. Now the name is run through
      // sanitizeForLogOutput before being reflected in the message / context.
      const malicious = "https://api.example.com/v1/x?api_key=sk_live_abc123";
      const result = await registry.execute(malicious, {}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN_TOOL");
      const serialized = JSON.stringify(result.error);
      // The credential-bearing URL is collapsed to [HOST]/[PATH] and the
      // secret is scrubbed rather than reflected verbatim to the agent.
      expect(serialized).not.toContain("api.example.com");
      expect(serialized).not.toContain("sk_live_abc123");
      expect(serialized).toContain("[HOST]/[PATH]");
    });

    it("should reject an invalid agentId before executing the handler", async () => {
      // agentId/conversationId are persisted verbatim into the cross-tenant
      // durable idempotency + audit sinks, so they must be validated at the
      // auth boundary like tenantId/userId (not reflected, fail closed).
      const result = await registry.execute("list_available_tools", {}, {
        ...mockContext,
        agentId: "bad agent id!",
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_CONTEXT_ID");
      expect(JSON.stringify(result.error)).not.toContain("bad agent id!");
    });

    it("should reject an invalid conversationId before executing the handler", async () => {
      const result = await registry.execute("list_available_tools", {}, {
        ...mockContext,
        conversationId: "x".repeat(201),
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_CONTEXT_ID");
    });

    it("should reject zero-width/bidi characters in identity fields (round 172)", async () => {
      // JS \s does NOT cover zero-width joiners or bidi overrides, so a
      // userId like "user\u200b1" previously passed OPTIONAL_ID_PATTERN.
      // Two visually-identical IDs then hash to different idempotency
      // composite keys and confuse log/audit correlation.
      const zw = await registry.execute("list_available_tools", {}, {
        ...mockContext,
        userId: "user\u200b1",
      });
      expect(zw.success).toBe(false);
      expect(zw.error?.code).toBe("INVALID_USER_ID");

      const bidi = await registry.execute("list_available_tools", {}, {
        ...mockContext,
        agentId: "agent\u202Eevil",
      });
      expect(bidi.success).toBe(false);
      expect(bidi.error?.code).toBe("INVALID_CONTEXT_ID");

      const bom = await registry.execute("list_available_tools", {}, {
        ...mockContext,
        conversationId: "conv\ufeff1",
      });
      expect(bom.success).toBe(false);
      expect(bom.error?.code).toBe("INVALID_CONTEXT_ID");
    });

    it("should trim a whitespace-padded agentId instead of rejecting it (identity-field consistency)", async () => {
      // userId is accepted-after-trim; agentId/conversationId previously
      // validated the UNTRIMMED value, so " agent-1" was hard-rejected while
      // " user-1" was accepted — an inconsistency between same-shaped fields.
      const contexts: ToolContext[] = [];
      registry.register({
        name: "capture_agent_tool",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "none",
        handler: async (_i: unknown, ctx: ToolContext) => {
          contexts.push(ctx);
          return { success: true, data: "ok" };
        },
      });
      const result = await registry.execute("capture_agent_tool", {}, {
        ...mockContext,
        agentId: "  agent-1  ",
        conversationId: " conv-1 ",
      });
      expect(result.success).toBe(true);
      // Trimmed values must propagate (same contract as tenantId/userId) so
      // durable audit/idempotency rows store the validated form.
      expect(contexts[0].agentId).toBe("agent-1");
      expect(contexts[0].conversationId).toBe("conv-1");
    });

    it("should reject a malformed tenantId before executing the handler", async () => {
      // tenantId is the primary isolation boundary. A malformed value here is
      // a cross-tenant access path, so the registry must fail closed with a
      // non-enumerating error that echoes nothing back to the caller.
      const result = await registry.execute("list_available_tools", {}, {
        tenantId: "'; DROP TABLE party;--",
        userId: "user-1",
        services: {},
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_TENANT_ID");
      expect(JSON.stringify(result.error)).not.toContain("DROP TABLE");
    });

    it("should reject a non-string userId before executing the handler", async () => {
      // userId is persisted into durable audit/idempotency sinks; it must be
      // a validated string before any middleware or handler runs.
      const result = await registry.execute("list_available_tools", {}, {
        tenantId: "tenant-1",
        userId: 42 as unknown as string,
        services: {},
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_USER_ID");
    });

    it("should reject a whitespace-only userId before executing the handler", async () => {
      const result = await registry.execute("list_available_tools", {}, {
        tenantId: "tenant-1",
        userId: "   ",
        services: {},
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_USER_ID");
    });

    it("should accept a whitespace-padded userId and trim it before executing the handler", async () => {
      // Regression guard: validateContextIdentity previously rejected any
      // userId with leading/trailing whitespace, inconsistent with
      // McpService.buildContext and TenantGuard which both trim and accept.
      const handler = vi.fn().mockResolvedValue({ success: true, data: {} });
      registry.register({
        name: "noop",
        description: "No-op tool",
        inputSchema: z.object({}),
        riskLevel: "none",
        handler,
      });
      const result = await registry.execute("noop", {}, {
        tenantId: "tenant-1",
        userId: "  user-1  ",
        services: {},
      });
      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalled();
    });

    it("should propagate TRIMMED tenantId/userId to middlewares and handlers, not the padded originals", async () => {
      // Regression (round 150): validateContextIdentity trimmed for
      // validation but discarded the trimmed values, so the untrimmed
      // context reached the idempotency composite key and audit rows while
      // handlers' RLS path trimmed via withTenant — the idempotency record
      // was keyed under a different tenant string than the query executed
      // under, and a correctly trimmed retry missed it and re-executed
      // the write.
      const seen: Array<{ tenantId?: string; userId?: string }> = [];
      const trackingMiddleware: ToolMiddleware = async (input, ctx, _def, next) => {
        seen.push({ tenantId: ctx.tenantId, userId: ctx.userId });
        return next(input, ctx);
      };
      registry.addGlobalMiddleware(trackingMiddleware);
      registry.register({
        name: "noop",
        description: "No-op tool",
        inputSchema: z.object({}),
        riskLevel: "none",
        handler: async (_input, ctx) => {
          seen.push({ tenantId: ctx.tenantId, userId: ctx.userId });
          return { success: true, data: {} };
        },
      });
      const result = await registry.execute("noop", {}, {
        tenantId: "  tenant-1  ",
        userId: "  user-1  ",
        services: {},
      });
      expect(result.success).toBe(true);
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.tenantId).toBe("tenant-1");
        expect(s.userId).toBe("user-1");
      }
    });

    it("should accept valid optional agentId/conversationId and reach the handler", async () => {
      const handler = vi.fn().mockResolvedValue({ success: true, data: {} });
      registry.register({
        name: "noop",
        description: "No-op tool",
        inputSchema: z.object({}),
        riskLevel: "none",
        handler,
      });
      const result = await registry.execute("noop", {}, {
        ...mockContext,
        agentId: "agent-9",
        conversationId: "conv-42",
      });
      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalled();
    });

    it("should validate agentId first, then conversationId, and reject the first invalid field found (round 124 readability refactor)", async () => {
      // Both agentId and conversationId are invalid, but the agentId path
      // must be evaluated first. The previous `??` form produced the same
      // result but was harder to read; the explicit if/else form used
      // today preserves the same short-circuit semantics.
      const result = await registry.execute("list_available_tools", {}, {
        ...mockContext,
        agentId: "bad agent!",
        conversationId: "also bad!",
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_CONTEXT_ID");
      // The error must reference the agentId field, not conversationId,
      // because agentId is checked first and the short-circuit returns.
      expect(result.error?.message).toContain("agentId");
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

      // Regression (round 50): the joined top-level `message` was only
      // length-capped, not sanitized, so the secret reached the agent while
      // `context.issues` redacted it — an asymmetric secret-leak. The whole
      // agent-facing message must be scrubbed too.
      expect(result.error?.message).toBeDefined();
      expect(result.error?.message).not.toContain("sk_live_abc");
      expect(result.error?.message).toContain("[HOST]/[PATH]");
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
    it("should return the full multi-line description for each tool", () => {
      registry.register({
        name: "tool_a",
        description: "First line.\nSecond line of details.",
        inputSchema: z.object({}),
        riskLevel: "low",
        entity: "party",
        tags: ["create"],
        handler: async () => ({ success: true }),
      });

      const info = registry.getDiscoveryInfo();
      expect(info).toHaveLength(1);
      // Full description preserved (was previously truncated to first line).
      expect(info[0].description).toBe("First line.\nSecond line of details.");
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

  describe("execute-time envelope stripping and context identity guards", () => {
    it("should strip the idempotencyKey envelope BEFORE middleware runs (strict-schema hash regression)", async () => {
      // Regression: the idempotency middleware computes its input hash via
      // `definition.inputSchema.safeParse(input)`. Since all tool schemas
      // became z.strictObject, an input still carrying the promoted
      // `idempotencyKey` envelope failed that parse, the middleware logged
      // "input failed Zod validation" and SKIPPED deduplication entirely —
      // every idempotent call silently lost its protection. The envelope
      // must be stripped in execute() BEFORE the pipeline runs, not only at
      // the final Zod step.
      const inputsSeenByMiddleware: unknown[] = [];
      const captureMw: ToolMiddleware = async (input, ctx, _def, next) => {
        inputsSeenByMiddleware.push(input);
        return next(input, ctx);
      };
      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "strict_idem_tool",
        description: "test",
        inputSchema: z.strictObject({ name: z.string() }),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      const result = await registry.execute(
        "strict_idem_tool",
        { name: "x", idempotencyKey: "key-1" },
        { tenantId: "t1", userId: "u1", services: {} },
      );

      expect(result.success).toBe(true);
      expect(inputsSeenByMiddleware).toEqual([{ name: "x" }]);
    });

    it("should return INVALID_CONTEXT_ID for a non-string agentId instead of throwing", async () => {
      // Regression: validateOptionalIdentityField called .trim() BEFORE its
      // typeof guard, so a direct JS caller constructing a ToolContext with
      // agentId: 123 crashed with a raw TypeError out of execute() — before
      // any middleware could convert it to a structured error.
      registry.register(makeTool("agent_probe_tool"));
      const result = await registry.execute(
        "agent_probe_tool",
        {},
        { tenantId: "t1", userId: "u1", agentId: 123 as unknown as string, services: {} },
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("INVALID_CONTEXT_ID");
        expect(result.error.message).toContain("agentId");
      }
    });

    it("should not throw for a null conversationId (treated as absent)", async () => {
      registry.register(makeTool("conv_probe_tool"));
      const result = await registry.execute(
        "conv_probe_tool",
        {},
        { tenantId: "t1", userId: "u1", conversationId: null as unknown as string, services: {} },
      );
      expect(result.success).toBe(true);
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
        inputSchema: z.object({}),
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
        inputSchema: z.object({}),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      await registry.execute(
        "test_idem_tool2",
        { idempotencyKey: "from-context" },
        { tenantId: "t1", userId: "u1", idempotencyKey: "from-context", services: {} },
      );

      // Context value should win — input should not override it
      expect(contextReceived[0].idempotencyKey).toBe("from-context");
    });

    it("should reject two conflicting idempotency keys instead of silently preferring one", async () => {
      // Regression: the registry silently preferred the context key and
      // discarded the tool-argument key, so the agent believed it deduplicated
      // under one key while the durable idempotency record was keyed by the
      // other. Fail closed with a structured error instead.
      const handler = vi.fn(async () => ({ success: true }));
      registry.register({
        name: "test_idem_conflict",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "low",
        handler,
      });

      const result = await registry.execute(
        "test_idem_conflict",
        { idempotencyKey: "from-input" },
        { tenantId: "t1", userId: "u1", idempotencyKey: "from-context", services: {} },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
      expect(handler).not.toHaveBeenCalled();
    });

    it("should treat an EMPTY-STRING context key as 'no key' and adopt the argument key", async () => {
      // Regression: the conflict check used `context.idempotencyKey != null`
      // and the promotion used `!context.idempotencyKey` — two different
      // notions of "absent". An empty-string context key was therefore
      // simultaneously "present" (conflict check) and "absent" (promotion),
      // so a legitimate argument key produced a hard
      // IDEMPOTENCY_KEY_MISMATCH. The idempotency middleware itself treats
      // "" as a pass-through no-op, so "" must mean "no key" everywhere.
      const contextReceived: ToolContext[] = [];
      const captureMw: ToolMiddleware = async (_input, ctx, _def, next) => {
        contextReceived.push(ctx);
        return next(_input, ctx);
      };

      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "test_idem_empty_context_key",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      const result = await registry.execute(
        "test_idem_empty_context_key",
        { idempotencyKey: "key-from-input" },
        { tenantId: "t1", userId: "u1", idempotencyKey: "", services: {} },
      );

      expect(result.success).toBe(true);
      expect(contextReceived[0].idempotencyKey).toBe("key-from-input");
    });

    it("should promote an over-length idempotencyKey so the middleware fails closed", async () => {
      // Regression: the promotion guard previously dropped out-of-contract
      // keys (over-length, empty) instead of promoting them, which silently
      // disabled idempotency protection (the middleware no-ops when context
      // has no key) instead of returning INVALID_IDEMPOTENCY_KEY.
      const contextReceived: ToolContext[] = [];
      const captureMw: ToolMiddleware = async (_input, ctx, _def, next) => {
        contextReceived.push(ctx);
        return next(_input, ctx);
      };

      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "test_idem_tool3",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      await registry.execute(
        "test_idem_tool3",
        { idempotencyKey: "x".repeat(600) },
        { tenantId: "t1", userId: "u1", services: {} },
      );

      // The over-length key must reach the middleware (fail closed), not be
      // dropped so idempotency silently becomes a no-op.
      expect(contextReceived[0].idempotencyKey).toBe("x".repeat(600));
    });

    it("should promote an empty idempotencyKey so the middleware fails closed", async () => {
      const contextReceived: ToolContext[] = [];
      const captureMw: ToolMiddleware = async (_input, ctx, _def, next) => {
        contextReceived.push(ctx);
        return next(_input, ctx);
      };

      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "test_idem_tool4",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      await registry.execute(
        "test_idem_tool4",
        { idempotencyKey: "" },
        { tenantId: "t1", userId: "u1", services: {} },
      );

      expect(contextReceived[0].idempotencyKey).toBe("");
    });

    it("should promote a NON-STRING idempotencyKey so the middleware fails closed (round 174)", async () => {
      // Regression: the promotion gate previously required
      // `typeof raw.idempotencyKey === "string"`, so a caller passing a
      // numeric/boolean/object key had its envelope silently stripped by
      // stripEnvelopeKeys() while the call executed WITHOUT
      // idempotency protection — the exact silent-loss class the fail-closed
      // contract exists to prevent. The idempotency middleware validates the
      // key as `unknown` and rejects non-strings with INVALID_IDEMPOTENCY_KEY,
      // so any present value must reach it.
      const inputsSeenByMiddleware: unknown[] = [];
      const contextReceived: ToolContext[] = [];
      const captureMw: ToolMiddleware = async (input, ctx, _def, next) => {
        inputsSeenByMiddleware.push(input);
        contextReceived.push(ctx);
        return next(input, ctx);
      };

      registry.addGlobalMiddleware(captureMw);
      registry.register({
        name: "test_idem_tool5",
        description: "test",
        inputSchema: z.object({}),
        riskLevel: "low",
        handler: async () => ({ success: true }),
      });

      await registry.execute(
        "test_idem_tool5",
        { idempotencyKey: 12345 },
        { tenantId: "t1", userId: "u1", services: {} },
      );

      // The non-string key must reach the middleware (fail closed), not be
      // dropped so idempotency silently becomes a no-op...
      expect(contextReceived[0].idempotencyKey).toBe(12345);
      // ...and the envelope must still be stripped from the input so strict
      // schemas see schema-conformant data.
      expect(inputsSeenByMiddleware).toEqual([{}]);
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

// ─── Structured errors thrown from a schema transform ──────────────

describe("ToolRegistry — a DomainError thrown inside a Zod transform", () => {
  it("surfaces as INVALID_TYPE_VALUE, not INTERNAL_ERROR", async () => {
    // `stripHtmlTags` is used inside Zod `.transform()` calls. A Zod
    // transform that THROWS does not produce a ZodIssue — the exception
    // escapes `safeParse` entirely. `stripHtmlTags` used to throw a plain
    // `Error` for over-long input, which the error handler reported as an
    // opaque INTERNAL_ERROR (a server fault) even though the cause was a
    // client-supplied over-long value. It now throws a structured
    // InvalidTypeValueError.
    const registry = new ToolRegistry();
    registry.addGlobalMiddleware(errorHandlerMiddleware);
    registry.register({
      name: "transform_tool",
      description: "A tool whose schema transform can throw.",
      inputSchema: z.strictObject({
        value: z.string().transform((v) => {
          if (v.length > 10) throw new InvalidTypeValueError("'value' is too long.");
          return v;
        }),
      }),
      riskLevel: "none",
      entity: "test",
      handler: async () => ({ success: true, data: "ok" }),
    });

    const result = await registry.execute(
      "transform_tool",
      { value: "x".repeat(50) },
      { tenantId: "tenant-1", userId: "user-1", services: {} },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TYPE_VALUE");
  });
});

describe("ToolRegistry — agent-facing redaction boundary", () => {
  const makeRegistry = (handler: ToolDefinition["handler"]): ToolRegistry => {
    const r = new ToolRegistry();
    r.register({
      name: "leaky_tool",
      description: "A tool that returns sensitive-looking values.",
      inputSchema: z.strictObject({}),
      riskLevel: "none",
      handler,
    });
    return r;
  };

  const context: ToolContext = {
    tenantId: "tenant-1",
    userId: "user-1",
    services: {},
  };

  it("redacts sensitive-named keys in a soft-failure error context", async () => {
    // Regression guard: the agent-facing redaction used to live ONLY in the
    // audit middleware and was gated on `result.success`, so a handler that
    // RETURNED a soft failure (the normal business-rule path) had its
    // `error.context` reflected to the agent VERBATIM — while the identical
    // value was redacted in the durable audit row, the idempotency record
    // and the thrown-error path.
    const registry = makeRegistry(async () => ({
      success: false,
      error: {
        code: "BUSINESS_RULE",
        message: "could not create the record",
        context: { apiKey: "sk_live_ABCDEFGHIJKLMNOP", password: "hunter2" },
      },
    }));

    const result = await registry.execute("leaky_tool", {}, context);
    expect(result.success).toBe(false);
    const context_ = result.error?.context as Record<string, unknown>;
    expect(context_.apiKey).toBe("[REDACTED]");
    expect(context_.password).toBe("[REDACTED]");
  });

  it("redacts sensitive-named keys in a success payload without the audit middleware", async () => {
    // The redaction must not depend on the audit middleware being composed —
    // it is a property of the agent-facing surface, not of a side-effect sink.
    const registry = makeRegistry(async () => ({
      success: true,
      data: { apiKey: "sk_live_ABCDEFGHIJKLMNOP", name: "Acme" },
    }));

    const result = await registry.execute("leaky_tool", {}, context);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((result.data as Record<string, unknown>).name).toBe("Acme");
  });

  it("rejects a tool that declares an envelope key in its input schema", async () => {
    // `confirmation` and `idempotencyKey` are handled by the framework: they
    // are promoted into the context and stripped from the input BEFORE
    // validation, so a tool declaring them would never receive its own
    // field — silently.
    const r = new ToolRegistry();
    expect(() => {
      r.register({
        name: "conflicting_tool",
        description: "Declares the framework-owned `confirmation` key.",
        inputSchema: z.strictObject({ confirmation: z.string().optional() }),
        riskLevel: "none",
        handler: async () => ({ success: true }),
      });
    }).toThrow(/must not declare 'confirmation'/);
  });
});

describe("ToolRegistry — validation issue shape", () => {
  it("exposes the Zod issue type as `issueCode`, not `code`", async () => {
    // `code` is a SENSITIVE field name (it is where a one-time code / OTP
    // usually lives), so the agent-facing context redaction replaces it with
    // "[REDACTED]" — the agent then loses the information it needs to fix
    // its input. The issue type is therefore reported under `issueCode`.
    const registry = new ToolRegistry();
    registry.register({
      name: "strict_tool",
      description: "A tool with a strict schema.",
      inputSchema: z.strictObject({ count: z.number().int() }),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute("strict_tool", { count: "not-a-number" }, mockContext);
    expect(result.success).toBe(false);
    const issues = result.error?.context?.issues as Array<{ issueCode?: string; path?: string[] }> | undefined;
    expect(issues).toBeDefined();
    expect(issues![0]!.issueCode).toBe("invalid_type");
    expect(JSON.stringify(issues)).not.toContain("[REDACTED]");
  });
});

describe("ToolRegistry — pre-pipeline rejections are auditable", () => {
  it("records an unknown tool name in the rejection sink", async () => {
    // The pipeline is composed PER TOOL, so an unknown tool name is
    // rejected BEFORE the audit middleware ever ran — but it is still
    // recorded through the rejection auditor, so a hallucinated tool call
    // (one of the most useful agent-behaviour signals an ERP has) is
    // attributed in the durable trail instead of being lost.
    const registry = new ToolRegistry();
    const rejections: Array<{ toolName: string; code: string }> = [];
    registry.setRejectionAuditor((rejection) => {
      rejections.push({ toolName: rejection.toolName, code: rejection.code });
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute("create_pary", { name: "Jane" }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_TOOL");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.toolName).toBe("create_pary");
    expect(rejections[0]!.code).toBe("UNKNOWN_TOOL");
  });

  it("records a conflicting idempotency key in the rejection sink", async () => {
    const registry = new ToolRegistry();
    const rejections: string[] = [];
    registry.setRejectionAuditor((rejection) => {
      rejections.push(rejection.code);
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    await registry.execute(
      "known_tool",
      { idempotencyKey: "from-input" },
      { ...mockContext, idempotencyKey: "from-context" },
    );

    expect(rejections).toEqual(["IDEMPOTENCY_KEY_MISMATCH"]);
  });

  it("never lets a throwing rejection sink change the outcome of the call", async () => {
    const registry = new ToolRegistry();
    registry.setRejectionAuditor(() => {
      throw new Error("audit sink is down");
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute("create_pary", {}, mockContext);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_TOOL");
  });
});

describe("ToolRegistry — published pipeline order", () => {
  it("exposes the registered global middleware names in pipeline order", () => {
    const registry = new ToolRegistry();
    const mw: ToolMiddleware = async (_i, _c, _d, next) => next(_i, _c);
    registry.addGlobalMiddleware(mw, "errorHandler");
    registry.addGlobalMiddleware(mw, "auditLog");
    registry.addGlobalMiddleware(mw, "agentPolicy");

    expect(registry.globalMiddlewareOrder).toEqual(["errorHandler", "auditLog", "agentPolicy"]);
  });
});

describe("ToolRegistry — register() validates the handler", () => {
  it("rejects a tool without a handler at REGISTRATION time", () => {
    // The handler is invoked as `definition.handler(...)` at execution time.
    // A definition without one was accepted at registration and only failed
    // at first call with a raw "definition.handler is not a function"
    // TypeError — far from the registration site.
    const registry = new ToolRegistry();
    expect(() => registry.register({
      name: "no_handler_tool",
      description: "A tool with no handler.",
      inputSchema: z.object({}),
      riskLevel: "low",
    } as never)).toThrow(/must declare a handler function/);
  });

  it("rejects a tool whose middleware is not a function", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({
      name: "bad_middleware_tool",
      description: "A tool with a broken middleware.",
      inputSchema: z.object({}),
      riskLevel: "low",
      handler: async () => ({ success: true }),
    }, ["not a function" as never])).toThrow(/middleware #0 is not a function/);
  });
});

// ─── Pre-pipeline identity rejections are audited ────────────────

describe("ToolRegistry — an invalid caller identity is recorded in the rejection sink", () => {
  it("records a rejection when the USER id is invalid", async () => {
    // The identity validation happens BEFORE the tool is looked up, so it
    // never reaches the audit middleware. The registry's own contract says
    // every pre-pipeline rejection must be recorded — a valid tenant with a
    // hostile user id is an attack signal worth keeping.
    const registry = new ToolRegistry();
    const rejections: Array<{ toolName: string; code: string }> = [];
    registry.setRejectionAuditor((rejection) => {
      rejections.push({ toolName: rejection.toolName, code: rejection.code });
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute("known_tool", {}, { ...mockContext, userId: "  " });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_USER_ID");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.code).toBe("INVALID_USER_ID");
  });

  it("records a rejection when the AGENT id is invalid", async () => {
    const registry = new ToolRegistry();
    const rejections: string[] = [];
    registry.setRejectionAuditor((rejection) => {
      rejections.push(rejection.code);
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute("known_tool", {}, { ...mockContext, agentId: " ".repeat(3) });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONTEXT_ID");
    expect(rejections).toEqual(["INVALID_CONTEXT_ID"]);
  });

  it("does NOT record a rejection when the TENANT id is invalid (there is no tenant to attribute it to)", async () => {
    const registry = new ToolRegistry();
    const rejections: string[] = [];
    registry.setRejectionAuditor((rejection) => {
      rejections.push(rejection.code);
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute("known_tool", {}, { ...mockContext, tenantId: "bad tenant!" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TENANT_ID");
    expect(rejections).toEqual([]);
  });
});

// ─── The context idempotency key always wins ─────────────────────

describe("ToolRegistry — a NON-STRING context idempotency key", () => {
  it("is NOT silently replaced by the argument key", async () => {
    // The old "has a context key" test required a STRING, so a numeric
    // context key was treated as "no key at all": the conflict check was
    // skipped and the ARGUMENT key silently replaced it, inverting the
    // documented precedence ("the context value wins — it is the dedup
    // identity"). The agent then deduplicated under a key it did not choose.
    const registry = new ToolRegistry();
    const rejections: string[] = [];
    registry.setRejectionAuditor((rejection) => {
      rejections.push(rejection.code);
    });
    registry.register({
      name: "known_tool",
      description: "A tool that exists.",
      inputSchema: z.object({}),
      riskLevel: "none",
      handler: async () => ({ success: true }),
    });

    const result = await registry.execute(
      "known_tool",
      { idempotencyKey: "from-input" },
      { ...mockContext, idempotencyKey: 12345 as unknown as string },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    expect(rejections).toEqual(["IDEMPOTENCY_KEY_MISMATCH"]);
  });
});
