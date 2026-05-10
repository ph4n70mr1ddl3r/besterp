// MCP Tool Definition — Core types for the tool registration framework.
//
// Every MCP tool is defined using these types. The framework handles:
// - JSON Schema generation from Zod schemas
// - Middleware pipeline execution (idempotency, audit, validation)
// - Error formatting for AI agent consumption
// - Discovery tool generation

// ─── Risk Levels ──────────────────────────────────────────────────

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

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
  /**
   * Service locator — allows tools to access domain services
   * without importing NestJS directly. Populated by the MCP module.
   */
  services: Record<string, unknown>;
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
export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  /** Semantically meaningful tool name (e.g., "create_party"). */
  name: string;

  /** Natural language description the AI reads to decide whether to use this tool. */
  description: string;

  /** Zod schema for input validation and JSON Schema generation. */
  inputSchema: any;

  /** Risk level — determines confirmation gate behavior. */
  riskLevel: RiskLevel;

  /** Entity this tool primarily operates on (for discovery categorization). */
  entity?: string;

  /** Tags for discovery and filtering. */
  tags?: string[];

  /**
   * The actual tool handler — pure business logic.
   * Receives validated input and context, returns a result.
   */
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
