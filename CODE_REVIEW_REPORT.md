# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-11. This is review round 14;
rounds 1–13 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors (2 pre-existing cyclomatic-complexity warnings:
  `truncate.ts::truncateValue` and `party.service.ts::handleTransactionError`,
  both from legitimate type/code branching and intentionally retained)
- `npm run test` — all passing: shared 137, mcp-tools 91, database (RLS tests
  skipped without a live DB), api 237

## Findings & Actions

### Fixed this round

1. **🟡 `audit-log.ts` `isSensitiveField` — camelCase sensitive fields leaked
   past the catch-all redaction regex (redaction bypass).** `SENSITIVE_FIELD_PATTERN`
   delimits keywords with alnum-only lookarounds so `_`/`-` act as separators, but
   the lowercase→uppercase transition does **not**. Consequently the snake_case
   siblings were redacted (`client_secret`, `bearer_token`, `access_token`) while
   their camelCase forms — `clientSecret`, `bearerToken`, `accessToken`,
   `refreshToken`, `userPassword`, `sessionToken` — were persisted verbatim to
   `ai_action_log.tool_input`. Confirmed by probe. These are common OAuth/credential
   field names, so this was a real bypass on a durable, cross-tenant audit table.
   The module comment claimed camelCase was caught, but the implementation only
   delivered that for `auth`-prefixed names via the dedicated `auth(?:token|key|…)?`
   branch. Added a token-based fallback: `splitFieldTokens()` splits a field name at
   snake_case, kebab-case, **and** camelCase boundaries, then checks each token
   against `SENSITIVE_TOKENS` (`password`, `passwd`, `pwd`, `secret`, `token`,
   `credential`, `credentials`). `key` is excluded to avoid over-redacting
   `primaryKey`/`foreignKey`/`sortKey` — key-bearing sensitive fields stay covered
   by the explicit `SENSITIVE_FIELDS` set and the `api[_-]?key` regex. No current
   party-tool field name contains a sensitive token, so there is no over-redaction
   in practice. Verified as a true regression test (fails on the old code, passes
   on the fix).

2. **🟡 `sanitize.ts` `sanitizeLogOutput` — credential-bearing URLs with unlisted
   schemes leaked to operator logs.** The function had explicit patterns for
   postgres/redis/mongodb/mysql/amqp/http(s)/ftp/sftp/ws/wss, but no catch-all for
   other schemes. A driver/library error can embed a credential-bearing URL in any
   scheme (`ssh://user:pass@host`, `ldap://cn=admin:password@host`,
   `vault://token:s3cret@host`) and these passed through verbatim — confirmed by
   probe — leaking inline credentials. Added a generic credential-URL pattern that
   matches `scheme://user:pass@host` for any scheme, placed **after** the
   scheme-specific patterns so they keep their labelled output (`[DATABASE_URL]`,
   `[REDIS_URL]`, …) and the catch-all only fires for what they miss. The pattern
   requires a userinfo segment, so credential-free URLs of arbitrary schemes
   (`file:///etc/passwd`, `custom://host`) are not false positives. Verified by
   regression tests covering ssh/ldap/ldaps/vault, mid-sentence credentials, the
   no-false-positive case, and labelled-output preservation.

### Reviewed and considered sound (no change needed)

Carried forward from rounds 1–14 — spot-checked again this round and still
sound:

- `crypto.ts`: `sortMap`/`sortSet` pre-computed stringified keys (O(n)
  stringifications), circular-reference detection via the path-scoped
  `ancestors` set (siblings/diamond refs handled correctly, only true cycles
  throw), `Object.create(null)` prototype-pollution defense, `serializeSpecialObject`
  WeakMap/WeakSet guard (round 13).
- `sanitize.ts`: `stripHtmlTags` decode/strip loop + DoS caps, bidi/zero-width
  stripping + C1 control stripping in `sanitizeLogMessage`, `safeFromCodePoint`
  lone-surrogate replacement, ordering of ANSI/bidi/control passes; generic
  credential-URL catch-all now closes the unlisted-scheme gap (this round).
- `validation.ts`: `ISO_DATE_REGEX` offset ranges (+14:00 / -12:00 maxima,
  minute precision), `isValidISODate` calendar/leap-year enforcement,
  `EMAIL_REGEX` (length-capped at the schema/DTO layer to bound backtracking).
- `errors.ts`: `DomainError.toJSON` cause-depth limiting and stack omission,
  `getErrorCode` null-safe extraction.
- `idempotency.ts`: acquire state machine + stale-pending reset,
  non-P2034 → `SERVICE_UNAVAILABLE` differentiation, `delay().unref()`,
  serializable-transaction race guard.
- `audit-log.ts`: backpressure slot accounting + queue timeout/drop counters,
  `SENSITIVE_FIELD_PATTERN` alnum lookarounds for snake/camel-case, double
  redaction avoidance (input redacted in `createBaseEntry`), depth-cap returns
  `[Too deep]` not raw value (round 13), token-based camelCase fallback (this round).
- `error-handler.ts`: Prisma-code → DomainError mapping table, connection-error
  set, `sanitizeContextValue` depth + circular guards.
- `tool-registry.ts`: registration-time validation (name, description,
  `riskLevel`, `safeParse` runtime guard), hallucination `findSimilarNames`.
- `truncate.ts`: `safeSliceUtf8` continuation-byte walk-back, Map/Set
  normalisation, never-throws contract.
- `rls-extension.ts` + `tenant.ts`: `validatePrismaClientForRls` checks both
  `$transaction` and `$executeRaw`, blocked-method sets, LRU caches,
  `FinalizationRegistry` race guards, parameterized `set_tenant_context()`.
- `prisma.service.ts`: WeakRef tenant cache + LRU eviction + GC race guard,
  sanitized connection/disconnect logging.
- Auth: `JwtStrategy` claim trimming + length caps + tenantId format
  re-validation, `TenantGuard` type guards, `resolveJwtSecret` caching +
  dev-ephemeral fallback, `isWeakSecret` single-repeated-char heuristic (round 12).
- `main.ts`: CORS origin allow-listing on error handlers, body-size cap,
  request-ID validation, graceful shutdown hard-exit timer.
- `domain-exception.filter.ts`: status mapping, production scrubbing of
  HttpException validation arrays, sanitized logging.
- `health.controller.ts` / `health.service.ts`: 503 fail-closed, readiness
  timeout + `.unref()`, production suppression of filesystem paths.
- RLS SQL: FORCE RLS on all tenant tables, empty-GUC guard in policies,
  subtype-table join policies, partial unique index for active roles.

## Recommendation
The 2 fixes above are covered by tests (all quality gates green; +3 unit tests in
`sanitize.test.ts` for the credential-URL guard, +1 in `middleware.test.ts` for the
camelCase redaction guard). Remaining observations are low-severity and
do not require immediate code changes:

- `hashInput` has no input size limit (mitigated by the 100 KB body-parser cap).
- `updateIdempotencyRecordWithRetry` retries on any error including P2025
  (record already cleaned up); the resulting `ConcurrencyConflictError` message
  is slightly imprecise in that edge case but harmless.
- `error-handler.ts` `sanitizeContextValue` does not redact by field name (unlike
  `audit-log.ts` `redactSensitiveFields`); it sanitizes all string values uniformly
  via `sanitizeForLogOutput`. This is acceptable because `DomainError.context` is
  application-constructed (no raw user secrets by design), but a future DomainError
  that places a secret in `context` would surface it to the AI agent. Defense-in-depth
  candidate, not an active bug.
- The two retained complexity lint warnings reflect intentional, well-commented
  branching and would require splitting cohesive functions purely to satisfy
  the metric.
