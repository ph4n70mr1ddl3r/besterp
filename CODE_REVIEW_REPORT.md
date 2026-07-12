# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-12. This is review round 21;
rounds 1–20 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 137, mcp-tools 92, database (RLS tests
  skipped without a live DB), api 238

## Findings & Actions

### Fixed this round

1. **🟡 `party.service.ts::checkEmailDuplicate` — duplicate-email redaction was
   malformed for short local parts, leaking a structural artifact into the error
   message + `context`.** The redaction computed
   `${email.slice(0, 2)}***@${domain}` unconditionally. For a valid address with
   a single-character local part (`a@x.com` — accepted by `EMAIL_REGEX`), the
   2-char slice spans into the `@`, producing `a@***@x.com` (a malformed
   address emitted to the AI agent and stored in the `DuplicateEntityError`
   context). Confirmed by probe. Fixed by slicing
   `min(2, atIdx)` so the preview never crosses the `@` boundary. Behaviour is
   unchanged for local parts ≥ 2 chars (`ab@x.com` → `ab***@x.com`); the 1-char
   case is now `a***@x.com`. This path was previously untested — added a
   regression test that exercises `emailAddress.findFirst` returning an existing
   match and asserts the redacted shape for a short local part.

2. **🟡 `idempotency.ts::updateIdempotencyRecordWithRetry` — wasted all retries
   (and backoff latency) when the record expired mid-operation (P2025).** After
   a tool completes, the result is persisted by updating the pending record. If
   the 24h-TTL cleanup job (or a concurrent reset) removed the row between
   acquire and update, the update throws Prisma `P2025` ("record not found").
   Because `P2025` was not special-cased, the loop retried it
   `IDEMPOTENCY_MAX_RETRIES` times — each retry re-throws `P2025` (the row is
   gone permanently; it can never succeed) — burning `IDEMPOTENCY_RETRY_BASE_DELAY_MS
   * (1+2) = 150 ms` of backoff before throwing `ConcurrencyConflictError`. That
   error was then swallowed by both call sites in `executeAndUpdate` (the success
   path and the throw path each wrap the call in `try/catch` + `logIdempotencyWarn`),
   so the only observable effect was the wasted latency and a misleading
   "could not be updated after N attempts" warning. Now `P2025` is detected on
   the first attempt and short-circuits: log once (noting the result won't be
   replayable) and return, since there is nothing to update and both callers
   already tolerate a non-throwing return. Other transient errors keep the
   existing retry-then-throw behaviour. Added a regression test asserting a
   single `update` attempt and no `ConcurrencyConflictError` propagation.

### Minor clarity (same idempotency error-handling area)
- Merged two adjacent `if (code !== "P2034")` blocks in
  `acquireIdempotencyRecord`'s catch into one. They shared an identical
  condition and were at risk of diverging; collapsing them is behaviour-
  preserving and removes a redundant conditional.

### Fixed this round

1. **🟢 `error-handler.ts::sanitizeObject` — `DomainError.context` was not
   redacted by field name, so a secret placed under a sensitive-named key
   (`password`, `apiKey`, `clientSecret`, …) would reach the AI agent verbatim
   even though the audit-log middleware redacted the same value.**
   `sanitizeContextValue` only scrubbed string *values* (URL/path redaction +
   control-char stripping); it never inspected *keys*. The audit-log's
   `redactSensitiveFields` does both, so the two agent-facing surfaces
   diverged. This was the defense-in-depth gap the round-20 report explicitly
   flagged as a candidate. Fixed by extracting the sensitive-field detection
   (`isSensitiveField`, `SENSITIVE_FIELDS`, `SENSITIVE_FIELD_PATTERN`,
   `SENSITIVE_TOKENS`, `splitFieldTokens`) into a shared
   `middleware/sensitive-fields.ts` module (behaviour-preserving for the
   audit-log, which now imports it), and having `sanitizeObject` redact any
   value whose key `isSensitiveField` flags to `[REDACTED]` before the
   value-level scrub runs. Probed all 34 field names used across every
   existing `DomainError` call site — none is flagged sensitive, so the change
   is behaviour-preserving in practice and only closes the future-leak gap.
   Added regression tests covering explicit, snake_case, and camelCase
   sensitive keys, benign-field preservation, and URL/path-scrub composition.

### Reviewed and considered sound (no change needed)

Carried forward from rounds 1–20 — spot-checked again this round and still
sound:

- `crypto.ts`: `sortMap`/`sortSet` pre-computed stringified keys (O(n)
  stringifications), circular-reference detection via the path-scoped
  `ancestors` set (siblings/diamond refs handled correctly, only true cycles
  throw), `Object.create(null)` prototype-pollution defense, `serializeSpecialObject`
  WeakMap/WeakSet guard (round 13).
- `sanitize.ts`: `stripHtmlTags` decode/strip loop + DoS caps, bidi/zero-width
  stripping + C1 control stripping in `sanitizeLogMessage`, `safeFromCodePoint`
  lone-surrogate replacement, ordering of ANSI/bidi/control passes; generic
  credential-URL catch-all (round 14).
- `validation.ts`: `ISO_DATE_REGEX` offset ranges (+14:00 / -12:00 maxima,
  minute precision), `isValidISODate` calendar/leap-year enforcement,
  `EMAIL_REGEX` (length-capped at the schema/DTO layer to bound backtracking).
- `errors.ts`: `DomainError.toJSON` cause-depth limiting and stack omission,
  `getErrorCode` null-safe extraction.
- `idempotency.ts`: acquire state machine + stale-pending reset,
  non-P2034 → `SERVICE_UNAVAILABLE` differentiation, `delay().unref()`,
  serializable-transaction race guard; P2025 mid-flight expiry now short-circuits
  (this round).
- `audit-log.ts`: backpressure slot accounting + queue timeout/drop counters,
  `SENSITIVE_FIELD_PATTERN` alnum lookarounds for snake/camel-case, double
  redaction avoidance (input redacted in `createBaseEntry`), depth-cap returns
  `[Too deep]` not raw value (round 13), token-based camelCase fallback (round 14);
  sensitive-field detection now shared with the error-handler via
  `sensitive-fields.ts` (round 21).
- `error-handler.ts`: Prisma-code → DomainError mapping table, connection-error
  set, `sanitizeContextValue` depth + circular guards; `DomainError.context`
  now redacted by field name via the shared `isSensitiveField` (round 21).
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
The fix above is covered by tests (all quality gates green). Remaining
observations are low-severity and do not require immediate code changes:

- `hashInput` has no input size limit (mitigated by the 100 KB body-parser cap
  and per-field Zod `.max()` limits, and idempotency hashes post-Zod-parse
  data). The `MAX_HASH_DEPTH` recursion cap already bounds stack depth, and the
  body cap bounds the serialized size in practice.
- The two retained complexity lint warnings reflect intentional, well-commented
  branching and would require splitting cohesive functions purely to satisfy
  the metric.

## Resolved candidates
- ~~`error-handler.ts` `sanitizeContextValue` did not redact by field name~~ —
  addressed in round 21 (`DomainError.context` now applies the same
  key-based `isSensitiveField` redaction as the audit-log, via the shared
  `middleware/sensitive-fields.ts` module).
