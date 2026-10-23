// MCP Tool Definition types
export type {
  RiskLevel,
  ZodSchemaLike,
  ToolServices,
  ToolContext,
  ToolResult,
  ToolDefinition,
  ToolMiddleware,
  RegistryEntry,
} from "./schema/tool-definition.js";

// The published production pipeline contract (outermost → innermost).
export { PRODUCTION_PIPELINE_ORDER } from "./schema/tool-definition.js";

// The machine-readable codes the MCP framework can return. A consumer that
// explains error codes to an agent should assert that its explanation table
// covers every code in this list. The individual constants are exported so a
// consumer can emit a code without hardcoding the string.
export {
  AGENT_NOT_REGISTERED,
  AGENT_INACTIVE,
  AGENT_CAPABILITY_DENIED,
  AGENT_POLICY_UNAVAILABLE,
  CONFIRMATION_REQUIRED,
  INVALID_CONFIRMATION,
  CONFIRMATION_GATE_UNAVAILABLE,
  IDEMPOTENCY_KEY_MISMATCH,
  REQUEST_IN_PROGRESS,
  IDEMPOTENCY_CONTENTION,
  IDEMPOTENCY_UNAVAILABLE,
  IDEMPOTENCY_UNKNOWN_STATUS,
  INVALID_IDEMPOTENCY_KEY,
  STALE_PENDING_RECORD,
  INVALID_CONTEXT_ID,
  INVALID_TENANT_ID,
  INVALID_USER_ID,
  UNKNOWN_TOOL,
  INVALID_INPUT,
  REFERENCE_ERROR,
  DATABASE_ERROR,
  DATABASE_CONNECTION_ERROR,
  INTERNAL_ERROR,
  SERVICE_UNAVAILABLE,
} from "./error-codes.js";
export { MCP_ERROR_CODES } from "./error-codes.js";

// Schema builders (re-exported for tool authors)
export {
  sanitizedString,
  optionalFilteredString,
  optionalSearchFilterString,
  optionalIsoDate,
  uuidParam,
} from "./schema/schema-builders.js";

// Registry
export { ToolRegistry } from "./registry/tool-registry.js";
export type { RejectionAuditor, ToolCallRejection } from "./registry/tool-registry.js";

// Middleware
export {
  idempotencyMiddleware,
  auditLogMiddleware,
  errorHandlerMiddleware,
  confirmationGateMiddleware,
  agentPolicyMiddleware,
} from "./middleware/index.js";

// Durable recording of a call rejected before the pipeline ran.
export { createRejectionAuditor } from "./middleware/audit-log.js";
export type { RejectedToolCall } from "./middleware/audit-log.js";

// Truncation utilities (re-exported for custom middleware authors)
export { truncateValue, capString, MAX_STORED_PAYLOAD_SIZE, isTruncationMarker } from "./middleware/truncate.js";

// Agent-facing result sanitization (re-exported for custom middleware authors)
export { sanitizeAgentFacingResult, sanitizeAgentText, capAgentErrorText } from "./agent-result.js";
