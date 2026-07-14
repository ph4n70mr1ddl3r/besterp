# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-14. This is review round 27;
rounds 1–26 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 137, mcp-tools 119, database 25 (10 RLS isolation
  tests skipped without a live DB), api 302

## Findings & Actions

### Fixed this round

1. **🟡 `domain-exception.filter.ts` — `DomainError.message` reflected into HTTP
   responses unsanitized.** Round 26 closed the log/response-injection surface on
   `DomainError.context` values but missed the `message` field. DomainError messages
   routinely embed user-supplied input that is only `.trim()`'d upstream — e.g.
   `Invalid fromDate format: ${trimmed}`, `${field} is not a valid ISO 8601 date.
   Received: ${value}`, `Invalid tenant ID: "${preview}"` — so interior control
   characters (newlines, tabs, ANSI escapes) survive into the message. The filter
   sent `exception.message` verbatim into the response body for every non-500
   DomainError, in **both development and production** (unlike context, which is
   dev-only). A value like `fromDate: "x\n[INFO] admin logged in"` would be
   reflected into the response body and, when logged by a monitoring tool/client,
   inject a forged log line. Fixed by applying `sanitizeLogMessage()` to the
   message, mirroring the round-26 context treatment.

2. **🟢 `domain-exception.filter.ts` — `sanitizeContext` did not recurse into nested
   objects.** The `ContextValue` type permits arbitrarily nested objects and arrays,
   but `sanitizeContext` only scrubbed top-level strings and the string elements of
   top-level arrays — a value under a nested key (e.g. `context.input.field`) passed
   through verbatim. No current DomainError call site nests objects in context (all
   are flat), so this was latent rather than exploitable today, but it was an
   incomplete implementation of the stated round-26 goal ("sanitize context values").
   Refactored to a recursive `sanitizeContextValue()` helper that walks the full
   value tree (strings sanitized at every depth; arrays/objects recursed; primitives
   passed through), closing the gap for any future DomainError that nests a
   user-derived value.

### Verified clean (no action needed)

- **`party.service.ts` `getParty` lacks a `try/catch` + `handleTransactionError`
  wrapper** — intentional asymmetry. Unlike the four write methods, `getParty` issues
  a standalone `findUnique` (the tenant-scoped Proxy already wraps it in an RLS
  transaction). A Prisma error here propagates to the MCP `errorHandlerMiddleware`
  (which maps P2002/P2003/P2024/P2025/P2034 to agent-facing codes) or the REST filter,
  so it is handled downstream. `findUnique` realistically only throws connection
  errors or P2023 (malformed UUID, already rejected by `requireUuid`), so a
  service-level remap adds little. Left as-is to avoid a redundant double-transaction.
- **`idempotency.ts` stale-pending / failed / completed state machine** — re-traced
  all `acquireIdempotencyRecord` → `handleExistingRecord` transitions (pending+stale,
  pending+recent, completed, failed, hash-match/mismatch); all branches are correct
  and the narrow failed-record race window is explicitly handled with
  `REQUEST_IN_PROGRESS`.
- **`sanitize.ts` decode-then-strip loop** — stable; the `MAX_INPUT_LENGTH` (100 KB)
  cap and `MAX_SANITIZE_ITERATIONS` (10) bound the DoS surface.
- **`crypto.ts` `sortKeysDeep`** — circular-reference, depth (100), WeakMap/WeakSet,
  and function guards all present; prototype-pollution-safe via `Object.create(null)`.
- **`rls-extension.ts` Proxy traps** — `set`/`deleteProperty` blocked on both client
  and model delegates; raw SQL and `$`-prefixed methods blocked; non-existent models
  throw a clear error (round 26).

## Test Results

```
shared:    137 passed (4 files)
mcp-tools: 119 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       304 passed (14 files)
────────────────────────────────────
Total:     585 passed, 10 skipped
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
- ~~`domain-exception.filter.ts` unsanitized message in responses (dev + prod)~~ —
  addressed in round 27
- ~~`domain-exception.filter.ts` sanitizeContext not recursive for nested
  objects~~ — addressed in round 27
