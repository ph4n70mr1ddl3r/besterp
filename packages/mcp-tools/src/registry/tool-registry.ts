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
  RiskLevel,
} from "../schema/tool-definition.js";
import { sanitizeForLogOutput, redactSensitiveFieldValues, validateTenantIdEnhancedForAuth, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH, TENANT_ID_PATTERN } from "@besterp/shared";
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
    // Validate tool name format FIRST so errors point at the real issue, not
    // at "already registered" when the name is actually invalid.
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

    if (this.tools.has(definition.name)) {
      throw new Error(`Tool '${definition.name}' is already registered.`);
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
      typeof definition.inputSchema.safeParse !== "function"
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
    // Auth-boundary guard: `context.tenantId` / `context.userId` are the values
    // used to scope idempotency records, tag the durable `ai_action_log` row,
    // and (inside handlers) set the RLS tenant context via `withTenant(...)`.
    // Nothing else in the mcp-tools pipeline validated them, so a server that
    // constructed `ToolContext` with an unvalidated / attacker-controlled
    // tenantId could set an arbitrary tenant on RLS — a cross-tenant access
    // path. Validate here, BEFORE any middleware or handler runs, and fail
    // closed with a non-enumerating error (no tenant/id echoed to the agent).
    const authCheck = this.validateContextIdentity(context);
    if (authCheck) return authCheck;

    const entry = this.tools.get(name);
    if (!entry) {
      // Hallucination guard — suggest similar tool names
      const similar = this.findSimilarNames(name);
      // Sanitize the requested tool name before reflecting it back to the agent:
      // `name` is attacker-controlled (the requested tool) and this result
      // bypasses errorHandlerMiddleware, so a crafted name embedding a secret
      // (e.g. `foo?api_key=sk_live_abc`) would otherwise reach the agent
      // unsanitized.
      const safeName = sanitizeForLogOutput(name);
      const safeSimilar = similar.map((s) => sanitizeForLogOutput(s));
      return {
        success: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: `Tool '${safeName}' does not exist.${safeSimilar.length > 0 ? ` Similar tools: [${safeSimilar.map((s) => `'${s}'`).join(", ")}].` : ""} Use 'list_available_tools' to see all available tools.`,
          suggestedTools: ["list_available_tools", ...safeSimilar],
          context: { requestedTool: safeName, similarTools: safeSimilar },
        },
      };
    }

    const { definition, middlewares } = entry;

    // Promote idempotency key from raw input into context so the
    // idempotency middleware can see it. Tool schemas validate the key,
    // but the middleware reads from context — not from parsed input.
    // Runtime guard: only treat non-null objects as potential sources;
    // primitives (number, string, boolean) cannot have an idempotencyKey.
    //
    // Fail closed: promote ANY present string key (including empty or
    // over-length) so the idempotency middleware — which returns
    // INVALID_IDEMPOTENCY_KEY for empty/over-length/unsafe keys — can
    // reject it. Silently dropping an out-of-contract key here would
    // disable idempotency protection for that call (a retry could
    // duplicate a write) with no error, contradicting the middleware's
    // fail-closed contract.
    const raw = (rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput))
      ? rawInput as Record<string, unknown>
      : null;
    const effectiveContext: ToolContext =
      typeof raw?.idempotencyKey === "string" && !context.idempotencyKey
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
              .map((i) => `${i.path.map((p) => String(p)).join(".")}: ${i.message}`)
              .join("; ");
            const detailRaw = issueString.length > MAX_VALIDATION_MESSAGE_LENGTH
              ? `${issueString.slice(0, MAX_VALIDATION_MESSAGE_LENGTH)}… [${parsed.error.issues.length} issues, truncated]`
              : issueString;
            // Sanitize the joined summary BEFORE embedding it in the agent-facing
            // `message`. `detailRaw` is only length-capped above; a Zod issue's
            // `message` can embed the received input (a custom errorMap echoing
            // `${input}`, or a schema that reports the offending value) so a
            // connection string / `?api_key=…` / ANSI-CRLF payload survives
            // verbatim — while the parallel `context.issues` array below IS
            // scrubbed via `sanitizeIssues`. That asymmetry is exactly the
            // secret-leak class rounds 42/44/48/49 closed on every other
            // surface; the errorHandlerMiddleware only catches *thrown* errors,
            // and this soft-failure return is never thrown, so it reaches the
            // agent unsanitized unless we scrub it here (verified: a crafted
            // `.refine()` message with `api_key=sk_live_abc` leaked the key in
            // `error.message` while `context.issues` redacted it).
            const detail = sanitizeForLogOutput(detailRaw);
            // The joined `message` is already capped AND sanitized above, but the
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
            // stays consistent with every other error path.
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
   * Validate the identity fields of a tool-execution context at the
   * auth boundary. `tenantId` and `userId` are used to scope idempotency
   * records, tag the durable audit row, and (inside handlers) set the RLS
   * tenant context — so an unvalidated value here is a cross-tenant access
   * path. Returns a failing `ToolResult` when either is malformed, or
   * `null` when the context is acceptable. Fails closed: no tenant/id value
   * is reflected to the agent on error.
   */
  private validateContextIdentity(context: ToolContext): ToolResult | null {
    try {
      validateTenantIdEnhancedForAuth(context.tenantId);
    } catch {
      return this.contextIdentityError("INVALID_TENANT_ID", "tenant identifier");
    }
    if (typeof context.userId !== "string") {
      return this.contextIdentityError("INVALID_USER_ID", "user identifier");
    }
    // Trim userId to match the behavior of McpService.buildContext and
    // TenantGuard — both accept whitespace-padded values by trimming them.
    // Reject only after trimming so a whitespace-only value is caught by
    // the length/pattern checks below, not by the trim-equality guard.
    const userId = context.userId.trim();
    if (userId.length === 0 || userId.length > MAX_USER_ID_LENGTH || !TENANT_ID_PATTERN.test(userId)) {
      return this.contextIdentityError("INVALID_USER_ID", "user identifier");
    }
    // `agentId`/`conversationId` are persisted verbatim into the cross-tenant
    // durable idempotency + audit sinks, so an unvalidated/oversized/attacker-
    // controlled value would bloat those rows and bypass the validation that
    // tenantId/userId receive. They are optional, but when present they must
    // match the same character/length contract as the other identity fields.
    const idFieldError = this.validateOptionalIdentityField(context.agentId, "agentId", MAX_AGENT_ID_LENGTH)
      ?? this.validateOptionalIdentityField(context.conversationId, "conversationId", MAX_CONVERSATION_ID_LENGTH);
    if (idFieldError) return idFieldError;
    return null;
  }

  private contextIdentityError(code: string, fieldLabel: string): ToolResult {
    return {
      success: false,
      error: {
        code,
        message: `The request ${fieldLabel} is invalid. Contact the system administrator.`,
        suggestedTools: ["list_available_tools"],
      },
    };
  }

  /**
   * Validate an optional agent/conversation identity field against the same
   * character set and length bounds as tenantId/userId. Returns a failing
   * ToolResult when malformed, or null when absent/acceptable.
   */
  private validateOptionalIdentityField(
    value: string | undefined,
    field: string,
    maxLength: number,
  ): ToolResult | null {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !TENANT_ID_PATTERN.test(value)) {
      return {
        success: false,
        error: {
          code: "INVALID_CONTEXT_ID",
          message: `The ${field} is invalid. Contact the system administrator.`,
          suggestedTools: ["list_available_tools"],
        },
      };
    }
    return null;
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
      description: entry.definition.description.split("\n").find((s) => s.trim().length > 0) ?? entry.definition.description,
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
      const path = issue.path.map((p) => String(p));
      // Redact any path segment that matches a sensitive field name, not just
      // the last segment — a Zod issue path like ["user","password","confirm"]
      // would otherwise leak the "password" key in the path array.
      const sanitizedPath = path.map((p) => sanitizeForLogOutput(p));
      const redacted: Record<string, unknown> = {
        code: issue.code ?? "custom",
        // A Zod issue message can echo the offending input verbatim (e.g.
        // "Expected string, received {raw password}"), so run it through the
        // deep redactor as well as the length/char sanitizer.
        message: redactSensitiveFieldValues(issue.message) as string,
        path: sanitizedPath,
      };
      const sensitivePathSegments = path.filter((p) => isSensitiveField(p));
      const lastSegment = path.length > 0 ? path[path.length - 1]! : "";
      if (sensitivePathSegments.length > 0 || (isSensitiveField(lastSegment) && issue.received !== undefined)) {
        redacted.received = "[REDACTED]";
      } else if (issue.received !== undefined) {
        redacted.received = redactSensitiveFieldValues(issue.received);
      }
      return redacted;
    });
  }
}

// NOTE: No singleton is exported. Create instances via `new ToolRegistry()`.
