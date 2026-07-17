# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/database`,
`packages/mcp-tools`, `apps/api`) conducted on 2026-07-17. This is review round 40;
round 1–39 are documented in earlier revisions of this file and `CHANGES.md`.

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors (1 pre-existing complexity warning in `crypto.ts:sortKeysDeep`)
- `npm run test` — all passing: shared 151, mcp-tools 126, database 25 (10 RLS isolation
  tests skipped without a live DB), api 308

## Findings & Actions (round 40)

### Fixed this round

1. **🟢 `crypto.ts` — aggregate byte budget under-counted key names (deferred item from
   round 39).** `checkStringBounds` only charged string *values* to `MAX_HASH_TOTAL_BYTES`,
   so the JSON-serialized form of object/Map *keys* escaped the guard: a wide object/Map of
   ~200-byte keys with empty values (12k keys ≈ 2.4 MB of key bytes alone) exceeded the 2 MB
   cap without tripping the DoS guard. Added `chargeKeyBytes` (key length + 2 quote bytes)
   called from `sortPlainObject` (object keys) and `sortMap` (Map keys); both now throw the
   aggregate size-limit `InvalidTypeValueError` before serialization. Added regression tests
   (wide object keys rejected; modest key set accepted; wide Map keys rejected).

2. **🟢 `truncate.ts` — nested Map/Set dropped from the persisted payload (deferred item
   from round 39).** `serializeObjectValue` converted only a *top-level* Map/Set to arrays;
   a Map/Set nested inside an array/object was silently turned into `{}`/`[]` by
   `JSON.stringify`, losing data from the audit/idempotency record (data-loss, not a leak).
   Added `normaliseForTruncation`, which recursively converts nested Map/Set (and
   arrays/plain objects) to JSON-safe arrays, with a `WeakSet` cycle guard and a pass-through
   for special objects (Date/Error/RegExp/class instances) so their `toJSON`/built-in
   serialization is preserved (a Date is not flattened into `{ }`). Added regression tests
   (nested Map-in-array preserved as `[k,v]` pairs; nested Set-in-object preserved; circular
   nested reference returns the error marker rather than being silently elided).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts` shared-pool context reset** — flagged in round 38; the design relies
  on `SET LOCAL app.current_tenant` within a transaction that holds a dedicated connection,
  and `verifyRlsEnabled` boot assertion plus fail-closed role check close the misconfig path.
  A redundant explicit `SET LOCAL ... = ''` reset remains deferred (no live exploit path).
- **`ai_action_log.tenant_id` nullable** — flagged LOW in round 39; a NULL tenant_id row is
  invisible to all tenants under RLS (no leak, just a stranded-audit edge). Changing a
  shipped migration carries risk; still deferred.
- **`spike-rls.ts` Test 3 runs against the admin/superuser client** — flagged LOW in round 39;
  spike-only (excluded from build); deferred.

## Test Results
```
shared:    153 passed (4 files)   (+2 — round 40 key-budget regression tests)
mcp-tools: 129 passed (4 files)   (+3 — round 40 nested-Map/Set regression tests)
database:   25 passed, 10 skipped (2 files)
api:       308 passed (14 files)
───────────────────────────────────
Total:     615 passed, 10 skipped
```


## Findings & Actions (round 38)

### Fixed this round

1. **🟡 `crypto.ts:241` — `hashInput` had no aggregate serialized-size cap (memory-DoS).**
   `MAX_HASH_STRING_BYTES` bounds each *individual* string and `MAX_HASH_KEYS` bounds
   container/key count, but an input like `Array(1200).fill("x".repeat(99_000))` passes
   both guards (each string < 100 KB, 1200 keys < 10k) while `JSON.stringify` produces a
   ~115 MB buffer — exhausting memory / blocking the event loop. Added `MAX_HASH_TOTAL_BYTES
   = 2_000_000` and a byte budget threaded through `sortKeysDeep`: every string accrues its
   UTF-8 byte length to the running total and the whole sort throws
   `InvalidTypeValueError` ("aggregate serialized size limit") the moment the budget is
   exceeded, before any large stringification. Added regression tests (wide array of
   near-limit strings rejected; small count accepted).

2. **🟡 `sanitize.ts:119` — `sanitizeLogOutput` left control/ANSI chars intact, and the
   query-string secret rule truncated secrets at boundary punctuation (`)` `]` `}`).**
   `sanitizeLogOutput` is the redaction primitive but did *not* apply the
   log-injection strip (`sanitizeLogMessage`), so a newline injected into a
   credential-bearing message survived into logs when the function was called directly
   (`sanitizeForLogOutput` composes them, but direct use is a documented path). It now
   strips control/ANSI characters first. Separately, the query-string secret value class
   `[^&\s"')\]}]+` stopped at `)`/`]`/`}`, so `...?token=sk_live_abc)` redacted only up to
   the boundary, leaving `]`/`)` behind and truncating the secret mid-value. The value
   class is widened to `[^&\s"']+` and trailing boundary punctuation is trimmed before
   `[REDACTED]` is appended. Added regression tests (boundary punctuation, injected
   newline stripped).

3. **🟡 `error-handler.ts:88` — `DomainError.context` Map/Set values under a sensitive-key
   name were not redacted (agent-facing secret leak).** `sanitizeObject` applies
   `isSensitiveField(k)` → `"[REDACTED]"` to plain-object keys, but the `Map` branch only
   scrubbed *values* (URL/path), so a `DomainError` carrying
   `context: { mapData: new Map([["password", "hunter2"]]) }` reflected `hunter2` to the AI
   agent. The `Map` branch now redacts the value when its key is a sensitive-field name,
   mirroring `audit-log.ts`'s `redactSensitiveFields`. Updated the regression test that
   previously *asserted* the leak (now asserts `[REDACTED]`).

4. **🟡 `prisma.service.ts:205,255` — RLS / superuser boot assertions failed *open* on a
   verification query error.** `verifyAppClientRole` / `verifyRlsEnabled` wrapped the
   actual check in `try/catch` and, on any thrown error (permission denied on `pg_catalog`,
   transient outage, schema drift), logged only a `warn` and booted. That silently starts
   the service with unverified tenant isolation — the exact gap the assertions exist to
   prevent. Both now **fail closed**: a verification query that cannot run throws
   `"… refusing to boot (tenant isolation unverified): …"` (with `cause` attached) instead
   of warn-and-continue. Also switched `verifyRlsEnabled`'s `$queryRawUnsafe` to the
   parameterized `$queryRaw` template for consistency and to remove the "unsafe" footgun
   (the table list was already a hardcoded constant, so no injection surface existed).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts` shared-pool context leakage** — flagged by sub-review: the design
  relies on `SET LOCAL app.current_tenant` within an interactive transaction that holds a
  dedicated connection, so a prior tenant cannot leak to a later query; raw-SQL / `$` /
  `_` traps still block reaching the base client, and `verifyRlsEnabled` boot assertion
  (round 37) plus fail-closed role check (this round) close the misconfig path. The
  proposed explicit `SET LOCAL ... = ''` reset would add value but is deferred as a
  defense-in-depth hardening (no live exploit; requires a code path that issues a query
  outside every tenant transaction, which the proxy prevents by construction).
- **`hashInput` `toJSON` enumerable key / `MAX_HASH_TOTAL_BYTES` over-redaction** — an
  input whose aggregate bytes exceed 2 MB is rejected; legitimate tool inputs are bounded
  by field caps (largest is `MAX_PARTY_DESCRIPTION_LENGTH = 1000`), so the budget is
  never hit in practice. `toJSON` rejection is the existing documented behavior for
  non-serializable values.
- **`truncate.ts` string-fallback / `audit-log` `reasoning` not secret-scanned** —
  flagged LOW in sub-review; the `reasoning` string is agent-supplied and capped, and the
  string-fallback in `truncateValue` only affects inputs that already produce invalid
  JSON. Deferred as non-security-impacting.
- **`health.controller.ts` `/version` fingerprinting** — flagged LOW; `/version` is
  `@Public()` and returns package name/version. Accepted trade-off (operators need a
  liveness/version probe); not changed this round.
- **Blocking `CREATE INDEX` in `migrations/20260619000000…`** — flagged LOW; the
  `pg_trgm` GIN index is `CREATE INDEX` (not `CONCURRENTLY`) so it locks the table during
  `prisma migrate deploy`. Deferred: changing shipped migrations is risky and the comment
  already documents manual `CONCURRENTLY` application.
- **`party.service.ts` `searchParties` type-table joins** — confirmed still gated by
  `tenantId` in the same `where`; no cross-tenant leak.
- **ReDoS** — all regexes across the four packages re-verified linear/bounded (no nested
  quantifiers); no new ReDoS introduced by this round's edits.

## Findings & Actions (round 39)

### Fixed this round

1. **🟡 `audit-log.ts:76-77` — successful tool `data` returned to the agent was never
   redacted (secret leak on the live path).** The audit row (`logAction` →
   `truncateValue(redactSensitiveFields(...))`) and the idempotency replay
   (`handleExistingRecord` → `redactSensitiveFields`) both redact sensitive-named fields,
   but the **live** success path returned `result` verbatim to the AI agent. A tool
   returning a value under a sensitive-named key (e.g. a credential) therefore leaked on
   the first call while being redacted everywhere durable. `executeAndLog` now applies
   `redactSensitiveFields` to `result.data` before returning, matching the two durable
   sinks. Added a regression test asserting a `{ password: "hunter2" }` live result reaches
   the agent as `[REDACTED]`.

2. **🟡 `prisma.service.ts:234-259` — `verifyRlsEnabled` had a wrong table list and ignored
   `relforcerowsecurity`.** The checked list contained `party_relationship` and `audit_log`,
   which are **not** tables in `schema.prisma` (the real ones are `party_role` and
   `ai_action_log`), so the check could pass vacuously and give false assurance of tenant
   isolation at boot. It also selected `relforcerowsecurity` but only filtered on
   `relrowsecurity`, so a table with RLS *enabled but not FORCED* (where the app role owns
   it) would still bypass RLS silently. The list now matches the eleven tables that
   `rls-setup.sql` enables RLS + FORCE on, the filter asserts **both** `relrowsecurity` and
   `relforcerowsecurity`, and any listed table missing entirely from `pg_class` (renamed /
   dropped) is now treated as a coverage gap that refuses to boot.

3. **🟡 `domain-exception.filter.ts:156,235` — HTTP error responses reflected
   user-influenced text without hardening in staging/preview.** `handleDomainError`
   genericized the 500 message only under `isProd`, so a 500 `DomainError` in
   staging/preview reflected the raw (user-embedded) message — contradicting round 37's
   "strict-unless-development" intent. Changed to `status === 500 && !isDev`. Separately,
   `handleUnexpectedError`'s dev branch applied `sanitizeForLogOutput` but not
   `stripHtmlTags`, so an HTML/script payload in an unexpected error message reached dev
   clients; now also `stripHtmlTags`. Removed the now-unused `isProd` local.

4. **🟡 `sanitize.ts:133,146-148` — bracket-wrapped query-string secrets leaked, and the
   URL-collapse rule split mid-`[REDACTED]`.** The query-string secret rule trimmed only
   *trailing* boundary punctuation, so `?token=[sk_live_abc]` kept the leading `[` and
   leaked the secret. The leading `[` is now also stripped. Separately, the
   URL-collapse value class excluded `]`, so after the query rule inserted `[REDACTED]` the
   URL rule stopped at the marker's `]`, leaving the remainder of the query string (e.g. a
   second `&token=…`) visible. The three URL-family value classes now allow `[`/`]` (while
   still stopping at `)`/`}` for prose boundaries) so the whole URL — including every
   redacted param — folds into `[HOST]/[PATH]`. Rewrote the three affected regression tests
   to assert the secret is absent (the actual security property) rather than a literal
   `[REDACTED]` token.

5. **🟡 `tenant.ts:43-47` — unvalidated tenant ID echoed into the error message without
   control-char/ANSI stripping (log injection).** `validateTenantId` interpolates a preview
   of the attacker-influenced `tenantId` into the thrown `InvalidTenantIdError` message; if
   it carried CRLF/ANSI escapes those reached operator logs verbatim. The preview is now run
   through `sanitizeLogMessage` before interpolation.

6. **🟢 `error-handler.ts:160` — `P2002` `conflictingFields` used `sanitizeLogMessage`
   instead of `sanitizeForLogOutput`.** `meta.target` is schema-derived (low risk) but every
   other externally-derived string in the file scrubs URLs/paths via `sanitizeForLogOutput`;
   aligned the one inconsistency.

### Reviewed but NOT changed (false positives / out of scope)

- **`crypto.ts` aggregate byte budget under-counts key names** — `checkStringBounds`
  charges only string *values*, not keys, so the serialized buffer can exceed
  `MAX_HASH_TOTAL_BYTES` by ~2%. Still bounded by `MAX_HASH_KEYS` (10k); not a DoS vector.
  Deferred as defense-in-depth.
- **`truncate.ts` nested Map/Set become `{}`/`[]`** — `serializeObjectValue` only converts a
  *top-level* Map/Set; a Map nested in an array/object is dropped from the persisted
  payload (data-loss, not a leak). Noted for a future normalisation pass.
- **`ai_action_log.tenant_id` nullable** — flagged LOW; a NULL tenant_id row is invisible to
  all tenants under the RLS policy (no leak, just a stranded-audit edge). Changing a
  shipped migration carries risk; deferred.
- **`spike-rls.ts` Test 3 runs against the admin/superuser client** — flagged LOW; the
  isolation assertion passing there validates query-time filtering, not RLS enforcement
  under `besterp_app`. Spike-only (excluded from build). Deferred.

## Test Results
```
shared:    151 passed (4 files)
mcp-tools: 126 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       308 passed (14 files)
───────────────────────────────────
Total:     610 passed, 10 skipped
```

## Findings & Actions (round 37)

### Fixed this round

1. **🔴 `sanitize.ts:38` — `stripHtmlTags` length guard measured UTF-16 code units, not
   bytes (DoS-guard bypass).** A ~99k multi-byte string is ~400 KB in UTF-8 yet
   `input.length` (code units) stayed under the 100k cap, so it entered the entity-decode
   strip loop and could balloon well past the intended budget. The guard now measures
   `Buffer.byteLength(input, "utf8")`. Added regression test (multi-byte oversized input).

2. **🟡 `sanitize.ts:128-145` — `sanitizeLogOutput` missed bare bearer/JWT secrets and
   false-redacted ordinary prose as file paths.** `Authorization: Bearer sk_live_…` and
   bare JWTs reached operator logs unredacted. The `at /path` path rule also collapsed
   prose like "meet me at /home/user later" into "meet me [PATH] later", destroying
   legitimate log context. Added `Bearer …` and JWT redaction, and rewrote the path rule
   to redact only absolute paths that actually look like file paths (extension or `:line`
   suffix), leaving plain prose intact. Added regression tests.

3. **🟢 `validation.ts:32` — `EMAIL_REGEX` accepted invalid local parts (consecutive/leading/
   trailing dots).** Added `(?!\.)(?!.*\.\.)…(?<!\.)` guards so `a..b@x.com` and `.a@x.com`
   are now rejected. Existing valid addresses still pass.

4. **🟡 `error-handler.ts:120` — MCP `DomainError.message` returned verbatim to the AI agent
   without `sanitizeForLogOutput`.** `handleDomainError` is the one agent-facing surface that
   did not scrub URLs/paths from the message (generic errors return a fixed string; idempotency
   / audit / HTTP paths all sanitize). Now applies `sanitizeForLogOutput` consistently.

5. **🟡 `tool-registry.ts:200` — unbounded `context.issues` array returned to the agent (DoS /
   memory amplification).** Zod emits one issue per invalid element, so a crafted large array
   produced an arbitrarily large issues array in the tool result. Now capped at
   `MAX_VALIDATION_ISSUES = 50` (the message string was already capped at 2000 chars).

6. **🟡 `domain-exception.filter.ts:153,171` — reflected `DomainError.message` not HTML-stripped;
   error-response hardening gated on exact `NODE_ENV === "production"`.** The message embedded
   user input but only control-char sanitized, so `<script>` reflected intact into the JSON
   response. `handleDomainError` now also runs `stripHtmlTags`. `handleHttpException` only
   stripped internal details under `production`, so staging/preview envs leaked raw validation
   bodies; inverted to strict-unless-`development` so hardening is the default.

7. **🔴 `prisma.service.ts:177` — superuser detection keyed on role name, not privilege; no boot
   RLS assertion.** `verifyAppClientRole` only flagged roles literally named `besterp`/`postgres`,
   missing any role granted `SUPERUSER`/catalog-update. Now queries `pg_roles` for `rolsuper`/
   `rolcatupdate`. Added `verifyRlsEnabled()` called at boot: it refuses to start if RLS is not
   enabled on the core tenant tables (RLS lives in the standalone `rls-setup.sql`, which
   `prisma migrate deploy` does not run — a forgotten apply meant silent cross-tenant exposure).

8. **🟢 `migrations/20260619000000…/migration.sql:9` — non-idempotent `CREATE INDEX`.** Added
   `IF NOT EXISTS` so a re-run during manual production recovery no longer aborts.

### Reviewed but NOT changed (false positives / out of scope)

- **RLS-cache method/delegate caches** — closure captures the single `tenantId` bound at
  `createTenantClient` time; clients are cached per `tenantId`, never reused across tenants.
- **`crypto.ts` `hashInput`** — depth/key/string-byte guards confirmed correctly ordered; no
  bypass. `NaN`/`Infinity`→`null`, circular `cause` handled.
- **`party.service.ts` duplicate-contact / role checks** — RLS-scoped; explicit `tenantId`
  filters consistent with the app-role path.
- **CORS** — exact-origin match with `credentials` only when origin configured; no `*` reflection.

## Findings & Actions (round 35)

### Fixed this round

1. **🔴 `idempotency.ts:259` / `truncate.ts` — `_truncated` marker collided with real
   user data (correctness/abuse path).** The replay path detected truncation via a bare
   `"_truncated" in data` check. A tool whose result genuinely contains a top-level
   `_truncated` field would be falsely reported to the agent as "was truncated for
   storage", and a `_truncated:true` field could be misread on replay. `truncateValue`
   now emits a high-entropy private discriminator (`__besterp_trunc`) alongside the
   `_truncated` flag, and `handleExistingRecord` detects truncation via the exported
   `isTruncationMarker` helper. Added regression tests.

2. **🔴 `sanitize.ts:121` — secrets in HTTP URL query strings were not redacted.** The
   generic `https?://…` rule reduced a URL to `[HOST]/[PATH]` but preserved the full
   query string, so `https://api.example.com/v1/charge?api_key=sk_live_abc123&token=xyz`
   leaked both secrets to operator logs. A new regex redacts common secret-bearing query
   parameters (`key`, `token`, `secret`, `password`, `access_token`, `auth`, `api_key`,
   `apikey`, `client_secret`) to `[REDACTED]`. Added regression test.

3. **🟡 `validation.ts:61` — ISO date regex accepted invalid timezone offsets
   (`+14:30`, `+14:59`, `-12:30`, `-13:00`).** The offset minute group `[0-5]\d` was
   unconstrained for extreme hours. The regex now restricts `+14` to `:00` only and
   `-12` to `:00` only, keeping the valid -12:00..+14:00 window. Added regression test.

4. **🟡 `errors.ts:60-68` — `DomainError.toJSON` serialized non-Error `cause` via
   `String(cause)`.** A non-`Error` cause (e.g. an attached object) would have its data
   stringified into audit logs / idempotency records; a custom class `toString()` can
   embed sensitive field data. Non-Error causes now serialize to the safe placeholder
   `[Non-error cause]`. Updated the regression test.

5. **🟡 `idempotency.ts:153-155` — idempotency key leaked its first 32 plaintext chars to
   agent-facing error messages.** `redactKey` embedded `key.slice(0, 32)` verbatim; if a
   key ever carried a secret (defense-in-depth), up to 32 chars reached the AI agent.
   Keys are now hashed with SHA-256 and only a 12-char opaque prefix (`id-…`) is shown.
   Updated the regression test that asserted the raw key appeared in stderr.

6. **🟢 `sensitive-fields.test.ts:170-175` — pre-existing broken test.** The `redactSensitiveFields`
   describe block used a top-level `await import(...)` outside an async function, so the
   entire test file failed to transform (0 tests ran). Replaced the dynamic import with a
   static top-level import. The file now executes (part of the 121→122 mcp-tools tests).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts:199-215` method-cache `tenantId` capture (flagged HIGH by sub-review).**
  Verified the closure captures the single `tenantId` bound at `createTenantClient` time, and
  `PrismaService.tenantScoped` caches clients keyed by `tenantId` (`prisma.service.ts:247`),
  so a proxy is never reused across tenants. The finding does not manifest in real usage.
- **Cross-tool / cross-user idempotency key collision.** The DB unique constraint is
  `(idempotencyKey, tenantId)`; keys are caller-supplied opaque tokens (UUID/ULID/hash) and
  are treated as secret per-operation. Re-namespacing by tool/user would be a breaking change
  to the existing contract and is deferred.
- **`create-roles.sql:19` committed dev password.** Documented dev-only with `NOINHERIT`;
  left as-is to avoid diverging from the provisioning script's contract. Tracked as a follow-up.

## Findings & Actions (round 34)

### Fixed this round

1. **🔴 `crypto.ts:104-111` — `Error.cause` hashed shallow + circular `cause` not
   detected.** `serializeSpecialObject` flattened `cause` to one level (`{name, message}`),
   so two inputs differing only in `cause` depth hashed **identically** (defeating
   idempotency mismatch detection), and a circular `cause` chain did **not** throw like
   every other circular type. `cause` is now recursively serialized via
   `sortKeysDeep(value.cause, ancestors, depth + 1)`, inheriting the circular + depth
   guards. Added regression tests.

2. **🔴 `idempotency.ts:406` — success/failure `result` persisted & replayed without
   sensitive-field redaction (secret-leak path).** The audit log redacts
   `toolOutput` via `redactSensitiveFields`, but the idempotency `result` column applied
   only `truncateValue`. A tool returning a value under a sensitive-named key would
   persist it unredacted and replay it to the agent verbatim. Now `redactSensitiveFields`
   runs before `truncateValue` on persist and is re-applied on replay. `redactSensitiveFields`
   was exported from `audit-log.ts` and reused so both durable sinks share one implementation.

3. **🟡 `truncate.ts:188` — `JSON.parse` could throw, violating the "never throws"
   contract.** A value `JSON.stringify` emits but cannot re-parse (e.g. custom `toJSON`
   emitting a lone surrogate) would crash a fire-and-forget audit/idempotency write. Added a
   local `safeParse` that falls back to the string form. Added a regression test.

4. **🟡 `error-handler.ts:140` — Prisma `meta.target` echoed to the agent unsanitized.**
   The `P2002` handler interpolated `meta.target` (user-influenced under compound
   constraints) verbatim into the `DUPLICATE_ENTITY` message / `context.conflictingFields`,
   inconsistent with every other externally-derived string in the file. Now run through
   `sanitizeLogMessage`.

5. **🟡 `party.service.ts:611,808` — party existence checks relied solely on RLS
   (incomplete round-32 hardening).** Round 32 added `tenantId` to `getParty`'s `where`, but
   two sibling existence checks (`addPartyRoleTransaction`, `createContactMechanismTransaction`)
   still queried `party.findUnique({ where: { partyId } })` with no `tenantId`. Added
   `tenantId` to both, mirroring `getParty`.

6. **🟡 `cleanup-expired-idempotency.ts` — advisory lock ineffective across Prisma's
   connection pool.** `pg_try_advisory_lock` is session-scoped; under Prisma's pool the lock
   and the batch operations could land on different backend connections, voiding
   serialization. The whole cleanup now runs inside a single interactive `$transaction`.

7. **🟡 `.github/workflows/ci.yml` — round-33 `ALLOW_SEED` guard broke the CI seed step.**
   Added `ALLOW_SEED: "1"` to the CI "Seed database" step (ephemeral CI Postgres, safe).

8. **🟢 `rls-setup.sql` — `set_tenant_context` lacked `search_path` pin + superuser
   assertion.** Added `SET search_path = pg_catalog, public` to the function and a `DO $$`
   assertion that raises if `besterp_app` is a superuser.

9. **🟢 `health.controller.ts` — unauthenticated `/health` leaked environment/memory/uptime.**
   The anonymous `/health` success path now returns only `{ status, timestamp, database }`.

### Verified clean (no action needed)
- **`sanitize.ts` decode loop** — 100 KB input cap + 10-iteration bound; all tag/entity
  regexes are linear character classes (no ReDoS).
- **`validateTenantId` / regexes** — `UUID_REGEX`, `EMAIL_REGEX`, `TENANT_ID_PATTERN`,
  `ISO_DATE_REGEX` all anchored/bounded, no ReDoS.
- **`sortKeysDeep`** — depth (100) + key-count (10k) guards; WeakMap/WeakSet rejected;
  ancestor-set cleanup on every exit path (round 31).
- **`idempotency.ts` state machine** — acquire/failed/stale-pending transitions under
  Serializable isolation with P2034 retry; narrow failed-record race handled as
  `REQUEST_IN_PROGRESS`.
- **`rls-extension.ts` Proxy traps** — raw SQL / `$` / `_` props blocked; array `$transaction`
  rejected; non-existent models throw.
- **`party.controller.ts` / `auth` guards** — `tenantId` taken solely from JWT context and
  spread after the body; global guards honor `@Public()`; `TenantGuard` defensively
  re-validates `tenantId`/`userId`.
- **`discovery-tools.ts`** — `typeName` is a `z.enum` allowlist; type tables are global by
  design (admin client).
- **`audit-log.ts`** — backpressure manager, `redactSensitiveFields` depth + circular guards.

## Test Results
```
shared:    138 passed (4 files)
mcp-tools: 121 passed (4 files)
database:   25 passed, 10 skipped (2 files)
api:       306 passed (14 files)
───────────────────────────────────
Total:     590 passed, 10 skipped
```

## Findings & Actions (round 33)

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 138, mcp-tools 119, database 25 (10 RLS isolation
  tests skipped without a live DB), api 305

## Findings & Actions (round 33)

### Fixed this round

1. **🟡 `seed.ts:31` — seed guard bypassable by any non-`production`/`staging` `NODE_ENV`.**
   The guard refused `production`/`staging` only. An operator pointing `DATABASE_ADMIN_URL`
   at a production database while leaving `NODE_ENV` unset (or `development`, a common
   container-env reuse mistake) would silently insert the hard-coded `tenant-acme` /
   `tenant-globex` test tenants into prod. Seeding now additionally requires an explicit
   opt-in: `ALLOW_SEED=1`. There is no safe default that permits the destructive insert
   without a deliberate signal. The `NODE_ENV` refusal is retained as a backstop.

2. **🟢 `health.controller.ts:73` — unsanitized `debug` log (log-injection
   inconsistency).** The readiness race handler interpolated the raw DB error `message`
   directly into a `logger.debug` call, inconsistent with every other error log in the
   codebase which wraps infra-derived messages in `sanitizeForLogOutput(...)` /
   `sanitizeLogMessage(...)`. Wrapped the message so a crafted/compromised driver error
   cannot inject ANSI escapes or CRLF into logs. `sanitizeForLogOutput` was already imported.

3. **🟢 `cleanup-expired-idempotency.ts` — destructive prod script lacks an opt-in.**
   The cron script runs as superuser (bypasses RLS) and deletes rows. A misconfigured
   `DATABASE_ADMIN_URL` pointing at prod could wipe expired idempotency records
   unattended. Normalized `NODE_ENV` and refuse to run in `production` unless
   `ALLOW_CLEANUP_PRODUCTION=1` is set explicitly.

4. **🟢 `pluralize.ts:33` — single-letter input force-uppercased (cosmetic casing bug).**
   `preserveCasing` checked the all-caps branch (`input === input.toUpperCase()`) first, so
   a single uppercase letter like `"Y"` returned an all-caps plural (`"IES"`) instead of
   preserving the single leading capital. Excluded length-1 inputs from the all-caps branch
   so they fall through to the leading-capital rule. (Cosmetic — affects MCP error messages
   / suggested tool names only.) Added a regression test.

5. **🟢 `spike-rls.ts:11` — hardcoded-looking DB credential in a committed spike.**
   The dev spike embedded a real-looking connection string
   (`besterp_app:besterp_app_dev@localhost:5434`). It is excluded from the published build
   (`tsconfig` `include: ["src"]`) and only runs via `npm run spike:rls`, but it trips
   secret scanners. Replaced with a `<user>:<pass>@<host>:<port>` placeholder.

### Verified clean (no action needed)
- **`discovery-tools.ts`** — `get_type_table_values` restricts `typeName` to a `z.enum`
  compile-time allowlist and validates the resolved delegate at runtime; type tables are
  intentionally global (admin client, RLS bypass) shared vocabulary. No injection surface.
- **`party.dto.ts` / `party.controller.ts`** — `tenantId` is taken solely from the
  JWT-derived `req.tenantContext` and spread after the body (so client-supplied `tenantId`
  is discarded); the handler/service never trusts a request body tenant. `forbidNonWhitelisted`
  is on. No tenant-isolation leak.
- **`auth.module.ts` / `jwt-auth.guard.ts` / `tenant.guard.ts`** — global guards registered
  in the correct order; both honor `@Public()` via Reflector; `TenantGuard` defensively
  re-validates/trims `tenantId`/`userId`. No authz gaps.
- **`mcp.module.ts`** — `buildContext` validates `tenantId` format, type- and length-checks
  `userId` and all optional fields. Consistent with the hardened boundary pattern.
- **`queue.module.ts`** — Redis password required in non-dev, port validated 1–65535, retry
  capped. No issues.
- **`seed.ts` / `cleanup-expired-idempotency.ts`** — SQL uses Prisma parameterized operations
  and tagged-template `pg_try_advisory_lock`; batching + composite-key delete are precise.
- **`shared/index.ts`, `mcp-tools/index.ts`, `database/index.ts`** — barrel exports only.

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
