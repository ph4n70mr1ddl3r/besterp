# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-11. This is review round 12;
rounds 1–11 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors (2 pre-existing cyclomatic-complexity warnings:
  `truncate.ts::truncateValue` and `party.service.ts::handleTransactionError`,
  both from legitimate type/code branching and intentionally retained)
- `npm run test` — all passing: shared 133, mcp-tools 89, database (RLS tests
  skipped without a live DB), api 237

## Findings & Actions

### Fixed this round

1. **🟡 `crypto.ts` `hashInput` — WeakMap/WeakSet silently hashed as `{}` (hash
   collision / silent data loss).** `sortKeysDeep` has explicit branches for `Map`
   and `Set` (converted to sorted arrays) and throws for `function` values, but
   no branch for `WeakMap`/`WeakSet`. These are non-enumerable, so they fell
   through `sortObject` → `serializeSpecialObject` → `sortPlainObject`, where
   `Object.keys()` returns `[]`. Result: `hashInput(new WeakMap())` produced the
   **same hash as `hashInput({})`** (and every distinct WeakMap collided with
   every other) — confirmed by probe. Both `audit-log.ts` and `error-handler.ts`
   already guard Weak collections (`"[WeakCollection]"`); since their entries
   cannot be enumerated they cannot be deterministically hashed, so the correct
   behaviour is to throw `InvalidTypeValueError` (mirroring the existing
   `function` guard), not to silently produce a colliding hash. The guard lives
   in `serializeSpecialObject` (the non-plain-object dispatch point Weak
   collections actually reach) so `sortKeysDeep` keeps its prior cyclomatic
   complexity.

2. **🟡 `audit-log.ts` `redactSensitiveFields` — depth-exceeded returned the raw
   unredacted value (redaction bypass).** `isTerminal` short-circuited to `true`
   when `depth > MAX_REDACTION_DEPTH`, and `redactSensitiveFields` then
   `return value` — the raw object. Because the key-name redaction loop runs
   *inside* `redactSensitiveFields` (after the terminal check), an object
   sitting deeper than the cap was returned whole with its sensitive keys
   never inspected: a `password` buried >10 levels deep would be persisted
   verbatim to `ai_action_log.tool_input`. The sibling `error-handler.ts`
   `sanitizeContextValue` returns `"[Too deep]"` at its cap; for a *redaction*
   function, returning unredacted data is the riskier choice. Fixed by returning
   `"[Too deep]"` at the cap (matching the error-handler) and dropping the
   now-redundant depth clause from `isTerminal`. Verified as a true regression
   test: it fails on the old code (raw `"password":"leak-me"` in the stored row)
   and passes on the fix.

### Reviewed and considered sound (no change needed)

Carried forward from rounds 1–12 — spot-checked again this round and still
sound:

- `crypto.ts`: `sortMap`/`sortSet` pre-computed stringified keys (O(n)
  stringifications), circular-reference detection via the path-scoped
  `ancestors` set (siblings/diamond refs handled correctly, only true cycles
  throw), `Object.create(null)` prototype-pollution defense.
- `sanitize.ts`: `stripHtmlTags` decode/strip loop + DoS caps, bidi/zero-width
  stripping + C1 control stripping in `sanitizeLogMessage`, `safeFromCodePoint`
  lone-surrogate replacement, ordering of ANSI/bidi/control passes.
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
  redaction avoidance (input redacted in `createBaseEntry`).
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
  dev-ephemeral fallback.
- `main.ts`: CORS origin allow-listing on error handlers, body-size cap,
  request-ID validation, graceful shutdown hard-exit timer.
- `domain-exception.filter.ts`: status mapping, production scrubbing of
  HttpException validation arrays, sanitized logging.
- `health.controller.ts` / `health.service.ts`: 503 fail-closed, readiness
  timeout + `.unref()`, production suppression of filesystem paths.
- RLS SQL: FORCE RLS on all tenant tables, empty-GUC guard in policies,
  subtype-table join policies, partial unique index for active roles.

## Recommendation
The 2 fixes above are covered by tests (all quality gates green; +1 unit test in
`crypto.test.ts` for the WeakMap/WeakSet guard, +1 in `middleware.test.ts` for
the depth-redaction guard). Remaining observations are low-severity and
do not require immediate code changes:

- `hashInput` has no input size limit (mitigated by the 100 KB body-parser cap).
- `updateIdempotencyRecordWithRetry` retries on any error including P2025
  (record already cleaned up); the resulting `ConcurrencyConflictError` message
  is slightly imprecise in that edge case but harmless.
- The two retained complexity lint warnings reflect intentional, well-commented
  branching and would require splitting cohesive functions purely to satisfy
  the metric.
