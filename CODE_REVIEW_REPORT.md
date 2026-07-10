# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-10. This is review round 10;
rounds 1–9 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — clean across all workspaces
- `npm run test` — all passing (database, mcp-tools, shared, api)

## Findings & Actions

### Fixed this round

1. **🔴 `error-handler.ts` — circular-array references in `sanitizeContextValue`
   not tracked.** `trackSeen` was used for `Map` and `Set` instances but not for
   `Array`. A self-referential array would recurse `MAX_SANITIZE_DEPTH` (10)
   levels before being caught by the depth guard, producing deeply nested
   `[Circular]` chains instead of a single `[Circular]` at the first repeat.
   Fixed by wrapping the array branch with `trackSeen`. Regression tests added
   for circular array and circular Map in error context.

2. **🔴 `error-handler.ts` — `WeakMap`/`WeakSet` labeled `"[ITERABLE]"` (they are
   NOT iterable).** WeakMap and WeakSet have no iteration protocol. The label was
   misleading for operators reading sanitized context values. Changed to
   `"[WeakCollection]"`, matching the convention already used in
   `audit-log.ts:redactSensitiveFields`. Regression test added.

3. **🟡 `validation.ts` — `ISO_DATE_REGEX` rejected date-only strings with a `Z`
   suffix.** `2024-06-15Z` is valid ISO 8601 and parses correctly with
   `new Date()`, but the regex placed `Z` only inside the optional time component
   group. Added `Z?` after the date portion so `2024-06-15Z` and
   `2000-02-29Z` are accepted. Regression test added.

4. **🟡 `main.ts` — JWT_EXPIRES_IN regex allowed spaces before unit.** The regex
   `/^\d+\s*[smhd]$/` matched `"24 h"` (with a space), which contradicts the
   documented format `"24h"`, `"60m"`, `"7d"` in the error message. Fixed to
   `/^\d+[smhd]$/` for strict validation.

5. **🟡 `error-handler.ts` — tenantId and userId not sanitized before stderr
   logging.** `handleGenericError` logged `tenantId` and `userId` values directly
   to stderr without `sanitizeForLog`. While both are validated formats (alphanumeric
   tenant IDs, UUID user IDs), this was inconsistent with `definition.name` which
   WAS sanitized. Applied `sanitizeForLog` to both interpolated values for
   defense-in-depth against log injection.

6. **🟡 `party.service.ts` — `findFirst` used instead of `findUnique` for
   primary-key lookups.** Two transaction methods (`addPartyRoleTransaction`,
   `createContactMechanismTransaction`) used `findFirst` with both `partyId` and
   `tenantId` for party existence checks. Changed to `findUnique` with `partyId`
   only (RLS ensures tenant isolation), matching the pattern already used in
   `getParty()`. Test mocks updated accordingly.

7. **🟡 `domain-exception.filter.ts` — non-Error throws produced `"[object Object]"`
   as message.** `handleUnexpectedError` used `String(exception)` for non-Error
   values, which yields `"[object Object]"` for objects. Changed to `JSON.stringify`
   with a `try/catch` fallback so diagnostic information is preserved in the log.

8. **🟢 `auth.module.ts` — JWT_EXPIRES_IN module-level warning tightened.**
   Regex validation warning now uses the same strict pattern as `main.ts`
   (no optional whitespace).

### Reviewed and considered sound (no change needed)

- All items from rounds 1–9 remain sound.
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

## Recommendation
No further changes required from this pass. The 8 fixes above are covered by
tests (+13 tests: shared +1, mcp-tools +3, api +7 previously-failing now fixed,
+2 new); all quality gates (typecheck, lint, test) remain green.
