# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/mcp-tools`,
`packages/database`, `apps/api`) conducted on 2026-07-16. This is review round 32;
rounds 1–31 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 137, mcp-tools 119, database 25 (10 RLS isolation
  tests skipped without a live DB), api 305

## Findings & Actions (round 32)

### Fixed this round

1. **🟡 `party.service.ts:427` — `getParty` relied solely on RLS for tenant isolation
   (no app-level `tenantId` filter).** Every other party query adds `tenantId` to the
   `where` clause (`searchParties`, `addPartyRole`, `addContactMechanism`) as defense-in-depth,
   but `getParty` queried only by `partyId`, depending entirely on `set_tenant_context` having
   been applied correctly. A future regression in the proxy/transaction context-setting path
   would have turned this into a silent cross-tenant read. Added `tenantId: trimmedTenantId`
   to the `where` clause so a regression in the RLS path cannot leak data across tenants.
   Added a regression test asserting the `where` clause contains both `partyId` and `tenantId`.

2. **🟡 `prisma.service.ts:181` — `verifyAppClientRole` allowed a superuser app client
   outside production, and its warning was misleading.** The check threw only in production;
   in dev/staging a `DATABASE_URL` pointing at `postgres`/`besterp` (superuser) silently
   bypassed RLS for every tenant-scoped query. Worse, the warning claimed audit/idempotency
   rows would be "silently rejected" when in fact a superuser *bypasses* RLS so cross-tenant
   writes succeed. The check now throws unconditionally on a superuser app role, and the
   message is corrected to state RLS is bypassed / tenant isolation disabled.

3. **🟡 `tool-registry.ts:182` — `INVALID_INPUT` returned an unbounded Zod issue string to
   the agent.** The joined `path: message` list is derived from user input and could grow
   arbitrarily large (many issues, or long per-issue messages), bloating the agent-facing
   response. Capped the joined string at 2000 chars (the full issue list remains in
   `context.issues` for programmatic callers), mirroring the existing 500-char log-line bound.

4. **🟡 `idempotency.ts:410` — soft-failure `error.code` was stored verbatim (unbounded).**
   `error.message` was already `capString`-capped, but `error.code` (a free-form string from
   the defensive `getErrorCode`, not an allowlist) was persisted as-is, so a tool returning a
   multi-KB `code` would bloat `idempotency_record.error.code`. Now routed through `capString`
   + `sanitizeForLogOutput` with the same 4096-byte bound. Added a regression test asserting a
   20 KB `code` is capped on persistence.

5. **🟢 `truncate.ts:188` — object payload could exceed the 64 KB bound after normalisation.**
   `truncateValue` measured the input's `JSON.stringify` before the `JSON.parse` round-trip that
   normalises class instances / Maps / Sets / BigInt / Dates to their JSONB form. For
   pathological inputs the normalised form can be larger than the measured one, so the stored
   payload escaped the size cap silently. Added a post-parse re-validation: the normalised form
   is re-encoded and, if still over the limit, replaced with the truncation marker. Added a
   regression test asserting the returned structure's re-encoded size is always within
   `MAX_STORED_PAYLOAD_SIZE`.

### Verified clean (no action needed)
- **`sanitize.ts` decode-then-strip loop** — length cap (100 KB) and 10-iteration bound hold;
  control-char and ANSI stripping confirmed.
- **`crypto.ts` `sortKeysDeep`** — `try/finally` ancestor-set cleanup on every exit path
  (fixed round 31); depth (100) and key-count (10k) bounds intact; WeakMap/WeakSet rejected.
- **`rls-extension.ts` Proxy traps** — raw SQL / `$`-prefixed methods blocked; array-form
  `$transaction` rejected; `set`/`deleteProperty` blocked.
- **`idempotency.ts` state machine** — acquire/failed/stale-pending transitions under Serializable
  isolation with P2034 retry; narrow failed-record race handled as `REQUEST_IN_PROGRESS`.
- **`jwt.strategy.ts` / `tenant.guard.ts`** — required/optional field trim+length validation;
  `tenantId` format validated at the auth boundary; JWT wins over body via spread order.
- **`domain-exception.filter.ts`** — recursive context sanitisation, ANSI/control stripping,
  production 500s generic; validation detail dropped in prod.
- **`validation.ts` regexes** — `UUID_REGEX`, `EMAIL_REGEX`, `COUNTRY_CODE_REGEX`, `TENANT_ID_PATTERN`
  all anchored/bounded, no ReDoS; `isValidISODate` enforces month/day/year/leap correctly.
- **`party.service.ts` duplicate contact-mechanism check** — `checkEmailDuplicate` /
  `checkTelecomDuplicate` correctly scoped to `(partyId, tenantId)` via the `partyContacts`
  relation (fixed round 31); email redaction preview correctly clamped before `@`.

## Findings & Actions (round 31)

### Fixed this round

1. **🟡 `party.service.ts` — duplicate email/phone check not scoped to the party (false
   negative → duplicate allowed).** `checkEmailDuplicate` / `checkTelecomDuplicate`
   issued a tenant-wide `findFirst` and then de-duplicated in memory with
   `contactMechanism.partyContacts.some((pc) => pc.partyId === partyId)`. Because
   `findFirst` returns an *indeterminate* match across all parties in the tenant, the
   in-memory `some()` check ran against the wrong party's row: if party B's email was
   the one returned, the check looked for party A and returned `false`, so a genuine
   duplicate for party A slipped through. Fixed by pushing the `partyContacts.some({
   partyId })` filter into the Prisma `where` clause so the query itself is scoped to
   the requesting party; the `if (existing)` result no longer needs an in-memory
   re-check. Same correction applied to `checkTelecomDuplicate`. Added a regression
   test asserting the query `where.contactMechanism.partyContacts.some.partyId` equals
   the requesting party and that a same-email-on-another-party does not false-positive.

2. **🟡 `truncate.ts` — `Date` size check double-encoded by `JSON.stringify` round-trip
   (inaccurate truncation threshold).** `normalisePrimitive` for `Date` ran the ISO
   string through `JSON.stringify` before `TextEncoder.encode`, which wraps the string
   in quotes (`"2024-..."`) and inflates the byte count by 2. The oversize marker was
   therefore computed against a length 2 bytes larger than what is actually stored,
   so values just under the threshold could be misclassified and the preview boundary
   drifted. Fixed by encoding the ISO string directly (strings are JSON-safe; no
   quoting needed), matching the existing `string` fast path. Behaviour unchanged for
   non-oversize values; only the boundary/truncation decision is now accurate.

3. **🟢 `crypto.ts` `sortKeysDeep` — `ancestors.delete` skipped on early return
   (ancestor-set leak across sibling branches).** `sortArray`, `sortMap`, `sortSet`,
   and `sortObject` added the current value to the `ancestors` `Set` but only deleted
   it on the final `return` line. Any branch that returned early (e.g. `sortMap`/
   `sortSet` returning the pre-computed array, or `sortObject` returning directly from
   inside the `try`) left the value in the set, so a later sibling value that
   legitimately shared that reference would be misreported as a circular reference.
   Wrapped each in `try { ... } finally { ancestors.delete(value); }` so cleanup runs
   on every exit path.

4. **🟢 `prisma.service.ts` — typo `BYPASSSED` in RLS-bypass warning (and the matching
   `catch` guard).** The superuser-RLS-bypass error message and the `catch` block that
   re-throws it on that exact substring both spelled `BYPASSED` as `BYPASSSED`. The
   mismatch meant the intended re-throw path was dead code (the `catch` never matched),
   so a genuine bypass condition fell through to the generic `warn` instead of being
   surfaced as an error. Fixed the spelling in both the message constant and the
   `.includes()` guard.

5. **🟢 `health.module.ts` — `HealthService` exported but never consumed externally.**
   `HealthModule` re-exported `HealthService`, but no other module imports it (the
   controller injects it locally within the module). Removed the unused `exports` to
   keep the module boundary honest.

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
  and function guards all present; prototype-pollution-safe via `Object.create(null)`;
  ancestor-set cleanup now runs on every exit path (see fix #3).
- **`rls-extension.ts` Proxy traps** — `set`/`deleteProperty` blocked on both client
  and model delegates; raw SQL and `$`-prefixed methods blocked; non-existent models
  throw a clear error (round 26).

## Test Results
```
shared:    137 passed (4 files)
mcp-tools: 121 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       306 passed (14 files)
────────────────────────────────────
Total:     589 passed, 10 skipped
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
- ~~`party.service.ts` duplicate email/phone check not scoped to party~~ — addressed
  in round 31
- ~~`truncate.ts` Date size check double-encode~~ — addressed in round 31
- ~~`crypto.ts` `sortKeysDeep` ancestor-set leak on early return~~ — addressed in
  round 31
- ~~`prisma.service.ts` `BYPASSSED` typo breaks RLS-bypass re-throw~~ — addressed in
  round 31
- ~~`health.module.ts` unused `exports`~~ — addressed in round 31
- ~~`party.service.ts` `getParty` RLS-only tenant isolation (no app-level
  filter)~~ — addressed in round 32
- ~~`prisma.service.ts` superuser app client allowed outside production + misleading
  warning~~ — addressed in round 32
- ~~`tool-registry.ts` unbounded Zod issue string returned to agent~~ — addressed in
  round 32
- ~~`idempotency.ts` soft-failure `error.code` stored verbatim~~ — addressed in
  round 32
- ~~`truncate.ts` object payload exceeds 64 KB bound after normalisation~~ — addressed
  in round 32
