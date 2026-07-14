# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-14. This is review round 26;
rounds 1–25 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 137, mcp-tools 119, database 25 (10 RLS isolation
  tests skipped without a live DB), api 302

## Findings & Actions

### Fixed this round

1. **🔴 `rls-extension.ts` — silent `undefined` return for non-existent model
   delegates on tenant-scoped proxy.** When accessing a model that doesn't exist
   in the Prisma schema (e.g., `scoped.nonExistentModel`), the Proxy's `get`
   trap returned `undefined` silently. The caller would then hit a confusing
   `TypeError: Cannot read properties of undefined (reading 'findMany')` deep in
   the call stack. Fixed to throw a clear error naming the missing model and
   suggesting schema.prisma as the fix target.

2. **🟡 `party.service.ts` — missing explicit `throw` after `handleTransactionError`
   in 4 catch blocks.** `handleTransactionError` is typed `never` (always throws),
   but the catch blocks in `createPartyTransaction`, `searchParties`,
   `addPartyRoleTransaction`, and `createContactMechanismTransaction` relied
   solely on the `never` return type for TypeScript flow analysis. If
   `handleTransactionError` were ever refactored to not always throw (e.g., for
   a soft-error logging path), the functions would silently return `undefined`.
   Added explicit `throw err` after each call as defense-in-depth.

3. **🟡 `domain-exception.filter.ts` — unsanitized `context` values exposed in
   development HTTP responses.** The `DomainError.context` record carries
   diagnostic fields (field names, received values, invalid inputs). In
   development mode, these were included verbatim in the HTTP response body. If
   a user-supplied value (e.g., a malicious `name` field containing newlines or
   ANSI escapes) was reflected in `context.received`, it could inject false log
   entries when the response body is logged by monitoring tools. Fixed by
   applying `sanitizeLogMessage()` to all string values in the context before
   including them in the response.

4. **🟢 `idempotency.ts` — redundant `length === 0` check.** The guard
   `!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length === 0`
   already catches empty strings via `!idempotencyKey` (empty string is falsy)
   and `typeof !== "string"` (catches non-strings). The explicit
   `length === 0` check was redundant. Removed for clarity.

### Verified clean (no action needed)

- **`sanitize.ts` HTML entity decode order** — `&amp;` decoded last causes
  `&amp;lt;script&amp;gt;` to survive the first decode pass, but the
  `do...while` loop (up to 10 iterations) handles it correctly on subsequent
  passes.
- **`audit-log.ts` fire-and-forget pattern** — `slotAcquired` flag and
  `.finally` guard correctly handle both acquired and not-acquired paths.
- **`rls-extension.ts` for-of closure** — `method` variable is correctly
  scoped per iteration in modern JS.
- **`party-tools.ts` Zod `.pipe().optional()` chains** — validated that
  `undefined` input flows correctly through transforms and optional pipes.

## Test Results

```
shared:    137 passed (4 files)
mcp-tools: 119 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       302 passed (14 files)
────────────────────────────────────
Total:     583 passed, 10 skipped
```

## Resolved candidates (cumulative)
- ~~`sensitive-fields.ts` missing OTP/MFA~~ — addressed in round 22
- ~~`sensitive-fields.ts` missing `dateOfBirth`/`passcode`/`passphrase`~~ —
  addressed in round 25
- ~~`error-handler.ts` `sanitizeContextValue` did not redact by field name~~ —
  addressed in round 21
- ~~`rls-extension.ts` silent undefined for non-existent model delegates~~ —
  addressed in round 26
- ~~`party.service.ts` missing explicit throw after handleTransactionError~~ —
  addressed in round 26
- ~~`domain-exception.filter.ts` unsanitized context in dev responses~~ —
  addressed in round 26
