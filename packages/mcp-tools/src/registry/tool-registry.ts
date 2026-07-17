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
  RiskLevel,
} from "../schema/tool-definition.js";
import { MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, sanitizeForLogOutput } from "@besterp/shared";
import { isSensitiveField } from "../middleware/sensitive-fields.js";

const VALID_RISK_LEVELS: readonly RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/**
 * Cap the length of the joined Zod validation-issue string returned to the
 * agent. The path+message of each issue is derived from user input and could
 * be arbitrarily large (many issues, or long per-issue messages), so the
 * agent-facing error surface is bounded the same way soft-failure log lines
 * are (error-handler.ts MAX_ERROR_LOG_LINE_LENGTH). The full issue list is
 * still available in `context.issues` for programmatic callers.
 */
const MAX_VALIDATION_MESSAGE_LENGTH = 2000;

/**
 * Maximum number of Zod validation issues echoed back in `context.issues`.
 * Zod emits one issue per invalid element, so a crafted array/object with
 * many failing fields produces an arbitrarily large issues array. Returning
 * it verbatim to the agent is a memory-amplification / DoS vector. The
 * already-capped `message` string preserves a readable summary; only the
 * first N structured issues are retained for programmatic callers.
 */
const MAX_VALIDATION_ISSUES = 50;

export class ToolRegistry {
  private readonly tools = new Map<string, RegistryEntry>();
  private readonly globalMiddlewares: ToolMiddleware[] = [];
  /** Cached compiled pipelines per tool name, invalidated on register/addGlobalMiddleware. */
  private readonly pipelineCache = new Map<string, (input: unknown, ctx: ToolContext) => Promise<ToolResult>>();

  /**
   * Register a global middleware that runs for ALL tools.
   * Global middlewares run BEFORE tool-specific middlewares.
   */
  addGlobalMiddleware(middleware: ToolMiddleware): void {
    this.globalMiddlewares.push(middleware);
    this.pipelineCache.clear();
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
    if (!definition.description || typeof definition.description !== "string" || definition.description.trim().length === 0) {
      throw new Error(
        `Tool '${definition.name}' must have a non-empty description. ` +
        `The description helps AI agents understand the tool's purpose.`
      );
    }
    // Check reserved prefix FIRST to provide a specific error message — the
    // snake_case regex below would also reject `__` with a generic error.
    if (definition.name.startsWith("__")) {
      throw new Error(`Tool name '${definition.name}' must not start with '__' (reserved prefix).`);
    }
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(definition.name)) {
      throw new Error(
        `Tool name '${definition.name}' must be snake_case (lowercase letters, digits, underscores).`
      );
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

    if (!definition.riskLevel || !VALID_RISK_LEVELS.includes(definition.riskLevel)) {
      throw new Error(
        `Tool '${definition.name}' has an invalid riskLevel: '${String(definition.riskLevel)}'. ` +
        `Must be one of: ${VALID_RISK_LEVELS.join(", ")}.`
      );
    }

    this.tools.set(definition.name, {
      definition,
      middlewares,
    });
    this.pipelineCache.delete(definition.name);
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
    // Runtime guard: only treat non-null objects as potential sources;
    // primitives (number, string, boolean) cannot have an idempotencyKey.
    const raw = (rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput))
      ? rawInput as Record<string, unknown>
      : null;
    const effectiveContext: ToolContext =
      raw?.idempotencyKey && typeof raw.idempotencyKey === "string" && raw.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_LENGTH && SAFE_IDEMPOTENCY_KEY.test(raw.idempotencyKey) && !context.idempotencyKey
        ? { ...context, idempotencyKey: raw.idempotencyKey }
        : context;

    // Check pipeline cache — rebuilt only on register() or addGlobalMiddleware()
    let pipeline = this.pipelineCache.get(name);
    if (!pipeline) {
      // Build the pipeline: handler is the innermost function
      const allMiddlewares = [...this.globalMiddlewares, ...middlewares];

      // Compose middlewares into a single function
      pipeline = allMiddlewares.reduceRight<
        (input: unknown, ctx: ToolContext) => Promise<ToolResult>
      >(
        (next, middleware) => {
          return (input, ctx) => middleware(input, ctx, definition, next);
        },
        // Final handler — validates input with Zod, then calls the handler
        async (input, ctx) => {
          const parsed = definition.inputSchema.safeParse(input);
          if (!parsed.success) {
            const issueString = parsed.error.issues
              .map((i) => `${i.path.map((p) => typeof p === "symbol" ? p.toString() : String(p)).join(".")}: ${i.message}`)
              .join("; ");
            const detail = issueString.length > MAX_VALIDATION_MESSAGE_LENGTH
              ? `${issueString.slice(0, MAX_VALIDATION_MESSAGE_LENGTH)}… [${parsed.error.issues.length} issues, truncated]`
              : issueString;
            // The joined `message` is already capped above, but the
            // `context.issues` array is returned verbatim to the AI agent and
            // is NOT filtered through the error-handler's
            // `sanitizeContextValue` (that only runs on thrown DomainErrors).
            // A Zod issue's `message` can embed the received input (e.g. a
            // custom errorMap echoing `${input}`, or a tool whose schema
            // reports the offending value), and an issue whose `path` ends in a
            // sensitive-named key (password, apiKey, token, …) would surface
            // the rejected value to the agent — bypassing the field-name
            // redaction applied to live results and DomainError.context.
            // Sanitize every string (strip URLs/paths/ANSI) and redact values
            // carried under a sensitive-named path so this agent-facing surface
            // stays consistent with every other error path. The full/capped
            // `message` string above preserves a readable (sanitized) summary.
            const sanitizedIssues = this.sanitizeIssues(parsed.error.issues, MAX_VALIDATION_ISSUES);
            return {
              success: false,
              error: {
                code: "INVALID_INPUT",
                message: `Input validation failed: ${detail}`,
                suggestedTools: [name],
                context: { issues: sanitizedIssues },
              },
            };
          }
          return definition.handler(parsed.data, ctx);
        }
      );
      this.pipelineCache.set(name, pipeline);
    }

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
      description: entry.definition.description.split("\n")[0] || entry.definition.description,
      riskLevel: entry.definition.riskLevel,
      entity: entry.definition.entity,
      tags: entry.definition.tags ? [...entry.definition.tags] : undefined,
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
        // Substring match (minimum 2 chars to reduce false positives)
        if (lower.includes(lowerName) || lowerName.includes(lower)) return true;
        // Check Levenshtein-like: shared word stems
        const nameParts = lowerName.split(/[_\s]+/).filter(Boolean);
        const existingParts = lower.split(/[_\s]+/).filter(Boolean);
        return nameParts.length > 0 && existingParts.length > 0 &&
          nameParts.some((p) => p.length >= 2 && existingParts.some((ep) => ep.includes(p) || p.includes(ep)));
      })
      .slice(0, 5);
  }

  /**
   * Sanitize and redact Zod validation issues before returning them to the
   * AI agent in `context.issues`. Mirrors the redaction (sensitive-named
   * paths) and log-output sanitization (URLs/paths/ANSI) applied by
   * `redactSensitiveFields` / `sanitizeContextValue` to every other
   * agent-facing surface, so a failed-validation response cannot leak a
   * secret carried under a sensitive-named field or an embedded connection
   * string. Caps to the first `maxIssues` issues for memory safety.
   */
  private sanitizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string; code?: string; received?: unknown }>, maxIssues: number): unknown[] {
    return issues.slice(0, maxIssues).map((issue) => {
      const path = issue.path.map((p) => (typeof p === "symbol" ? p.toString() : String(p)));
      const lastSegment = path.length > 0 ? path[path.length - 1] : "";
      // Strip URLs/paths/ANSI from the human-readable message, and redact any
      // value carried under a sensitive-named path (e.g. an errorMap that
      // echoes the received input). Zod never sets `received` by default, but
      // custom schemas can; treat the field as sensitive when its name matches
      // the shared sensitive-field rules so a failed-validation response
      // cannot surface a secret the way the live result path would redact it.
      const redacted: Record<string, unknown> = {
        code: issue.code ?? "custom",
        message: sanitizeForLogOutput(issue.message),
        path: path.map((p) => sanitizeForLogOutput(p)),
      };
      if (isSensitiveField(lastSegment ?? "") && issue.received !== undefined) {
        redacted.received = "[REDACTED]";
      } else if (issue.received !== undefined) {
        redacted.received = sanitizeForLogOutput(String(issue.received));
      }
      return redacted;
    });
  }
}

// NOTE: No singleton is exported. Create instances via `new ToolRegistry()`.
// This avoids shared mutable state across modules.
