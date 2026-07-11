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

1. **🟡 `main.ts` — JWT_SECRET weak-secret heuristic flagged legitimate
   high-entropy secrets as weak (false positive).** The pattern
   `/^(0{32}|[a-f]{32})$/i` was documented as catching "all-same-case hex (no
   entropy)", but `[a-f]{32}` matches **any** 32-character string composed
   solely of `a–f` letters — e.g. `"abcdefabcdefabcdefabcdefabcdefab"` (≈82 bits
   of entropy) — not just a single repeated character. Operators using a random
   16-byte hex secret that happened to contain no digits received a spurious
   "appears to be a weak or default value" warning.

   Fixed by extracting the heuristics into a standalone, unit-tested module
   `apps/api/src/auth/secret-strength.ts` (`isWeakSecret` /
   `MIN_JWT_SECRET_LENGTH`) and replacing the buggy pattern with
   `/^(.)\1{31,}$/`, which matches a single character repeated for the whole
   string — the correct expression of "zero entropy" (`0`×32, `f`×32, spaces,
   etc.) without false-positiving on real hex secrets. `main.ts` now imports and
   delegates to the helper. The previous in-place pattern loop (which could not
   be unit-tested because the bootstrap calls `process.exit`) is replaced by a
   function with a dedicated spec covering the regression.

2. **🟢 `auth.module.ts` — `JWT_EXPIRES_IN` warning regex diverged from the
   authoritative check in `main.ts`.** `auth.module.ts` used
   `/^\d+\s*[smhd]$/` (allowing optional whitespace) while `main.ts` validates
   strictly with `/^\d+[smhd]$/` and exits on mismatch. Because ESM
   module-level code runs before `main.ts`'s `validateEnvironment()`, the
   module-level warning is the first signal an operator sees — it must agree
   with the hard gate or it warns about values the app will accept (or stays
   silent about values the app will reject). Aligned the regexes so the warning
   is a faithful preview of the startup gate.

3. **🟢 `cleanup-expired-idempotency.ts` — emoji in a structured stderr line.**
   The failure log emitted `❌ Cleanup failed:` while every other structured
   log line in the middlewares and this script is plain ASCII JSON-ish text.
   Removed the emoji for consistency with the rest of the operator-log output
   (and to avoid glyph/encoding surprises in log shippers that don't expect
   multi-byte symbols on the error stream).

### Reviewed and considered sound (no change needed)

Carried forward from rounds 1–11 — spot-checked again this round and still
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
The 3 fixes above are covered by tests (all quality gates green; +6 new unit
tests in `secret-strength.spec.ts`). Remaining observations are low-severity and
do not require immediate code changes:

- `hashInput` has no input size limit (mitigated by the 100 KB body-parser cap).
- `updateIdempotencyRecordWithRetry` retries on any error including P2025
  (record already cleaned up); the resulting `ConcurrencyConflictError` message
  is slightly imprecise in that edge case but harmless.
- The two retained complexity lint warnings reflect intentional, well-commented
  branching and would require splitting cohesive functions purely to satisfy
  the metric.
