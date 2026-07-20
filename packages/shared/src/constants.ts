// Shared constants for BestERP packages.
//
// Centralises magic numbers used across packages to avoid
// duplication and ensure consistency.

// ─── Field Length Limits ────────────────────────────────────────

/** Maximum length for party names. */
export const MAX_PARTY_NAME_LENGTH = 500;

/** Maximum length for party descriptions. */
export const MAX_PARTY_DESCRIPTION_LENGTH = 1000;

/** Maximum length for person first/last names. */
export const MAX_PERSON_NAME_LENGTH = 200;

/** Maximum length for person middle names. */
export const MAX_MIDDLE_NAME_LENGTH = 100;

/** Maximum length for organization legal names. */
export const MAX_LEGAL_NAME_LENGTH = 500;

/** Maximum length for tax IDs. */
export const MAX_TAX_ID_LENGTH = 50;

/** Maximum length for role type names. */
export const MAX_ROLE_TYPE_LENGTH = 100;

/** Maximum length for contact mechanism type names. */
export const MAX_CONTACT_MECHANISM_TYPE_LENGTH = 50;

/** Maximum length for address lines. */
export const MAX_ADDRESS_LINE_LENGTH = 200;

/** Maximum length for city names. */
export const MAX_CITY_LENGTH = 100;

/** Maximum length for state/province. */
export const MAX_STATE_PROVINCE_LENGTH = 100;

/** Maximum length for postal codes. */
export const MAX_POSTAL_CODE_LENGTH = 20;

/** Maximum length for country codes (ISO 3166-1 alpha-2/3). */
export const MAX_COUNTRY_CODE_LENGTH = 3;

/** Minimum length for country codes (ISO 3166-1 alpha-2). */
export const MIN_COUNTRY_CODE_LENGTH = 2;

/** Maximum length for phone area codes. */
export const MAX_AREA_CODE_LENGTH = 10;

/** Maximum length for phone line numbers. */
export const MAX_LINE_NUMBER_LENGTH = 20;

/** Maximum length for phone extensions. */
export const MAX_EXTENSION_LENGTH = 10;

/** Maximum length for phone country codes (E.164). */
export const MAX_PHONE_COUNTRY_CODE_LENGTH = 5;

/** Default E.164 country code for phone numbers when none is provided. */
export const DEFAULT_PHONE_COUNTRY_CODE = "+1";

/** Maximum length for email addresses (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254;

/** Maximum length for gender field. */
export const MAX_GENDER_LENGTH = 50;

/** Maximum length for ISO 8601 date strings (e.g., "2024-06-15", "2024-06-15T00:00:00.000Z"). */
export const MAX_DATE_STRING_LENGTH = 30;

// ─── Auth Limits ───────────────────────────────────────────────

/** Maximum length for user IDs in JWT tokens. */
export const MAX_USER_ID_LENGTH = 200;

/** Maximum length for agent IDs in JWT tokens. */
export const MAX_AGENT_ID_LENGTH = 200;

/** Maximum length for AI agent reasoning strings. */
export const MAX_REASONING_LENGTH = 2000;

/** Maximum length for conversation/session IDs. */
export const MAX_CONVERSATION_ID_LENGTH = 200;

/** Maximum length for role strings in JWT tokens. */
export const MAX_ROLE_LENGTH = 100;

// ─── Tenant ────────────────────────────────────────────────────

/** Maximum length for tenant IDs. */
export const MAX_TENANT_ID_LENGTH = 100;

// ─── Pagination ────────────────────────────────────────────────

/** Default page size for search results. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** Maximum page size for search results. */
export const MAX_SEARCH_LIMIT = 500;

/** Minimum page size for search results. */
export const MIN_SEARCH_LIMIT = 1;

/** Minimum offset for search results. */
export const MIN_SEARCH_OFFSET = 0;

/** Maximum offset for search results (prevents deep pagination performance issues). */
export const MAX_SEARCH_OFFSET = 10_000;

// ─── Cache ─────────────────────────────────────────────────────

/** Maximum number of tenant-scoped clients to cache. */
export const MAX_TENANT_CACHE_SIZE = 256;

// ─── Idempotency ───────────────────────────────────────────────

/** Maximum length for idempotency keys. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 500;

/**
 * Allowed charset for idempotency keys — printable ASCII only (0x21–0x7E).
 *
 * Rejects control characters, newlines, tabs, and non-ASCII bytes that could
 * corrupt log output or database storage. Keys are typically UUIDs, ULIDs, or
 * hashes — all printable-ASCII tokens. A key failing this check is almost
 * certainly a caller bug, not a legitimate idempotency attempt.
 *
 * Centralised here so every boundary that handles idempotency keys (the MCP
 * auth boundary in `McpModule.buildContext`, the idempotency middleware, and the
 * tool registry) applies the SAME rule — previously the rule was duplicated in
 * two mcp-tools files and absent from `buildContext`, so an unsafe key passed
 * the auth boundary only to be silently dropped by the middleware (a no-op
 * rather than a structured error).
 */
export const SAFE_IDEMPOTENCY_KEY = /^[!-~]+$/;

/** TTL for idempotency records (24 hours in milliseconds). */
export const IDEMPOTENCY_TTL_MS = 86_400_000;

/** Maximum retries for idempotency serialization failures. */
export const IDEMPOTENCY_MAX_RETRIES = 3;

/** Base delay (ms) between idempotency retry attempts. */
export const IDEMPOTENCY_RETRY_BASE_DELAY_MS = 50;

// ─── Payload Limits ────────────────────────────────────────────

/** Maximum size (bytes) for stored audit log and idempotency payloads. */
export const MAX_STORED_PAYLOAD_SIZE = 65_536; // 64 KB

/** Maximum size (bytes) for soft-failure error messages. */
export const MAX_SOFT_FAILURE_MESSAGE_SIZE = 4096;

// ─── Auth Config ──────────────────────────────────────────────

/** Regex for validating JWT_EXPIRES_IN duration format (e.g., "24h", "60m", "7d").
 *  Rejects a leading zero and caps the magnitude (`[1-9]\d{0,9}`) so degenerate
 *  values cannot be configured. A bare `0s` would expire every token immediately;
 *  an unbounded `999999999999999999d` would produce an effectively non-expiring
 *  token — both defeat the purpose of a short-lived JWT. `validateEnvironment`
 *  (main.ts) tests this pattern before booting, so the cap is enforced there. */
export const JWT_EXPIRES_IN_REGEX = /^[1-9]\d{0,9}[smhd]$/;
