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
              message: `Input validation failed: ${parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
              suggestedTools: [name],
              context: { issues: parsed.error.issues },
            },
          };
        }
        return definition.handler(parsed.data, ctx);
      }
    );

    return pipeline(rawInput, context);
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
      description: entry.definition.description.split("\n")[0], // First line only
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
    return Array.from(this.tools.keys())
      .filter((existing) => {
        const lower = existing.toLowerCase();
        // Check if either contains the other, or shares significant words
        if (lower.includes(lowerName) || lowerName.includes(lower)) return true;
        // Check Levenshtein-like: shared word stems
        const nameParts = lowerName.split(/[_\s]+/);
        const existingParts = lower.split(/[_\s]+/);
        return nameParts.some((p) => existingParts.some((ep) => ep.includes(p) || p.includes(ep)));
      })
      .slice(0, 5);
  }
}

// Singleton registry instance
export const registry = new ToolRegistry();
