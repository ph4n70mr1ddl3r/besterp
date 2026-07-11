# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-11. This is review round 11;
rounds 1–10 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — clean across all workspaces
- `npm run test` — all passing (database, mcp-tools, shared, api)

## Findings & Actions

### Fixed this round

1. **🟡 `crypto.ts` — O(n log n) `JSON.stringify` calls in `sortMap` and `sortSet`
   comparators.** Each comparison in `Array.sort` re-stringified both keys/values,
   resulting in O(n log n) stringifications total. For Maps with 1,000 entries this
   triggered ~10,000 redundant `JSON.stringify` calls. Pre-computed stringified forms
   into a `str` property before sorting, reducing to O(n) stringifications. Applied
   to both `sortMap` (line 45–48) and `sortSet` (line 58–61).

2. **🟡 `sanitize.ts` — Unicode bidirectional override/isolate characters not
   stripped in `sanitizeLogMessage`.** U+202A–U+202E (bidi overrides),
   U+2066–U+2069 (bidi isolates), U+200B/U+200C/U+200D (zero-width chars),
   U+2060 (word joiner), and U+FEFF (BOM) were not stripped. These can manipulate
   terminal display to hide injected log content or create misleading log entries
   (e.g., U+202E RIGHT-TO-LEFT OVERRIDE). Added a regex pass before the control-
   character replacement to strip these characters.

3. **🟡 `health.service.ts` — Version endpoint leaks filesystem paths in production.**
   `packageInfoError` (which contains OS-level file paths from `fs.readFile` failures)
   was included in the `/api/health/version` response regardless of environment.
   Conditionally suppressed in production to prevent information disclosure about
   the container/server layout.

4. **🟡 `domain-exception.filter.ts` — Log injection via user-controlled error
   messages.** `handleDomainError` logged `exception.message` verbatim (line 79)
   without `sanitizeForLogOutput`, while the "unknown code" and "unexpected error"
   paths DID sanitize. Applied `sanitizeForLogOutput` to the warn log for
   consistency and defense-in-depth against log injection via crafted error messages.

5. **🟡 `main.ts` — CORS error handlers missing `Access-Control-Allow-Credentials`
   header.** The body-parser error handlers and catch-all error handler set
   `Access-Control-Allow-Origin` but not `Access-Control-Allow-Credentials: true`.
   Browsers with `withCredentials: true` would reject these error responses.
   Added the credentials header to all three CORS error handler sites.

6. **🟡 `cleanup-expired-idempotency.ts` — Script silently no-ops when
   `DATABASE_ADMIN_URL` is missing.** Without the admin URL, the script connects
   as the app role, which cannot see expired records due to RLS policies. The script
   logs "Records deleted: 0" and exits successfully — expired records accumulate
   forever. Added a hard requirement for `DATABASE_ADMIN_URL` with a clear error
   message explaining why.

7. **🟡 `rls-extension.ts` — `validatePrismaClientForRls` only checks
   `$transaction`, not `$executeRaw`.** The `set_tenant_context()` call uses
   `$executeRaw`, but validation didn't check for it. A mock/stub with `$transaction`
   but no `$executeRaw` would pass validation and fail at query time. Added
   `$executeRaw` to the check. Fixed the corresponding test to properly test the
   `$executeRaw`-missing case (previously tested a mock missing both methods).

8. **🟢 `tool-registry.ts` — Missing `description` validation in `register()`.**
   A tool registered with `description: ""` or `undefined` would pass all checks
   and appear in discovery info with an empty description. Added validation that
   `description` is a non-empty string at registration time.

9. **🟢 `idempotency.ts` — Non-P2034 acquire errors misclassified as
   `IDEMPOTENCY_CONTENTION`.** Connection failures, auth errors, and schema
   mismatches (non-P2034) returned `{ existingRecord: null, recordCreated: false }`,
   which the caller interpreted as serialization contention and told the AI agent
   to "retry with a new idempotency key." A new key won't help for infrastructure
   failures. Added an `unavailable` flag to distinguish non-contention failures,
   surfaced as `SERVICE_UNAVAILABLE` with an appropriate message.

### Reviewed and considered sound (no change needed)

- All items from rounds 1–10 remain sound.
- `stripHtmlTags` decode/strip loop, DoS caps, entity-decoding order, C0/DEL
  stripping, and null-byte redundant-but-harmless double-strip.
- Idempotency acquire/reset state machine, serializable-transaction race guard,
  Zod pre-parse for hash determinism (double parse is a conscious design tradeoff).
- Audit-log backpressure slot accounting, queue timeout/unref, drop counters,
  `releaseWriteSlot` concurrency (the transient-exceed scenario is bounded by
  the sequential event loop in practice).
- RLS proxy blocked-method sets, LRU caches, `$transaction` interception,
  `FinalizationRegistry` race guards, and non-function delegate fallthrough.
- JWT secret resolution/caching, tenant/agent ID trimming.
- Pluralize `preserveCasing` fix, consonant-Y/sibilant/consonant-O rules,
  `-quy` edge case noted but out of scope for ERP domain.
- Error-handler Prisma-code mapping (`P2000/P2002/P2003/P2014/P2021/P2024/P2025/P2034`),
  connection error codes, and `entityName` fallback ordering.
- Tool-registry `riskLevel` validation at registration, `findSimilarNames`
  minimum-length guard (2-char threshold is intentional for known shortening
  patterns like `gt`→`get_type_table_values`).
- `truncate.ts` `safeSliceUtf8` continuation-byte walk-back.
- `crypto.ts` circular-reference detection and `Object.create(null)` prototype
  pollution defense.
- `party-tools.ts` Zod schema builders (`sanitizedString`, `uuidParam`,
  `optionalIsoDate`) and `superRefine` cross-field validation.
- `discovery-tools.ts` runtime Prisma delegate validation.
- `ISO_DATE_REGEX` `Z?` suffix on date-only strings (intentional per round 10).

## Recommendation
The 9 fixes above are covered by tests (all quality gates green). Remaining
findings from this round are low-severity design/operational observations that
do not require immediate code changes:

- `hashInput` has no input size limit (defense-in-depth concern for very large
  payloads — mitigated by the 100 KB body-parser limit in `main.ts`)
- `errors.ts` `context` property is mutable after construction (defense-in-depth —
  callers should not mutate post-construction)
- Seed upserts never update existing records (design choice for idempotent seeding)
- `findSimilarNames` O(N×L²) is acceptable for <100 tools
