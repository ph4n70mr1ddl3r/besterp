// Sensitive-field detection — shared by the audit-log and error-handler
// middlewares.
//
// Both agent-facing surfaces (the persisted ai_action_log row and the
// ToolResult.error.context returned to the AI agent) must apply the SAME
// key-based redaction as the REST `DomainExceptionFilter`, so a value stored
// under a sensitive-named key (`password`, `apiKey`, `clientSecret`, …) is
// replaced with "[REDACTED]" regardless of which path emits it.
//
// To guarantee these surfaces CANNOT diverge on what counts as sensitive, the
// detection is delegated to the single source of truth `isSensitiveFieldName`
// in `@besterp/shared`. A previous local copy here omitted `code`, `session`,
// `signature`, and `sign`, so a tool returning `{ code: "482913" }` (MFA code)
// or `{ signature: "…" }` was redacted on the REST surface but leaked on the
// agent-first MCP surface — an asymmetric secret-leak. Delegating to the
// shared function closes that gap permanently.

import { isSensitiveFieldName, splitFieldNameTokens } from "@besterp/shared";

/**
 * Split a field name into tokens at snake_case, kebab-case, AND camelCase
 * boundaries. e.g. `clientSecret` → [`client`, `Secret`], `access_token` →
 * [`access`, `token`], `bearer-token` → [`bearer`, `token`].
 *
 * Delegates to the shared tokeniser so the local `redactSensitiveFields`
 * implementation in `audit-log.ts` and the canonical shared redactor cannot
 * drift apart on tokenisation.
 */
export function splitFieldTokens(key: string): string[] {
  return splitFieldNameTokens(key);
}

/**
 * Returns true if a field name is sensitive.
 *
 * Delegates to the single source of truth `isSensitiveFieldName` in
 * `@besterp/shared` so the MCP/durable surfaces and the REST
 * `DomainExceptionFilter` share one definition of "sensitive". A prior local
 * copy here omitted `code`, `session`, `signature`, and `sign`, so a value
 * under one of those keys was redacted on the REST surface but leaked on the
 * agent-first MCP surface (asymmetric secret-leak). Delegation closes that
 * gap and prevents future divergence.
 */
export function isSensitiveField(key: string): boolean {
  return isSensitiveFieldName(key);
}
