// Error Codes — the machine-readable codes the MCP framework can return.
//
// This list is the SINGLE published inventory of the codes the framework
// emits. It exists so a consumer that explains error codes to an AI agent
// (the `explain_error` discovery tool) can assert that EVERY code it can
// receive has an explanation.
//
// The codes were previously implicit — they were scattered across the
// middleware as string literals — so `explain_error` answered
// "UNKNOWN_ERROR_CODE: no explanation found" for codes the server itself
// had just produced. The most common case was `AGENT_CAPABILITY_DENIED`,
// the single most frequent agent-policy rejection.
//
// The shared domain-error codes (INVALID_TYPE_VALUE, DUPLICATE_ENTITY, …)
// are NOT listed here: they belong to @besterp/shared and are published as
// `DOMAIN_ERROR_CODES`. A consumer that needs the full set unions the two.
//
// The list is asserted in BOTH directions by the test suite:
//  - every code in this list must have an `explain_error` explanation, and
//  - every `code: "…"` literal emitted by this package must appear in this
//    list (or in `DOMAIN_ERROR_CODES`). The one-way assertion could only
//    detect a code that was ADDED to the inventory, never one that was
//    emitted without being added — which is exactly the failure the
//    inventory exists to prevent.

/** Rejected because the agent is not registered in the tenant. */
export const AGENT_NOT_REGISTERED = "AGENT_NOT_REGISTERED";
/** Rejected because the agent has been deactivated. */
export const AGENT_INACTIVE = "AGENT_INACTIVE";
/** Rejected because the tool is not in the agent's capabilities. */
export const AGENT_CAPABILITY_DENIED = "AGENT_CAPABILITY_DENIED";
/** The agent registry could not be read, so the permissions are unverifiable. */
export const AGENT_POLICY_UNAVAILABLE = "AGENT_POLICY_UNAVAILABLE";
/** The tool requires an agent confirmation and none was supplied. */
export const CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED";
/** The supplied confirmation is not a usable string. */
export const INVALID_CONFIRMATION = "INVALID_CONFIRMATION";
/** The confirmation gate could not be verified, so the call was blocked. */
export const CONFIRMATION_GATE_UNAVAILABLE = "CONFIRMATION_GATE_UNAVAILABLE";
/** The idempotency key was already used with a different operation. */
export const IDEMPOTENCY_KEY_MISMATCH = "IDEMPOTENCY_KEY_MISMATCH";
/** A request with the same key is already in progress. */
export const REQUEST_IN_PROGRESS = "REQUEST_IN_PROGRESS";
/** A concurrent request holds the idempotency record. */
export const IDEMPOTENCY_CONTENTION = "IDEMPOTENCY_CONTENTION";
/** The idempotency store could not be reached. */
export const IDEMPOTENCY_UNAVAILABLE = "IDEMPOTENCY_UNAVAILABLE";
/** The idempotency record carries a status the framework does not know. */
export const IDEMPOTENCY_UNKNOWN_STATUS = "IDEMPOTENCY_UNKNOWN_STATUS";
/** The supplied idempotency key is not a usable string. */
export const INVALID_IDEMPOTENCY_KEY = "INVALID_IDEMPOTENCY_KEY";
/** A stale pending record was found for the key. */
export const STALE_PENDING_RECORD = "STALE_PENDING_RECORD";
/** The tool context carries an invalid identity field. */
export const INVALID_CONTEXT_ID = "INVALID_CONTEXT_ID";
/** The tool context carries an invalid tenant id. */
export const INVALID_TENANT_ID = "INVALID_TENANT_ID";
/** The tool context carries an invalid user id. */
export const INVALID_USER_ID = "INVALID_USER_ID";
/** The requested tool is not registered. */
export const UNKNOWN_TOOL = "UNKNOWN_TOOL";
/** The tool arguments did not satisfy the tool's schema. */
export const INVALID_INPUT = "INVALID_INPUT";
/** A referenced entity is missing or violates a required relation. */
export const REFERENCE_ERROR = "REFERENCE_ERROR";
/** The database schema does not match the request (e.g. a table is missing). */
export const DATABASE_ERROR = "DATABASE_ERROR";
/** The database connection failed, or the connection pool timed out. */
export const DATABASE_CONNECTION_ERROR = "DATABASE_CONNECTION_ERROR";
/** An unexpected server-side failure. */
export const INTERNAL_ERROR = "INTERNAL_ERROR";
/** A required service is temporarily unavailable. */
export const SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE";

/**
 * Every error code the MCP framework itself can return.
 *
 * A consumer that explains error codes to an agent should assert that its
 * explanation table covers this list.
 */
export const MCP_ERROR_CODES = Object.freeze([
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
] as const);
