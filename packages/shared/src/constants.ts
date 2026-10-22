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

/** Maximum length for party type names (e.g. "PERSON", "ORGANIZATION").
 *  The MCP/REST boundaries constrain the value to the PERSON/ORGANIZATION
 *  enum, but the service layer validates it as a free-text filter and needs
 *  its own bound — previously it reused MAX_ROLE_TYPE_LENGTH (a role-type
 *  cap), which is semantically unrelated. */
export const MAX_PARTY_TYPE_LENGTH = 50;

/** Maximum length for product type names. */
export const MAX_PRODUCT_TYPE_LENGTH = 100;

/** Maximum length for product price type names. */
export const MAX_PRICE_TYPE_LENGTH = 50;

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

/** Maximum length for phone country codes (E.164: '+' plus up to 3 digits = 4 chars).
 *  Matches COUNTRY_CODE_REGEX in validation.ts — previously 5, so a 5-char code
 *  passed every length pre-check only to fail the regex with a less specific
 *  error. */
export const MAX_PHONE_COUNTRY_CODE_LENGTH = 4;

/** Default E.164 country code for phone numbers when none is provided. */
export const DEFAULT_PHONE_COUNTRY_CODE = "+1";

/** Maximum length for email addresses (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254;

/** Maximum length for gender field. */
export const MAX_GENDER_LENGTH = 50;

/** Maximum length for password hashes (bcrypt: 60, argon2: ~97, future algorithms up to 255). */
export const MAX_PASSWORD_HASH_LENGTH = 255;

/**
 * Maximum length for ISO 8601 date strings (e.g., "2024-06-15", "2024-06-15T00:00:00.000Z").
 *
 * 32 characters, not 30: `ISO_DATE_REGEX` accepts a fractional second AND a
 * numeric UTC offset at the same time ("2024-06-15T00:00:00.123456+01:00"),
 * which is exactly 32 characters long. The previous value of 30 made every
 * boundary (the Zod schema, the class-validator constraint, the service-level
 * validators) reject a value that satisfies the documented "ISO 8601"
 * contract with a misleading "too long" error.
 */
export const MAX_DATE_STRING_LENGTH = 32;

/** Maximum length for product SKUs. */
export const MAX_SKU_LENGTH = 100;

/** Maximum length for product feature names. */
export const MAX_FEATURE_NAME_LENGTH = 100;

/** Maximum length for product feature values. */
export const MAX_FEATURE_VALUE_LENGTH = 500;

/**
 * Maximum number of features that may be attached to a product in one call.
 *
 * The individual name/value lengths are capped separately; without an array
 * bound a single `create_product` call could create an unbounded number of
 * `product_feature` rows (and an unbounded audit-log payload).
 */
export const MAX_PRODUCT_FEATURES_LENGTH = 50;

/** Maximum length for ISO 4217 currency codes (3 characters). */
export const MAX_CURRENCY_CODE_LENGTH = 3;

/** Default currency code for products when none is specified. */
export const DEFAULT_CURRENCY_CODE = "USD";

/** Maximum length for universal search query terms. */
export const MAX_SEARCH_QUERY_LENGTH = 200;

/** Maximum length for error codes in explain_error tool. */
export const MAX_ERROR_CODE_LENGTH = 50;

/** Maximum length for agent descriptions. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 1000;

/** Maximum length for canonical UUID strings (8-4-4-4-12 format = 36 chars). */
export const MAX_UUID_STRING_LENGTH = 36;

/** Maximum length for agent version strings. */
export const MAX_VERSION_LENGTH = 64;

/** Maximum number of capabilities an agent can have. */
export const MAX_CAPABILITIES_LENGTH = 50;

/** Maximum number of entity types an agent can be allowed to interact with.
 *  `AgentRegistry.allowedEntityTypes` is a free-form JSON array with no
 *  database-side bound, so the cap must be enforced at every layer that
 *  accepts it (MCP Zod schema + service validation). */
export const MAX_ALLOWED_ENTITY_TYPES_LENGTH = 50;

/** Maximum length for a single capability string. */
export const MAX_CAPABILITY_STRING_LENGTH = 100;

// ─── Agent Limits ──────────────────────────────────────────────

/** Default max tool calls per conversation for new agents. */
export const DEFAULT_MAX_TOOL_CALLS_PER_CONVERSATION = 100;

/** Min max tool calls per conversation for an agent. */
export const MIN_MAX_TOOL_CALLS_PER_CONVERSATION = 1;

/** Max max tool calls per conversation for an agent. */
export const MAX_MAX_TOOL_CALLS_PER_CONVERSATION = 10000;

/** Default max concurrent conversations for a new agent. */
export const DEFAULT_MAX_CONCURRENT_CONVERSATIONS = 5;

/** Min max concurrent conversations for an agent. */
export const MIN_MAX_CONCURRENT_CONVERSATIONS = 1;

/** Max max concurrent conversations for an agent. */
export const MAX_MAX_CONCURRENT_CONVERSATIONS = 100;

/** Default rate limit (calls per minute) for a new agent. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

/** Min rate limit (calls per minute) for an agent. */
export const MIN_RATE_LIMIT_PER_MINUTE = 1;

/** Max rate limit (calls per minute) for an agent. */
export const MAX_RATE_LIMIT_PER_MINUTE = 1000;

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

/**
 * Default maximum number of memoised tenant-client methods.
 *
 * Shared so the PrismaService (which reads the env override) and the
 * `createTenantClient` factory in @besterp/database (which applies the
 * fallback) cannot drift apart.
 */
export const DEFAULT_MAX_METHOD_CACHE_SIZE = 1000;

/**
 * Default maximum number of memoised tenant-client model delegates.
 * See {@link DEFAULT_MAX_METHOD_CACHE_SIZE}.
 */
export const DEFAULT_MAX_DELEGATE_CACHE_SIZE = 50;

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

/** Maximum length for a single error message line in the MCP error-handler stderr log. */
export const MAX_ERROR_LOG_LINE_LENGTH = 500;

/**
 * Maximum length of an agent-facing error message.
 *
 * Every agent-facing error surface (the MCP error-handler's `message`, the
 * tool registry's INVALID_INPUT summary) is capped at this length so a single
 * error can never return a multi-hundred-KB payload to the agent. The
 * detailed issue list stays available programmatically via `context.issues`.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 2000;

/**
 * The maximum length of the `tool_called` column in the durable audit row.
 *
 * The column is an unbounded `text`, and the audit sink records a
 * CALLER-SUPPLIED tool name on the rejection path (a hallucinated tool
 * name), so the value must be bounded like every other durable column.
 */
export const MAX_TOOL_NAME_LENGTH = 200;

/**
 * Maximum number of Zod issues reported back to the agent for a single
 * invalid tool input.
 */
export const MAX_VALIDATION_ISSUES = 50;

/**
 * Maximum length of a single Zod issue message reflected to the agent.
 *
 * A Zod issue message can embed the offending input verbatim (e.g. a 100 KB
 * string field), so each issue message — and each issue's `received` value —
 * must be bounded independently of the aggregate issue count.
 */
export const MAX_VALIDATION_ISSUE_MESSAGE_LENGTH = 500;

// ─── Auth Config ──────────────────────────────────────────────

/** Regex for validating JWT_EXPIRES_IN duration format (e.g., "24h", "60m", "7d").
 *  Rejects a leading zero and bounds the magnitude (`[1-9]\d{0,9}`) so a
 *  degenerate value cannot be configured. A bare `0s` would expire every token
 *  immediately. The pattern itself still permits a very large magnitude, so
 *  the ACTUAL lifetime cap (MAX_JWT_EXPIRES_IN_DAYS) is enforced separately by
 *  `validateJwtExpiresIn` in main.ts, which parses the matched value and
 *  rejects a total duration above the maximum. */
export const JWT_EXPIRES_IN_REGEX = /^([1-9]\d{0,9})([smhd])$/;

// ─── Confirmation Gate ──────────────────────────────────────────

/** Minimum length for an agent confirmation string.
 *  A confirmation shorter than this cannot carry a meaningful justification
 *  for a high-risk operation. Centralised here so the MCP confirmation gate
 *  and every other surface that reasons about confirmations share one bound. */
export const MIN_CONFIRMATION_LENGTH = 10;

/** Maximum length for a confirmation string (prevents bloat in audit rows). */
export const MAX_CONFIRMATION_LENGTH = 500;

// ─── Middleware Constants ──────────────────────────────────────

/** Threshold after which a "pending" idempotency record is considered stale.
 *  If the server crashes after creating a pending record but before completing
 *  it, the record blocks retries for 24h. A 60-second threshold allows recovery. */
export const IDEMPOTENCY_STALE_PENDING_THRESHOLD_MS = 60_000;

/** Maximum concurrent audit log writes to prevent memory pressure under DB slowdown. */
export const MAX_CONCURRENT_AUDIT_WRITES = 100;

/** Maximum queued audit entries before dropping to prevent unbounded memory growth. */
export const MAX_AUDIT_QUEUE_SIZE = 1000;

/** Maximum time (ms) a write can wait in the audit write queue before being dropped. */
export const AUDIT_WRITE_QUEUE_TIMEOUT_MS = 5_000;

/** Timeout for Prisma interactive transactions (ms).
 *  Used by the domain services for their multi-statement transactions. */
export const TX_TIMEOUT_MS = 10_000;

/**
 * Timeout for the per-operation transactions opened by the tenant-scoped
 * Prisma client (ms).
 *
 * Distinct from {@link TX_TIMEOUT_MS} on purpose: the tenant-scoped client
 * wraps EVERY model operation in its own short transaction that only sets
 * the RLS context and runs one query, while `TX_TIMEOUT_MS` bounds the
 * multi-statement transactions the domain services open. Both values used to
 * live as private constants in their own modules (`rls-extension.ts`,
 * `tenant.ts`), so the same "transaction timeout" concept had two
 * un-discoverable definitions — centralising them here makes the contract
 * explicit.
 */
export const TENANT_SCOPE_TX_TIMEOUT_MS = 30_000;

/** Maximum accepted length for a client-supplied request ID (the
 *  `x-request-id` header). Centralised with every other length limit so the
 *  bound is discoverable from one place. */
export const MAX_REQUEST_ID_LENGTH = 128;

/** Timeout for Redis health probe connections (ms). */
export const REDIS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Default ioredis connect timeout (ms) for the BullMQ queue connection.
 */
export const REDIS_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Maximum number of Redis reconnection attempts before the queue gives up.
 *
 * Mirrors the BullMQ retry backoff constants below — the retry policy was
 * split across two files before this was centralised.
 */
export const REDIS_MAX_RETRIES = 10;

/**
 * Minimum length (characters) of a JWT secret.
 *
 * 32 hex characters = 128 bits of entropy, which is the minimum for a
 * symmetric HMAC signing key.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * TTL of the cached Redis health-probe result (ms).
 *
 * The anonymous /api/health endpoint is polled every few seconds by load
 * balancers; without a cache each poll opened a fresh Redis socket.
 */
export const REDIS_PROBE_CACHE_TTL_MS = 5_000;

/** Maximum size (bytes) for the Redis probe response buffer (DoS guard). */
export const MAX_RESPONSE_BUFFER_BYTES = 1_024;

/** Timeout for the /health/ready endpoint check (ms). */
export const READY_CHECK_TIMEOUT_MS = 5_000;

/** Preview length (bytes) when a payload is truncated. */
export const TRUNCATE_PREVIEW_BYTES = 1024;

/** Maximum length for free-text MCP tool filters (e.g. entity name in list_available_tools). */
export const MAX_ENTITY_LENGTH = 64;

/** Maximum allowed JWT token lifetime in days. */
export const MAX_JWT_EXPIRES_IN_DAYS = 30;

// ─── Redis / BullMQ ──────────────────────────────────────────────

/** Base delay (ms) between BullMQ Redis reconnect retries, before jitter. */
export const BULLMQ_RETRY_BASE_DELAY_MS = 200;

/** Maximum delay (ms) for BullMQ Redis reconnect retries (capped, before jitter). */
export const BULLMQ_RETRY_MAX_DELAY_MS = 5_000;

/** Maximum jitter (ms) added to BullMQ Redis reconnect retry delays. */
export const BULLMQ_RETRY_MAX_JITTER_MS = 200;

// ─── Redis ─────────────────────────────────────────────────────

/** Default Redis port when REDIS_PORT is unset in development. */
export const DEFAULT_REDIS_PORT = 6380;

/**
 * Application-scoped advisory lock key for the idempotency cleanup script.
 *
 * Two concurrent runs of the cleanup script (e.g., overlapping cron triggers)
 * serialise on this lock so they don't double-scan the same rows. Exported
 * here so both the cleanup script and any future concurrent-job script share
 * the same key — previously each script defined its own literal, creating a
 * risk that two scripts would collide on different keys and run concurrently.
 *
 * Value: 0x626573746572 ('bester' in ASCII hex bytes). Picked to fit
 * comfortably within Number.MAX_SAFE_INTEGER (< 2^53) because Prisma binds
 * JS numbers as float8 on the wire and pg_try_advisory_lock(bigint) has no
 * implicit cast from double precision — a value outside the safe integer
 * range would round and fail.
 */
export const ADVISORY_LOCK_KEY_CLEANUP_IDEMPOTENCY = 0x626573746572;

/**
 * Resolve whether a Redis connection should use TLS.
 *
 * Defaults: enabled in non-development, disabled in development.
 * Override via `REDIS_TLS`: set to `0`, `false`, or `no` to disable;
 * set to `1`, `true`, or `yes` to enable.
 *
 * Shared between the BullMQ queue module and the Redis health probe so
 * both surfaces agree on when TLS is required — preventing a scenario
 * where the health check passes over plaintext while the queue uses TLS
 * (or vice versa), which would hide configuration drift from operators.
 */
export function resolveRedisTls(): boolean {
  // `normalizeEnvironmentValue` applies trim + lowercase. Trimming matters
  // because `" true "` (whitespace-padded) is a common copy/paste artefact and
  // would silently fall through to the environment default instead of
  // enabling TLS.
  const raw = normalizeEnvironmentValue(process.env.REDIS_TLS) ?? "";
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  return !isDev();
}

/**
 * Normalize NODE_ENV: trim surrounding whitespace and lowercase.
 *
 * Trimming matters because `" production "` (whitespace-padded) would bypass
 * every normalized NODE_ENV check in main.ts, QueueModule, HealthService,
 * and standalone scripts — exactly the class of silent config drift the
 * lowercase normalization was added to prevent.
 *
 * Exported from @besterp/shared so standalone scripts (seed, cleanup) that
 * do not run through main.ts's normalizeEnvironment() can still use the
 * same normalization contract without importing from @besterp/api.
 */
export function normalizeEnvironmentValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase();
}

/**
 * Normalized development-environment check.
 *
 * Returns true when NODE_ENV has been normalised (via bootstrap-config's
 * normalizeEnvironmentValue) to the literal string "development". Centralising
 * this in @besterp/shared ensures every surface — the REST domain-exception
 * filter, the health probe, and future modules — uses the same check rather
 * than duplicating `process.env.NODE_ENV === "development"` inline, which is
 * easy to get wrong (e.g. casing, missing trim) and silently inconsistent.
 */
export function isDev(): boolean {
  return normalizeEnvironmentValue(process.env.NODE_ENV) === "development";
}

/**
 * Normalized production-environment check.
 *
 * Returns true only when NODE_ENV is the literal string "production". This is
 * the complement of {@link isDev} but NOT equivalent to `!isDev()`: values
 * such as "staging", "test", or undefined are neither development nor
 * production, and should NOT be treated as production for the purposes of
 * information-disclosure guards. Mirrors the inline `process.env.NODE_ENV ===
 * "production"` checks that existed in health.service.ts and health.controller.ts.
 */
export function isProd(): boolean {
  return normalizeEnvironmentValue(process.env.NODE_ENV) === "production";
}

/** Maximum recursion depth for nesting-depth guards across hash, truncate, and sanitize paths. */
export const MAX_NESTING_DEPTH = 100;

/** Number of bytes in one mebibyte (MiB). Centralised so health-service byte→MB
 *  conversions and any future consumer share the same literal instead of each
 *  writing `1024 * 1024` inline. */
export const BYTES_PER_MB = 1024 * 1024;
