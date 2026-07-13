// Sensitive-field detection — shared by the audit-log and error-handler
// middlewares.
//
// Both agent-facing surfaces (the persisted ai_action_log row and the
// ToolResult.error.context returned to the AI agent) must apply the SAME
// key-based redaction so a value stored under a sensitive-named key
// (`password`, `apiKey`, `clientSecret`, …) is replaced with "[REDACTED]"
// regardless of which path emits it. Centralising the detection here keeps
// the two consumers from diverging (the audit-log was the original user;
// the error-handler now reuses it as defense-in-depth for DomainError.context).

/** Fields whose values must be redacted before persisting in the audit log. */
export const SENSITIVE_FIELDS: ReadonlySet<string> = Object.freeze(new Set([
  "password", "passwd", "secret", "token", "api_key", "apiKey",
  "authorization", "creditCard", "credit_card", "ssn", "taxId", "tax_id",
  "access_token", "refresh_token", "session_id", "sessionId",
  "private_key", "privateKey", "secret_key", "secretKey",
  "accessKey", "access_key", "encryption_key", "encryptionKey",
  // ERP-specific sensitive fields. birthDate/birth_date are the camelCase
  // field names that actually flow through MCP tool inputs and the Person
  // subtype — date_of_birth/dob alone miss them, leaking DOB (sensitive PII)
  // into ai_action_log.tool_input.
  "pin", "cc_number", "card_number", "date_of_birth", "dob",
  "birthDate", "birth_date",
  "bank_account", "routing_number", "national_id", "passport",
  // OTP/MFA fields — common in authentication flows. Bare "otp" is not
  // caught by the regex or the token fallback (it has no suffix), so it
  // must be listed explicitly here.
  "otp", "otp_code", "one_time_password", "mfa", "mfa_secret",
])) as ReadonlySet<string>;

/**
 * Regex pattern for catch-all sensitive field detection (password, secret,
 * token, key, etc.).
 *
 * Boundary notes: `\b` is NOT used because `_` is a word character under `\w`,
 * so `\btoken\b` would NOT match `session_token`, `auth_token`, `bearer_token`,
 * `id_token`, or `client_secret` — there is no word boundary between `_` and
 * the keyword. We instead delimit the keyword with alnum-only lookarounds
 * (`(?<![a-z0-9])` / `(?![a-z0-9])`), which treat `_` and `-` as separators.
 * This catches both snake_case (`auth_token`, `client_secret`) and camelCase
 * (`authToken`) sensitive names while still rejecting infix matches inside
 * unrelated words.
 *
 * The `auth` subgroup accepts an optional snake/camel `token|key|code` suffix
 * (`auth_token`, `authKey`, bare `auth`), mirroring the `api[_-]?key` form.
 */
export const SENSITIVE_FIELD_PATTERN =
  /(?<![a-zA-Z0-9])(password|secret|token|api[_-]?key|credential|auth(?:token|key|code|[_-](?:token|key|code))?)(?![a-zA-Z0-9])/i;

/**
 * Token keywords that are unambiguously sensitive wherever they appear as a
 * distinct token (a camelCase, snake_case, or kebab-case segment). Used by the
 * token-based fallback in `isSensitiveField` to catch camelCase field names
 * the SENSITIVE_FIELD_PATTERN regex misses.
 */
export const SENSITIVE_TOKENS: ReadonlySet<string> = Object.freeze(new Set([
  "password", "passwd", "pwd", "secret", "token", "credential", "credentials",
  "otp", "mfa",
])) as ReadonlySet<string>;

/**
 * Split a field name into tokens at snake_case, kebab-case, AND camelCase
 * boundaries. e.g. `clientSecret` → [`client`, `Secret`], `access_token` →
 * [`access`, `token`], `bearer-token` → [`bearer`, `token`].
 *
 * Uses `match` (runs of lowercase/digits, or an uppercase letter optionally
 * followed by lowercase letters) rather than inserting a separator, so no
 * control character is needed in the regex (which would trip the
 * `no-control-regex` lint rule).
 */
export function splitFieldTokens(key: string): string[] {
  const matches = key.match(/[a-z0-9]+|[A-Z][a-z]*/g);
  return matches ? matches.filter((t) => t.length > 0) : [];
}

/**
 * Returns true if a field name matches a sensitive pattern.
 *
 * Three layers:
 * 1. Exact match against the explicit SENSITIVE_FIELDS set.
 * 2. The SENSITIVE_FIELD_PATTERN regex (snake/kebab-case aware).
 * 3. A token-based fallback that splits on camelCase + snake/kebab boundaries
 *    and checks each token against SENSITIVE_TOKENS — this catches camelCase
 *    names (`clientSecret`, `bearerToken`, `accessToken`) that the regex's
 *    alnum lookarounds miss, because the lowercase→uppercase transition is
 *    not a separator under those lookarounds.
 *
 * `key` is intentionally excluded from the token set: it over-redacts benign
 * names like `primaryKey`, `foreignKey`, `sortKey`. Key-bearing sensitive
 * fields are covered by the explicit SENSITIVE_FIELDS set and the
 * `api[_-]?key` regex branch.
 */
export function isSensitiveField(key: string): boolean {
  if (SENSITIVE_FIELDS.has(key)) return true;
  if (SENSITIVE_FIELD_PATTERN.test(key)) return true;
  // Token-based fallback for camelCase field names the regex misses.
  // SENSITIVE_FIELD_PATTERN uses alnum-only lookarounds so `_` and `-` act
  // as separators, but the lowercase→uppercase transition does NOT — so
  // `client_secret`, `bearer_token`, and `access_token` are redacted while
  // their camelCase siblings (`clientSecret`, `bearerToken`, `accessToken`)
  // leaked verbatim into ai_action_log.tool_input. These are common
  // OAuth/credential field names, so the gap was a real redaction bypass.
  // Splitting on camelCase + snake/kebab boundaries and checking each token
  // against an unambiguous keyword set catches them without relying on the
  // regex's boundary semantics.
  return splitFieldTokens(key).some((t) => SENSITIVE_TOKENS.has(t.toLowerCase()));
}
