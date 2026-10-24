// MCP Tool Definition — Core types for the tool registration framework.
//
// Every MCP tool is defined using these types. The framework handles:
// - JSON Schema generation from Zod schemas
// - Middleware pipeline execution (idempotency, audit, validation)
// - Error formatting for AI agent consumption
// - Discovery tool generation

// ─── Risk Levels ──────────────────────────────────────────────────

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

// ─── Schema Types ────────────────────────────────────────────────

/**
 * Minimal interface for a Zod-like schema that exposes `.safeParse()`.
 *
 * Replaces `any` on `ToolDefinition.inputSchema` to provide compile-time
 * safety — the registry calls `.safeParse()` at runtime and would crash
 * with a `TypeError` if the schema lacks the method. This interface
 * enforces the method signature at the type level while remaining
 * decoupled from Zod's exact class names (no `import { z }` needed).
 *
 * The `path` field uses `PropertyKey[]` (not `(string | number)[]`) to
 * accommodate Zod 3.25's `$ZodIssue` type, which uses `PropertyKey` for
 * issue paths.
 *
 * IMPORTANT: This interface is intentionally narrow. At registration time
 * the registry additionally checks that `safeParse` returns an object with
 * a `issues` array on failure — see {@link ToolRegistry.register}. That
 * runtime check catches schema objects whose shape diverges from Zod's
 * (e.g. a plain JSONSchema without `.safeParse`) even when TypeScript is
 * bypassed via `as any` casts.
 */
export interface ZodSchemaLike {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string; code?: string; received?: unknown }> } };
}

// ─── Service Types ────────────────────────────────────────────────

/**
 * Typed service locator interface. Tools access domain services through
 * this typed interface instead of using `Record<string, unknown>`.
 *
 * Each domain module registers its services here. The MCP module
 * populates the services map when building the tool context.
 *
 * Services are typed as `unknown` — each tool casts to its specific
 * service interface when accessing `context.services`. This avoids a
 * central registry that would grow with every new domain.
 */
export interface ToolServices {
  [key: string]: unknown;
}

// ─── Tool Context ─────────────────────────────────────────────────

/**
 * Context passed to every tool handler and middleware.
 * Populated by the MCP server before tool execution.
 */
export interface ToolContext {
  /** The tenant ID for this request (from auth or explicit parameter). */
  readonly tenantId: string;
  /** The user ID on whose behalf this tool is called. */
  readonly userId: string;
  /** The AI agent ID making the call. */
  readonly agentId?: string;
  /** The conversation/session ID. */
  readonly conversationId?: string;
  /** Idempotency key (if provided by the caller). */
  readonly idempotencyKey?: string;
  /**
   * Agent confirmation for a gated (high/critical risk) tool — the agent's
   * stated reason for performing the operation.
   *
   * Promoted from the tool input by {@link ToolRegistry.execute} so the
   * confirmation gate can validate it WITHOUT the key appearing in the
   * schema-validated input (every tool schema is a `z.strictObject`, which
   * rejects undeclared keys — the gate used to inject the key into the input
   * and every gated tool then failed validation with "Unrecognized key(s) in
   * object: 'confirmation'").
   */
  readonly confirmation?: string;
  /** Reasoning provided by the AI agent for why this tool was called. */
  readonly reasoning?: string;
  /**
   * Service locator — allows tools to access domain services
   * without importing NestJS directly. Populated by the MCP module.
   * Typed as ToolServices for type safety; tools cast to their specific
   * service interface when accessing services.
   */
  readonly services: ToolServices;
}

// ─── Tool Result ──────────────────────────────────────────────────

/**
 * Standard result from any MCP tool.
 */
export interface ToolResult<T = unknown> {
  /** Whether the tool execution was successful. */
  success: boolean;
  /** The result data (if successful). */
  data?: T;
  /** Rich error information (if failed). */
  error?: {
    code: string;
    message: string;
    suggestedTools?: string[];
    context?: Record<string, unknown>;
  };
  /** Actions the AI agent can take next. */
  nextActions?: string[];
  /** Whether this was an idempotent replay. */
  replayed?: boolean;
}

// ─── Tool Definition ──────────────────────────────────────────────

/**
 * Complete definition of an MCP tool.
 *
 * This is the "registration card" for a tool — everything the framework
 * needs to expose, validate, audit, and execute it.
 */
export interface ToolDefinition<TResult = unknown> {
  /** Semantically meaningful tool name (e.g., "create_party"). */
  name: string;

  /** Natural language description the AI reads to decide whether to use this tool. */
  description: string;

  /**
   * Schema for input validation and JSON Schema generation.
   * Must support `.safeParse()` — the runtime guard in `ToolRegistry.register()`
   * enforces this at registration time. Typed as `ZodSchemaLike` for
   * compile-time safety instead of `any`.
   */
  inputSchema: ZodSchemaLike;

  /** Risk level — determines confirmation gate behavior. */
  riskLevel: RiskLevel;

  /** Entity this tool primarily operates on (for discovery categorization). */
  entity?: string;

  /**
   * The registered tool names a caller should use to look up or list the
   * entity this tool operates on.
   *
   * The error-handler middleware suggests follow-up tools to the agent. It
   * used to DERIVE those names from `entity` (`search_${pluralize(entity)}`),
   * which produced names that are not registered tools — entity
   * "agent_registry" yielded "search_agent_registryies" and
   * "get_agent_registry", so an agent that followed the suggestion got
   * UNKNOWN_TOOL back. Declaring the real tool names keeps every suggestion
   * callable; when a tool declares no mapping, the error handler suggests
   * only the failing tool itself and `list_available_tools`.
   */
  relatedTools?: {
    /** Tool that fetches a single record of this entity (e.g. "get_party"). */
    get?: string;
    /** Tool that lists/searches records of this entity (e.g. "search_parties"). */
    search?: string;
  };

  /** Tags for discovery and filtering. */
  tags?: string[];

  /**
   * The actual tool handler — pure business logic.
   * Receives validated input and context, returns a result.
   *
   * The input parameter is typed as `unknown` because handlers receive
   * Zod-validated data at runtime via `inputSchema.safeParse()`. Consumers
   * cast the input to their specific type within the handler body — this
   * preserves compile-time safety while avoiding `any`.
   */
  handler: (input: unknown, context: ToolContext) => Promise<ToolResult<TResult>>;
}

// ─── Middleware ────────────────────────────────────────────────────

/**
 * The production middleware pipeline, outermost → innermost.
 *
 * This is the SINGLE published contract for the pipeline order. It used to
 * live only as a comment in this file and had already drifted from the
 * implementation: the `agentPolicy` stage was missing, together with the
 * ordering rule that DEPENDS on it (an agent that may not call a tool at all
 * must not be able to "unlock" it by supplying a confirmation). A middleware
 * author following the published contract would have placed the
 * confirmation gate outside the agent policy and silently reopened that
 * bypass.
 *
 * The order and the rules that depend on it:
 *
 *   1. `errorHandler` — outermost, so it converts EVERY thrown error (from
 *      any middleware or the handler) into a structured result.
 *   2. `auditLog` — wraps every guard, so a rejection at any inner layer is
 *      recorded in the durable audit trail.
 *   3. `agentPolicy` — after `auditLog` (a rejected agent call must still be
 *      recorded) and before `confirmationGate` (an agent that may not call
 *      the tool at all must not be able to unlock it with a confirmation).
 *   4. `confirmationGate` — before `idempotency`, so a request rejected for a
 *      missing confirmation does not consume the caller's idempotency key.
 *   5. `idempotency` — innermost of the guards, so it hashes exactly what
 *      the handler will execute.
 *   6. `handler` — the tool itself.
 */
export const PRODUCTION_PIPELINE_ORDER = [
  "errorHandler",
  "auditLog",
  "agentPolicy",
  "confirmationGate",
  "idempotency",
  "handler",
] as const;

/**
 * Middleware function that wraps tool execution.
 *
 * Middlewares form a pipeline. Each middleware receives the input, context,
 * definition, and a `next` function to call the next middleware (or the
 * final handler).
 *
  * The production pipeline is {@link PRODUCTION_PIPELINE_ORDER} — the single
  * published contract, which the production server composes against at boot
  * (McpService.assertPipelineOrderMatchesContract in apps/api) and refuses to
  * start on any drift. Do not restate the order here: this comment used to
  * be the only statement of it and had already gone stale (the `agentPolicy`
  * stage was missing from it).
  */
export type ToolMiddleware = (
  input: unknown,
  context: ToolContext,
  definition: ToolDefinition,
  next: (input: unknown, context: ToolContext) => Promise<ToolResult>
) => Promise<ToolResult>;

// ─── Tool Registry Entry ──────────────────────────────────────────

/**
 * Internal registry entry — a tool definition plus its compiled middleware pipeline.
 */
export interface RegistryEntry {
  definition: ToolDefinition;
  middlewares: ToolMiddleware[];
}
