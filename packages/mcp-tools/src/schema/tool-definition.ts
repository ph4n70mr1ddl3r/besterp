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
 */
export interface ZodSchemaLike {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
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
  tenantId: string;
  /** The user ID on whose behalf this tool is called. */
  userId: string;
  /** The AI agent ID making the call. */
  agentId?: string;
  /** The conversation/session ID. */
  conversationId?: string;
  /** Idempotency key (if provided by the caller). */
  idempotencyKey?: string;
  /** Reasoning provided by the AI agent for why this tool was called. */
  reasoning?: string;
  /**
   * Service locator — allows tools to access domain services
   * without importing NestJS directly. Populated by the MCP module.
   * Typed as ToolServices for type safety; tools cast to their specific
   * service interface when accessing services.
   */
  services: ToolServices;
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
export interface ToolDefinition<_TInput = unknown, TResult = unknown> {
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

  /** Tags for discovery and filtering. */
  tags?: string[];

  /**
   * The actual tool handler — pure business logic.
   * Receives validated input and context, returns a result.
   *
   * The input parameter is typed as `any` because TypeScript's strict
   * function parameter checking prevents assigning `(input: SpecificType, ...)`
   * to `(input: unknown, ...)`. The handler receives Zod-validated data at
   * runtime — the `inputSchema` field (typed as `ZodSchemaLike`) is the
   * actual compile-time + runtime type safety boundary.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any, context: ToolContext) => Promise<ToolResult<TResult>>;
}

// ─── Middleware ────────────────────────────────────────────────────

/**
 * Middleware function that wraps tool execution.
 *
 * Middlewares form a pipeline:
 *   idempotency → audit → validation → handler
 *
 * Each middleware receives the input, context, definition, and a `next`
 * function to call the next middleware (or the final handler).
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
