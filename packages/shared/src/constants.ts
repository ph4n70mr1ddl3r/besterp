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

/** Maximum length for phone area codes. */
export const MAX_AREA_CODE_LENGTH = 10;

/** Maximum length for phone line numbers. */
export const MAX_LINE_NUMBER_LENGTH = 20;

/** Maximum length for phone extensions. */
export const MAX_EXTENSION_LENGTH = 10;

/** Maximum length for phone country codes (E.164). */
export const MAX_PHONE_COUNTRY_CODE_LENGTH = 5;

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

// ─── Cache ─────────────────────────────────────────────────────

/** Maximum number of tenant-scoped clients to cache. */
export const MAX_TENANT_CACHE_SIZE = 256;

// ─── Idempotency ───────────────────────────────────────────────

/** Maximum length for idempotency keys. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 500;

/** TTL for idempotency records (24 hours in milliseconds). */
export const IDEMPOTENCY_TTL_MS = 86_400_000;

/** Maximum retries for idempotency serialization failures. */
export const IDEMPOTENCY_MAX_RETRIES = 3;

// ─── Payload Limits ────────────────────────────────────────────

/** Maximum size (bytes) for stored audit log and idempotency payloads. */
export const MAX_STORED_PAYLOAD_SIZE = 65_536; // 64 KB

/** Maximum size (bytes) for soft-failure error messages. */
export const MAX_SOFT_FAILURE_MESSAGE_SIZE = 4096;
