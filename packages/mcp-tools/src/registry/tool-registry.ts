// MCP Tool Registry — Central registration point for all MCP tools.
//
// Tools are registered with their definition and middlewares.
// The registry compiles the middleware pipeline and provides lookup
// by name. It also generates discovery information for AI agents.

import {
  ToolDefinition,
  ToolMiddleware,
  RegistryEntry,
  ToolResult,
  ToolContext,
  ZodSchemaLike,
} from "../schema/tool-definition.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegistryEntry>();
  private readonly globalMiddlewares: ToolMiddleware[] = [];

  /**
   * Register a global middleware that runs for ALL tools.
   * Global middlewares run BEFORE tool-specific middlewares.
   */
  addGlobalMiddleware(middleware: ToolMiddleware): void {
    this.globalMiddlewares.push(middleware);
  }

  /**
   * Register a tool with optional tool-specific middlewares.
   */
  register(definition: ToolDefinition, middlewares: ToolMiddleware[] = []): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool '${definition.name}' is already registered.`);
    }

    // Validate tool name format: must be non-empty snake_case identifier
    if (!definition.name || typeof definition.name !== "string") {
      throw new Error("Tool name must be a non-empty string.");
    }
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(definition.name)) {
      throw new Error(
        `Tool name '${definition.name}' must be snake_case (lowercase letters, digits, underscores).`
      );
    }
    if (definition.name.startsWith("__")) {
      throw new Error(`Tool name '${definition.name}' must not start with '__' (reserved prefix).`);
    }

    // Runtime check: the registry calls `inputSchema.safeParse(...)` when
    // executing the tool, which is Zod-specific. A tool registered with a
    // plain JSONSchema object (or anything that lacks `.safeParse`) would
    // otherwise crash with a `TypeError: ... .safeParse is not a function`
    // at first execution — far from the registration site and hard to
    // diagnose. Failing fast at registration time produces a clear error
    // pointing at the offending tool name.
    //
    // The type system now enforces `.safeParse()` via `ZodSchemaLike`, but
    // this runtime guard is the final safety net: it catches cases where
    // `as any` casts bypass the type check.
    if (
      !definition.inputSchema ||
      typeof (definition.inputSchema as ZodSchemaLike).safeParse !== "function"
    ) {
      throw new Error(
        `Tool '${definition.name}' has an invalid inputSchema: ` +
        `expected a Zod schema (or anything exposing a .safeParse() method), ` +
        `got ${typeof definition.inputSchema}.`
      );
    }

    this.tools.set(definition.name, {
      definition,
      middlewares,
    });
  }

  /**
   * Get a registered tool by name.
   */
  get(name: string): RegistryEntry | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  get names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Execute a tool by name, running the full middleware pipeline.
   *
   * The pipeline is:
   *   global middlewares → tool middlewares → handler
   *
   * Each middleware wraps the next, so execution is:
   *   global[0](global[1](...tool[0](tool[1](handler))))
   */
  async execute(name: string, rawInput: unknown, context: ToolContext): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      // Hallucination guard — suggest similar tool names
      const similar = this.findSimilarNames(name);
      return {
        success: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: `Tool '${name}' does not exist.${similar.length > 0 ? ` Similar tools: [${similar.map((s) => `'${s}'`).join(", ")}].` : ""} Use 'list_available_tools' to see all available tools.`,
          suggestedTools: ["list_available_tools", ...similar],
          context: { requestedTool: name, similarTools: similar },
        },
      };
    }

    const { definition, middlewares } = entry;

    // Promote idempotency key from raw input into context so the
    // idempotency middleware can see it. Tool schemas validate the key,
    // but the middleware reads from context — not from parsed input.
    const raw = rawInput as Record<string, unknown> | null | undefined;
    const effectiveContext: ToolContext =
      raw?.idempotencyKey && typeof raw.idempotencyKey === "string" && !context.idempotencyKey
        ? { ...context, idempotencyKey: raw.idempotencyKey }
        : context;

    // Build the pipeline: handler is the innermost function
    const allMiddlewares = [...this.globalMiddlewares, ...middlewares];

    // Compose middlewares into a single function
    const pipeline = allMiddlewares.reduceRight<
      (input: unknown, ctx: ToolContext) => Promise<ToolResult>
    >(
      (next, middleware) => {
        return (input, ctx) => middleware(input, ctx, definition, next);
      },
      // Final handler — validates input with Zod, then calls the handler
      async (input, ctx) => {
        const parsed = definition.inputSchema.safeParse(input);
        if (!parsed.success) {
          return {
            success: false,
            error: {
              code: "INVALID_INPUT",
              message: `Input validation failed: ${parsed.error.issues.map((i) => `${i.path.map((p) => typeof p === "symbol" ? p.toString() : String(p)).join(".")}: ${i.message}`).join("; ")}`,
              suggestedTools: [name],
              context: { issues: parsed.error.issues },
            },
          };
        }
        return definition.handler(parsed.data, ctx);
      }
    );

    return pipeline(rawInput, effectiveContext);
  }

  /**
   * Generate discovery information for all registered tools.
   * Used by the `list_available_tools` discovery tool.
   */
  getDiscoveryInfo(): Array<{
    name: string;
    description: string;
    riskLevel: string;
    entity?: string;
    tags?: string[];
  }> {
    return Array.from(this.tools.values()).map((entry) => ({
      name: entry.definition.name,
      description: entry.definition.description.split("\n")[0] ?? entry.definition.description,
      riskLevel: entry.definition.riskLevel,
      entity: entry.definition.entity,
      tags: entry.definition.tags,
    }));
  }

  /**
   * Find tool names that are similar to a given (possibly hallucinated) name.
   * Uses simple string similarity — good enough for common hallucinations.
   */
  private findSimilarNames(name: string): string[] {
    const lowerName = name.toLowerCase();
    if (lowerName.length < 2) return [];
    return Array.from(this.tools.keys())
      .filter((existing) => {
        const lower = existing.toLowerCase();
        // Require minimum 3 chars for substring match to avoid false positives
        // (e.g., "in" matching "create_invoice", "or" matching "create_order")
        if (lowerName.length >= 3 && (lower.includes(lowerName) || lowerName.includes(lower))) return true;
        // Check Levenshtein-like: shared word stems
        const nameParts = lowerName.split(/[_\s]+/).filter(Boolean);
        const existingParts = lower.split(/[_\s]+/).filter(Boolean);
        return nameParts.length > 0 && existingParts.length > 0 &&
          nameParts.some((p) => existingParts.some((ep) => ep.includes(p) || p.includes(ep)));
      })
      .slice(0, 5);
  }
}

// NOTE: No singleton is exported. Create instances via `new ToolRegistry()`.
// This avoids shared mutable state across modules.
