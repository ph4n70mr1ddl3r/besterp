# Code Review Report

## Scope
Fresh full review of the BestERP monorepo (`packages/shared`, `packages/database`,
`mcp-tools`, `apps/api`) conducted on 2026-07-19. This is review 61;
round 1–56 are documented in earlier revisions of this file and `CHANGES.md`.

## Findings & Actions (round 66)

### Fixed this round

1. **🟡 `mcp.module.ts:buildContext` — `reasoning` skipped `sanitizeForLogOutput` at the auth
   boundary (asymmetric with its three sibling durable fields).** Round 65 added boundary
   sanitization to `userId`/`agentId`/`conversationId` via `sanitizeForLogOutput(stripHtmlTags(...))`
   but left `reasoning` with only `stripHtmlTags(...)`. A connection string / `?api_key=…` embedded in
   `reasoning` was therefore scrubbed only by the downstream `auditLogMiddleware.createBaseEntry`
   pass, so the documented "all four durable fields get the same treatment" contract did not hold for
   `reasoning`. The downstream pass still covered the durable `ai_action_log.reasoning` sink, so this
   was an asymmetry / defense-in-depth gap rather than a live leak — but relying on a single downstream
   pass for one of the four persisted fields is fragile. `buildContext` now runs `reasoning` through
   `sanitizeForLogOutput(stripHtmlTags(...))` at the boundary, matching the sibling fields exactly; the
   downstream `createBaseEntry` pass remains as defense-in-depth (idempotent). Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- **Lint complexity warnings (4 functions exceed `max-complexity: 15`):** `audit-log.redactSensitiveFields`
  (23), `error-handler.sanitizeContextValue` (23), `sanitize.redactSensitiveFieldValues` (21), and the
  `idempotency` acquire arrow (17). These are security-critical redactors/middlewares whose complexity
  is irreducible without fragmenting the single-source-of-truth traversal logic (which would risk
  surface divergence — the exact class of bug rounds 49/56/65 fixed). The warnings are pre-existing and
  intentional; left as-is. No change.
- **Tenant isolation (RLS boot assertions, superuser/role boot refusal, app-level `tenantId` filters),
  secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, ReDoS
  guards, and `hashInput` DoS budgets** remain intact and were re-verified. No new exploit paths found
   this round beyond the single `reasoning` boundary gap above.

## Test Results (round 66)
```
shared:    195 passed (4 files)   (unchanged)
mcp-tools: 143 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files)  (unchanged)
api:       332 passed (15 files)  (+1 — round 66 reasoning boundary sanitization regression)
───────────────────────────────────
Total:     696 passed, 10 skipped
```

## Findings & Actions (round 65)

### Fixed this round

1. **🟡 `sanitize.ts` (quoted-value rule) — round 64 reopened an asymmetric secret leak for
   `session`/`code` by removing them from the quoted-value rule.** Round 64 removed `code|session`
   from the quoted-value boundary rule to stop benign free-text `status code=200 ok` from being
   mangled. But the *quoted* JSON form (`{"session":"abc123xyz"}`, `{"code":"XYZ789"}`) was also
   dropped, so short opaque tokens below the 20-char high-entropy threshold leaked verbatim into
   agent-facing error/output and the durable cross-tenant `ai_action_log`/`idempotency_record`
   rows. `session`/`code` remain sensitive field names (`SENSITIVE_FIELD_NAMES`), and the key-name
   redactor + the query-string rule both still redact them — only the value-shape quoted rule had
   been weakened, so it was the asymmetric gap rounds 44/48/49/56 exist to prevent. Re-added
   `code|session` to the **quoted-value** rule only (line 218), leaving the bare-form free-text
   rule (the round-64 prose fix) untouched. Regression test added (quoted `session`/`code` redacted
   at short lengths).

2. **🟡 `mcp.module.ts:buildContext` — MCP identity/context fields persisted to the cross-tenant
   durable `ai_action_log` sink without HTML/secret sanitization.** `userId`/`agentId`/
   `conversationId`/`reasoning` flow into `ai_action_log` via `auditLogMiddleware(this.prisma.admin)`.
   Only `reasoning` was sanitized downstream (round 49); the three identity fields were stored
   verbatim, so an attacker-influenced `<script>`/`<img onerror>` payload or a `?api_key=…` reached
   the durable row unstripped/unredacted. `buildContext` now runs `userId`/`agentId`/
   `conversationId` through `sanitizeForLogOutput(stripHtmlTags(...))` and `reasoning` through
   `stripHtmlTags(...)` at the boundary, mirroring the downstream `reasoning` treatment. Regression
   test added.

3. **🟡 `errors.ts:DomainError.toJSON` — `message` serialized without sanitization.** `toJSON`
   redacts `context` via `redactSensitiveFieldValues` but returned `message` raw. `message` routinely
   echoes user-supplied input (connection strings, `?api_key=…`), so any caller serializing the
   error via `JSON.stringify(error)` (the canonical durable-sink serializer) could leak the secret
   verbatim — inconsistent with the REST `DomainExceptionFilter`/`error-handler`, which sanitize
   `error.message`. `toJSON` now sanitizes `message` via `sanitizeForLogOutput` (defense-in-depth;
   `code` is a short allowlisted constant, left as-is). Regression test added.

4. **🟢 `rls-extension.ts:createModelDelegateProxy` — `$transaction` on a model delegate silently
   bypassed tenant context.** The model-delegate proxy returned the underlying delegate's
   `$transaction` (not in `DATA_METHODS`), which runs without `set_tenant_context` and thus bypasses
   RLS — a latent footgun if a contributor wrote `proxy.party.$transaction(...)`. The proxy now
   rejects `$transaction` on a model delegate, directing callers to the client-level `$transaction`.
   Regression test added.

### Reviewed but NOT changed (false positives / deferred)

- **`mcp.module.ts` `buildContext` never driven by a JWT-validating transport (`tenantId`
  trust-the-caller):** the only MCP transport is the tool registry populated in `onModuleInit`; no
  transport extracts/validates a JWT and binds `tenantId` to the authenticated principal before
  `buildContext`. The `tenantId` validation exists, but it is trust-the-caller unless a future
  transport passes the *verified-JWT* tenantId. Deferred — there is no transport to wire today;
  flagged so the future transport must inject the JWT-validated tenantId, not accept a caller-supplied
  one. No code change this round.
- **`party.service.ts` `taxId` returned verbatim on REST+MCP success DTOs:** re-verified — intra-tenant
  PII returned to authenticated members, no cross-tenant leak; consistent with the long-standing
  deferred product decision. The report's round-55/56 text inconsistency (one entry wrongly claims
  `taxId` is already redacted on the success path) is corrected by this note.
- **`sanitize.ts` lowercase `[a-f0-9]` letter+digit mix (e.g. `a1b2c3d4…`) not redacted by the generic
  high-entropy rule (line 315 spares pure `[a-f0-9]` runs):** intentional trade-off (round 57) to
  preserve dashless-UUID/hash log context; a pure-lowercase-hex+digit token is treated as a benign
  identifier. Accepted; the key-name and prefix rules still catch named/known-shape secrets. No change.
- **`rls-extension.ts` shared-pool context reset / `crypto.ts` aggregate budget rounding /
  non-concurrent `CREATE INDEX` / `ai_action_log.tenant_id` nullable / `create-roles.sql` dev
  password:** all re-verified as latent/deferred with no new 🔴/🟡 exploit path this round.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level `tenantId` filters),
  secret redaction across REST/MCP/durable surfaces, idempotency-key charset consistency, and ReDoS**
  remain intact and were re-verified. No new exploit paths beyond the four fixes above.

## Test Results
```
shared:    195 passed (4 files)   (+2 — round 65 quoted session/code + toJSON message regressions)
mcp-tools: 143 passed (4 files)   (unchanged)
database:   26 passed, 10 skipped (2 files)  (+1 — round 65 model-delegate $transaction guard)
api:       331 passed (15 files)  (+1 — round 65 MCP identity-field sanitization regression)
───────────────────────────────────
Total:     695 passed, 10 skipped
```

## Findings & Actions (round 63)

### Fixed this round

1. **🔴 `prisma.service.ts` ~line 284 `verifyRlsEnabled` — false boot failure on
   global reference tables.** The `missing` computation filtered `rows` (every table in
   `public`) for `!relrowsecurity || !relforcerowsecurity`. Global reference tables
   (`party_type`, `role_type`, `contact_mechanism_type`, …) are intentionally **not**
   RLS-enforced — they are shared vocabulary read via the admin (RLS-bypassing) client and
   `rls-setup.sql` does not apply RLS to them. The old check therefore flagged every one of
   those global tables as "missing", producing a `Row-Level Security is NOT enabled`
   message and a **hard boot refusal on every real deployment**. The bug was latent because
   the existing test suite only mocked `$queryRaw` failure paths and never exercised the
   success path with global tables present. Fixed by restricting `missing` to the
   enumerated tenant tables (`tenantTables.includes(r.relname)`), so global tables are
   correctly ignored while genuine gaps on tenant tables still fail closed. Added two
   regression tests: one proving boot succeeds when globals lack RLS but all tenant tables
   have force RLS, and one proving it still refuses when a tenant table is missing force RLS.

### Reviewed but NOT changed (false positives / out of scope)

- **`party.service.ts` (1076 lines) — full re-read:** re-verified correct. All entry
  paths validate `tenantId`/`partyId`/subtypes, sanitize HTML, and scope queries by
  `tenantId` at the app layer (defense-in-depth over RLS). `fromDate`/`thruDate` nullability
  matches the Prisma schema (non-null `fromDate` → no `toISOString()` crash). Email/phone
  duplicate checks are correctly party-scoped.
- **`party.dto.ts` / `party-tools.ts` — full re-read:** class-validator DTOs and Zod
  schemas are in sync (same regexes, same min/max lengths, same HTML-strip transforms,
  same subtype exclusivity). Cross-surface consistency confirmed.
- **`main.ts` — full re-read:** body-parser error middleware, catch-all 500 handler,
  CORS-header mirror, `@Public()` scope verification, env validation, and graceful-shutdown
  handlers all correct and secret-scrubbed.
- **`audit-log.ts` — full re-read:** depth-cap redaction, `seen` cycle guard, Map/Set
  conversion, agent-facing `nextActions` scrub, and backpressure drop-on-timeout all
  correct.
- **`rls-extension.ts` — full re-read:** `LruCache` eviction, blocked raw-SQL/`$` methods,
  batch-`$transaction` rejection, and `set_tenant_context` injection all correct.
- **`crypto.ts` (`hashInput`/`sortKeysDeep`) — full re-read:** circular-ref, depth, and
  aggregate/per-string byte budgets all correctly enforced; Weak collection rejection and
  prototype-pollution-safe `Object.create(null)` confirmed.
- **`seed.ts` — full re-read:** `NODE_ENV` normalization + `production`/`staging` refusal +
  `ALLOW_SEED=1` opt-in correctly prevents seeding test tenants into real databases.
- **`cleanup-expired-idempotency.ts` — full re-read:** advisory-lock serialization,
  pending-record exclusion, composite-key batched delete, and production opt-in guard all
  correct.

## Test Results
```
shared:    140 passed (4 files)   (unchanged)
mcp-tools: 138 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)  (unchanged)
api:       376 passed (15 files)  (+2 new regression tests)
────────────────────────────────────
Total:     679 passed, 10 skipped
```

## Findings & Actions (round 61)

### Fixed this round

1. **🟢 `tenant.guard.ts:85` — dead `agentId === ""` check.** `agentId` is already
   computed as `user.agentId.trim() || undefined` on lines 77-80, so it can never be
   an empty string at this point. The `=== ""` comparison is unreachable dead code.
   Removed the redundant check.

2. **🟢 `domain-exception.filter.ts:160` — excessive whitespace in `else if`.**
   `} else       if (Array.isArray(res.message)) {` had irregular spacing between
   `else` and `if`, obscuring the control flow. Normalized to standard `} else if (...)`
   formatting.

3. **🟢 `.env.example` — missing documented env vars.** Added `JWT_ISSUER`, `JWT_AUDIENCE`,
   `REDIS_TLS`, `BUILD_NUMBER`, `BUILD_DATE`, `HARD_EXIT_TIMEOUT_MS`,
   `PRISMA_MAX_METHOD_CACHE_SIZE`, and `PRISMA_MAX_DELEGATE_CACHE_SIZE` which were
   referenced in source but not documented in the example env file.

### Reviewed but NOT changed (false positives / out of scope)

- **`party.service.ts` 1076 lines — exceeds 120-line function warning:** re-verified as
  a large but coherent service; refactoring into smaller units is a future effort, not
  a security/correctness issue this round.
- **`rls-extension.ts` model-level `$transaction` bypass:** re-verified — callers invoke
  `$transaction` on the client proxy (line 237), not on model delegates. The model
  delegate's `$transaction` is inherited from the original Prisma client and would not
  carry tenant context, but no code path in the codebase calls it on a model delegate.
  Noted as a latent risk if someone writes `proxy.party.$transaction(...)` directly.
- **`prisma.service.ts` WeakRef/FinalizationRegistry race condition:** re-verified as
  theoretical — JS is single-threaded and the GC callback fires between tick boundaries,
  making practical races unlikely. The guard on line 45 (`ref.deref()`) already prevents
  double-eviction.
- **`jwt.strategy.ts` module-level secret cache / `tenant.guard.ts` redundant userId validation:**
  re-verified as defensive redundancy, not a bug. No change this round.

## Test Results
```
shared:    140 passed (4 files)   (unchanged)
mcp-tools: 138 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)  (unchanged)
api:       328 passed (15 files)  (unchanged)
────────────────────────────────────
Total:     631 passed, 10 skipped
```

## Findings & Actions (round 57)

### Fixed this round

1. **🔴 `sanitize.ts` (`sanitizeForLogOutput`) + `truncate.ts` (`truncateValue`) —
   bare high-entropy secrets under NON-sensitive key names leaked verbatim on
   every surface.** The existing secret redactors (`sanitizeLogOutput`,
   `redactSensitiveFieldValues`, the MCP `redactSensitiveFields` shim, the
   error-handler context scrubber) all key on the *field name* for the
   `[REDACTED]` replacement, and the URL/`key=value`/quoted-value rules only
   fire when the param name appears in the sensitive list. A secret attached
   under a benign key name — `{"config": {"value": "AKIAIOSFODNN7EXAMPLE"}}`,
   `{"data": "sk_live_abc123def456"}`, `notes: ghp_…`, or an array element
   `["sk_live_REALLEAK123"]` — therefore survived verbatim into (a) the
   agent-facing tool output / error message, (b) the durable cross-tenant
   `ai_action_log` row, and (c) the idempotency `result` replay. Verified by
   exercising `redactSensitiveFieldValues` directly: all four cases returned
   the secret unredacted. Added a value-shape bare-token pass to
   `sanitizeForLogOutput`:
   - prefix rules for well-known provider secret shapes (AWS `AKIA`/`ASIA`,
     `sk|rk|pk|ssk_(live|test)_…`, GitHub `ghp_/gho_/…`, Slack `xox[baprs]-…`,
     Google `AIza…`/`ya29.…`, Docker `dop_v1_…`);
   - a generic run rule (`[A-Za-z0-9_./+=-]{20,}` with a mixed-case /
     punctuation requirement) that runs LAST so legitimate `[PATH]`/URL
     collapses are not re-consumed, and a `(?!…REDACTED)` guard so an already
     inserted `[REDACTED_…]` placeholder is never double-wrapped; purely
     lowercase-hex strings (32-char dashless UUIDs, hashes) are intentionally
     spared to avoid destroying legitimate log/audit context.
   `redactSensitiveFieldValues` (used by the audit-log middleware, idempotency
   replay, and error-handler) already routes every string leaf through
   `sanitizeForLogOutput`, so the fix propagates to all three surfaces with no
   further change. Regression tests added (AWS/sk_live/GitHub/array; and a
   benign-identifier false-positive guard for dashless UUIDs / prose / SKU).

2. **🔴 `truncate.ts:71` (`truncateValue` `_preview`) — the truncation preview
   persisted an unredacted secret into durable sinks.** `truncateValue` is the
   final pass before a payload is written to `ai_action_log`/`idempotency_record`.
   The payload is normally pre-redacted by key name, but a secret under a
   non-sensitive key name that *also* exceeds the size bound lands its first
   1 KB in the structured truncation marker's `_preview` field verbatim
   (confirmed: `truncateValue({config:{value:"AKIA…"+x*4000}}, 1024)._preview`
   contained `AKIAIOSFODNN7EXAMPLE`). The `_preview` is now passed through
   `sanitizeForLogOutput` (the bare-token rule from #1) as defense-in-depth, so
   the preview can never carry a raw secret. Regression test added.

### Reviewed but NOT changed (false positives / out of scope)

- **`party.service.ts` `taxId` returned in full on REST responses:** re-verified
  — intra-tenant PII returned to authenticated members; consistent with prior
  rounds' product-decision stance. `isSensitiveFieldName` lists `taxid` for the
  *durable-sink/error* redactor, but success-path DTOs are intentionally not
  redacted (round 56 report already documents this asymmetry). No change.
- **`discovery-tools.ts` type-table `description`/`aiPromptHint` via
  `sanitizeForLogOutput` (no HTML strip):** admin-authored global reference
  data, not user input; reachability to an HTML renderer is nil. Noted for
  awareness, not fixed this round.
- **`tenant.ts:41` indentation / `validateTenantId` vs `validateTenantIdEnhanced`
  trim divergence, `role` claim parsed-but-unenforced (no RBAC), `reasoning`
  not HTML-stripped before audit, NULL `tenant_id` row assertion:** all
  re-verified as latent/deferred with no new 🔴/🟡 exploit path this round,
  consistent with prior rounds.

## Findings & Actions (round 56)

### Fixed this round

1. **🔴 `sanitize.ts` (boundary-variant secret rule) — quoted-JSON secrets
   (`{"api_key":"sk_live_abc123"}`, `password="hunter2"`) were never redacted.** The
   boundary-variant rule's value class excluded `"`/`'`, so any secret wrapped in
   quotes survived verbatim. Because `sanitizeForLogOutput` is the sanitizer applied
   to every error message, tool-output string leaf, audit `reasoning`, and operator
   log line, a driver/handler error echoing a user-supplied config blob or a
   `received` JSON payload (`{"password":"…"}`) persisted the secret verbatim across
   **all** agent/REST/durable surfaces — an asymmetric leak vs. the bare-form rule
   that catches `password=hunter2`. Added a quoted-value variant that covers both the
   JSON object form (`"api_key":"value"`) and the free-text form (`password="value"`)
   (and `?token="…"` via a widened leading boundary). Regression tests added
   (double-quoted JSON value, double-quoted `password=`, single-quoted value,
   query-string quoted form all redacted).

2. **🟡 `errors.ts:39` (`DomainError.toJSON`) — `context` was reflected verbatim,
   skipping key-name redaction.** `toJSON` is the canonical structured serializer
   used for audit logs and idempotency records, but it returned `context` raw while
   every other durable/agent surface runs it through `redactSensitiveFieldValues`.
   A secret attached under a sensitive-named context key (e.g. `password`, `apiKey`)
   reached the durable sinks unredacted. `toJSON` now redacts `context` via the
   shared `redactSensitiveFieldValues`, closing the divergence from the REST
   `DomainExceptionFilter.sanitizeContext` path and the MCP `redactSensitiveFields`
   surface. Regression test added (sensitive-named context values redacted).

3. **🔴 `idempotency.ts:48` — missing idempotency key regressed to a hard error
   (contract break introduced in round 52).** The guard folded the missing-key case
   into the validation error, so any caller that omits an idempotency key — the
   documented ADR-004 no-op pass-through — received `INVALID_IDEMPOTENCY_KEY` and the
   tool never executed. An existing regression test (`should pass through when no
   idempotency key`) was failing as a result. Restored the contract: a missing key is
   a no-op pass-through; only a present-but-invalid key (wrong type, empty, or over
   length) is rejected. Added an explicit empty-string rejection test. Test count
   moved 137→138 (the previously-failing test now passes) in `mcp-tools`.

4. **🟡 `domain-exception.filter.ts:159,188` — `HttpException` string `message` and
   `error` branches omitted `stripHtmlTags`.** The `DomainError` path applies
   `stripHtmlTags`, but the parallel `HttpException` string branches returned only
   `sanitizeForLogOutput`, so a markup payload (`<script>…</script>`) reached REST
   clients verbatim (stored-XSS in any HTML renderer). Both string branches now wrap
   the value in `stripHtmlTags` (matching the `DomainError` path's XSS hardening).
   Regression test added (`<script>`/`<img onerror>` stripped from message).

5. **🟡 `domain-exception.filter.ts:95` — the 500-context operator log line leaked
   values under sensitive-named keys.** `handleDomainError` logged
   `sanitizeForLogOutput(JSON.stringify(context))`, which redacts only URL/token
   *patterns* and does NOT redact values under sensitive-named *keys*. The same
   `context` is correctly redacted in the response body (`sanitizeContext`), so the
   secret was redacted for clients but leaked into operator logs — an asymmetric path
   the MCP surface does not have. The log line now serializes the *redacted* context
   (`redactSensitiveFieldValues`).

### Reviewed but NOT changed (false positives / out of scope)

- **`taxId` returned verbatim in `PartyResult`/`SearchPartiesResult` (intra-tenant
  PII):** re-verified — it is tenant-owned data returned to authenticated members, no
  cross-tenant leak; consistent with how other tenant PII is treated (product
  decision). Noted again because round 55's report asserted it is redacted on the
  MCP success path — that assertion was **incorrect**: `redactSensitiveFieldValues`
  is applied only to error contexts and durable sinks, never to successful response
  DTOs. The report's "misread / no change" conclusion for `taxId` should be read as
  "still a deferred product decision," not "already redacted."
- **`role` claim parsed but never enforced / `create-roles.sql` dev password / seed
  `taxId` literals / `NULL tenant_id` backfill (shipped round 48) / contact-mechanism
  TOCTOU race / audit sink silent-drop under backpressure / superuser role for
  audit+idempotency writes / non-concurrent `CREATE INDEX` / duplicate
  `party_role_active_unique` index definition** — all re-verified as latent/deferred
  with no new 🔴/🟡 exploit path this round.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency
  key charset consistency, ReDoS, and `@Public()` scope scanning** remain intact.

## Test Results
```
shared:    175 passed (4 files)   (+5 — round 56 quoted-JSON + toJSON-context regressions)
mcp-tools: 138 passed (4 files)   (+1 — round 56 idempotency missing-key fix; previously-failing test now green)
database:   25 passed, 10 skipped (2 files)
api:       328 passed (15 files)  (+1 — round 56 HttpException HTML-strip regression)
───────────────────────────────────
Total:     666 passed, 10 skipped
```

## Findings & Actions (round 55)

### Fixed this round

1. **🟡 `party-tools.ts:457` — `nextActions` reflected unsanitized user input to
   the agent (asymmetric secret-leak).** `add_party_role` interpolates
   `input.roleType` (validated only by `sanitizedString` → `stripHtmlTags`, which
   strips HTML but NOT connection strings / `?api_key=…` secrets) into a
   `nextActions` string returned to the agent verbatim. `nextActions` is excluded
   from the audit/error-handler `data`/context redaction, so a crafted
   `roleType` carrying a secret reached the agent live (the round-48
   asymmetric-leak class). The handler now runs `roleType` through
   `sanitizeForLogOutput`, and — as defense-in-depth — the audit-log middleware's
   success path now also sanitizes every `nextActions` element (matching the
   `result.data` redaction), so any future handler reflecting input into
   `nextActions` is covered. Added a regression test asserting the reflected
   `roleType` is scrubbed.

2. **🔴 `queue.module.ts:94` — Redis connection never enabled TLS, sending the
   password and all job payloads in cleartext in non-dev.** Only `host`/`port`/
   `password` were set; `tls` was never configured, so a network observer could
   capture credentials and queued data. Added `resolveTls()` which enables TLS
   (with `rejectUnauthorized: true`) by default in non-development and opt-out via
   `REDIS_TLS=0`. `REDIS_TLS` and `REDIS_PASSWORD` are scrubbed by `sanitize.ts`
   from logs. Added regression tests asserting TLS is present (production default)
   and absent (`REDIS_TLS=0`).

3. **🟡 `queue.module.ts:65` — `REDIS_PORT` silently defaulted to 6380 in
   production (fail-open), inconsistent with the fail-closed `REDIS_HOST` /
   `REDIS_PASSWORD` guards.** An unset `REDIS_PORT` in production would point the
   app at an unintended Redis instance with no error. `resolvePort` now throws in
   non-development when `REDIS_PORT` is unset, mirroring the host/password guards.
   Split the existing test to assert the port guard, and added a test for it.

4. **🟡 `queue.module.ts:82` — `redisRetryStrategy` swallowed the underlying
   error after 10 retries.** A wrong password / unreachable host was retried
   silently then died as a generic "connection failed". The strategy now logs the
   last error's message (`redisRetryStrategy(times, err)`), surfacing
   misconfiguration loudly (consistent with the fail-closed guards).

5. **🟡 `cleanup-expired-idempotency.ts:100` — cleanup could delete in-flight
   `pending` idempotency records, breaking idempotency guarantees.** `expiresAt <
   new Date()` was re-evaluated every batch, so a just-created `pending` row (or
   one whose in-flight request is still executing under a slow/retried call or
   clock skew) could be reaped, causing a retried client to re-execute the side
   effect. The cutoff is now captured ONCE before the loop and `pending` rows are
   explicitly excluded from deletion (`status: { not: "pending" }`) — stale
   pending rows are recovered by the runtime `STALE_PENDING_THRESHOLD_MS` reset,
   not this job.

6. **🟡 `discovery-tools.ts:41,96` — unbounded `entity` filter + unsanitized
   type-table strings reflected to the agent.** `list_available_tools`' `entity`
   had no max length (every other MCP string input enforces one); `get_type_table
   _values` read `description`/`aiPromptHint` from the admin (RLS-bypassing)
   client and returned them verbatim. Added `MAX_ENTITY_LENGTH` bound and ran
   both fields through `sanitizeForLogOutput` before reflecting them.

### Reviewed but NOT changed (false positives / out of scope / deferred)

- **`taxId` returned under key `taxId` on the REST live response / MCP `data`:**
   `taxId` IS in the `SENSITIVE_FIELD_NAMES` set, so it is redacted by
   `redactSensitiveFields` (audit) AND the MCP success-path `result.data`
   redaction AND the canonical `redactSensitiveFieldValues`. The earlier claim
   that it leaks was a misread — no change.
- **MCP transport JSON body size:** `main.ts:233` already sets
   `express.json({ limit: "100kb" })`, so the "unbounded `arguments` parse"
   concern is already mitigated at the boundary. No change.
- **Contact-mechanism duplicate check TOCTOU race (`party.service.ts`):** a
   genuine read-then-insert window exists at READ COMMITTED for
   `add_contact_mechanism` (no unique constraint, unlike `party_role` which has
   one). Logged as a deferred hardening item — adding a unique constraint /
   SERIALIZABLE isolation is a schema change requiring migration review; out of
   scope for this round's low-risk fixes.
- **Audit sink silent-drop under backpressure (`audit-log.ts`):** by-design
   "audit never breaks the tool" behaviour; noted as a future metric/alert
   candidate, not changed this round.
- **Superuser role for audit/idempotency writes (`rls-setup.sql`):** creating a
   least-privilege service role is a larger migration/ops change; deferred.
- **`create-roles.sql` hardcoded dev password / seed `taxId` literals / NULL
   `tenant_id` backfill to `''`:** noted as latent hygiene items; the migration
   backfill is already shipped, and the dev-role password is gated by comment.
   No code change this round.
- **Tenant isolation (RLS boot assertions, superuser boot refusal, app-level
   `tenantId` filters), secret redaction across REST/MCP/durable surfaces,
   idempotency-key charset consistency, ReDoS, and `@Public()` scope scanning**
   remain intact and were re-verified. No new 🔴/🟡 exploit paths beyond the
   fixes above.

## Test Results
```
shared:    170 passed (4 files)   (unchanged)
mcp-tools: 137 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)
api:       327 passed (15 files)  (+3 — round 55 queue TLS/port + party nextActions)
─────────────────────────────────────
Total:     659 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 3 pre-existing complexity warnings (unchanged)
- `npm run test` — all passing: shared 170, mcp-tools 137, database 25 (10 RLS
  isolation tests skipped without a live DB), api 324

## Findings & Actions (round 54)

### Fixed this round

1. **🟡 `error-handler.ts:40` — MCP `sanitizeContextValue` depth cap (10) diverged from the canonical shared redactor (20).**
   `MAX_SANITIZE_DEPTH = 10` caused the error-handler to return `"[Too deep]"` for
   `DomainError.context` trees 11–20 levels deep, while the REST canonical redactor
   (`redactSensitiveFieldValues`, `MAX_REDACTION_DEPTH = 20`) and the audit-log
   redactor (`MAX_REDACTION_DEPTH = 20`) preserved those trees. A legitimately deep
   diagnostic context was silently dropped on the MCP agent-facing surface — data
   loss, not a secret leak, but a consistency gap between the two "must-match"
   redactors. Changed the error-handler to import and use the shared `MAX_REDACTION_DEPTH`
   constant, eliminating the local `MAX_SANITIZE_DEPTH = 10` constant. Added a
   regression test (a 21-level deep context tree is fully preserved on the agent
   surface).

### Reviewed but NOT changed (false positives / out of scope)

- **`role` claim parsed but unenforced / `taxId` returned verbatim /
  dev DB password / non-concurrent `CREATE INDEX` / `ai_action_log.tenant_id`
  nullable** — same documented latent gaps & deferred items as rounds 45–50;
  no change this round.
- **`prisma.service.ts` RLS boot assertions, `rls-extension.ts` context
  reset, `discovery-tools` global reference data, `secret-strength` zero-entropy
  heuristic (does not catch 2-char repeats like `abab…`), `searchParties`
  `mode:"insensitive"` substring DoS** — re-verified clean / accepted as
  defense-in-depth or product decisions this round; tenant isolation (RLS boot
  assertion + superuser boot refusal + app-level `tenantId` filters), secret
  redaction across REST/MCP/durable surfaces, idempotency-key charset
  consistency, and ReDoS remain intact. No new 🔴/🟡 exploit paths beyond the
  one fix above.

## Test Results
```
shared:    170 passed (4 files)   (unchanged)
mcp-tools: 137 passed (4 files)   (+1 — round 51 depth-alignment regression)
database:   25 passed, 10 skipped (2 files)
api:       324 passed (15 files)  (unchanged)
─────────────────────────────────────
Total:     656 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 170, mcp-tools 136, database 25 (10 RLS
  isolation tests skipped without a live DB), api 324

## Findings & Actions (round 50)

### Fixed this round

1. **🔴 `tool-registry.ts:224` — Zod validation `message` returned to the AI
   agent was NOT secret-sanitized (asymmetric secret-leak; contradicts its own
   comment).** On validation failure the pipeline joins each issue's
   `path: message` into a single `detail` string, length-caps it, and embeds it
   verbatim in the agent-facing top-level `error.message`. The parallel
   `context.issues` array *is* scrubbed via `sanitizeIssues`, but `detail` was
   only `.slice()`-capped — so a secret embedded in an issue `message` (a custom
   `errorMap`/`.refine()` that echoes the received value, or a connection
   string) leaked verbatim to the agent in `error.message` while `context.issues`
   redacted it. This is exactly the asymmetric-leak class rounds 42/44/48/49
   closed on every other surface; `errorHandlerMiddleware` only catches
   *thrown* errors and this soft-failure return is never thrown, so it reached the
   agent unsanitized. `detail` now runs through `sanitizeForLogOutput` before
   being embedded (matching `context.issues`). The latent `party-tools`
   `leaky_tool` fixture already carried the secret in the top-level message; the
   regression test now asserts `error.message` does not contain it and contains
   `[HOST]/[PATH]`.

2. **🔴 `sanitize.ts:152` — OAuth `#fragment` tokens (`#access_token=`,
   `#id_token=`) were never redacted.** The query-string secret rule only matched a
   `(?<=[?&])` lookbehind, so a secret delivered in a URL fragment (the
   OAuth implicit-flow delivery mechanism) survived verbatim — the subsequent
   `(https?://)… → [HOST]/[PATH]` collapse requires a leading scheme+host and
   never consumes a bare `#token=…`. Added `id_token` to the param-name
   alternation and `#` to the lookbehind so fragment secrets are replaced, not
   annotated. Added regression tests (`#token=`, `#id_token=`).

3. **🔴 `sanitize.ts:152` + `crypto.ts` — `;` was not treated as a
   query-parameter separator, and `id_token` was missing from the param list.**
   Frameworks that parse `;` as a separator (PHP, some OAuth libs) would leak a
   `;token=…` value when no leading `?`/`&`/`#` preceded it. Added `;` to
   the lookbehind and excluded it from the value class (so a `?a=1;token=…`
   immediately following another param is still caught). Regression tests added for
   both `;token=` and `?token=x;other=2`.

4. **🔴 `crypto.ts:69` — `sortSet` never charged its element bytes to the
   aggregate hash budget (bypassed the round-38 DoS guard).** `sortArray`/
   `sortPlainObject`/`sortMap` all charge string *values* and (for maps) keys to
   `budget.bytes` via `checkStringBounds`/`chargeKeyBytes`, but `sortSet`
   called `JSON.stringify(v)` only to sort and never charged the elements. A
   `Set` of ~30 × 99 KB strings (≈3 MB) therefore hashed successfully and
   emitted a ~3 MB `JSON.stringify` buffer, defeating `MAX_HASH_TOTAL_BYTES`.
   `sortSet` now charges each element's serialized bytes (and the sort path already
   charged the string values via `sortKeysDeep`). Regression test added (a wide
   Set of distinct near-limit strings now throws the aggregate-size-limit error).

5. **🟡 `queue.module.ts:27` — `REDIS_HOST` silently defaulted to
   `localhost` even in production.** Only the Redis *password* was enforced in
   non-development; an unset/empty `REDIS_HOST` fell back to `localhost`, so a
   misconfigured production instance would connect to an unintended (and
   unauthenticated) Redis rather than failing closed. Mirroring the password
   guard, `REDIS_HOST` is now required when `NODE_ENV !== "development"`;
   only development keeps the localhost fallback. Added a production host-guard
   regression test.

6. **🟡 `party.service.ts:775` — telecom duplicate check ignored
   `countryCode`.** `checkTelecomDuplicate` matched only on
   `(areaCode, lineNumber)`, so `+1 555 1234` and `+44 555 1234` collided
   as the same number — incorrect for international subscribers and a
   correctness gap. The check (and the create path that feeds it) now scope on
   `countryCode` too (defaulting to `+1` when omitted, matching the stored
   value). Added a regression test asserting `countryCode` is in the
   duplicate-check `where`.

7. **🟡 `party-tools.ts:251` — MCP email validation diverged from the REST/
   service layer.** The MCP `emailAddressSchema` used Zod's built-in `.email()`,
   while `party.service.ts` enforces the stricter `EMAIL_REGEX`. Zod accepts
   addresses `EMAIL_REGEX` rejects (e.g. a double-dot local part
   `a..b@x.com`), so an MCP-submitted address could pass validation and then be
   rejected by the service's duplicate-check/re-validation. The MCP path now runs
   through the same `EMAIL_REGEX`.

8. **🟢 `audit-log.ts:18` / `audit-log.ts:240` — the MCP `redactSensitiveFields`
   diverged from the canonical shared redactor on depth cap (10 vs 20) and
   non-string Map keys.** The two "must-match" redactors disagreed: a legitimately
   deep (11–20 level) payload was over-redacted (`[Too deep]`) on the MCP/
   durable surface while the REST canonical redactor preserved it, causing silent
   data loss in `ai_action_log`/idempotency for deep-but-legitimate objects; and
   a `Map` keyed by an object whose `toString()` yields a sensitive name was
   redacted on REST (`String(k)`) but not on MCP. Aligned
   `MAX_REDACTION_DEPTH` to 20 and switched `redactMap` to `String(k)` for
   parity. Regression tests updated/added (`too-deep` nesting now uses 25
   levels; non-string sensitive Map key redacted on both surfaces).

### Reviewed but NOT changed (false positives / out of scope)

- **`role` claim parsed but unenforced / `taxId` returned verbatim /
  dev DB password / non-concurrent `CREATE INDEX` / `ai_action_log.tenant_id`
  nullable** — same documented latent gaps & deferred items as rounds 45–49;
  no change this round.
- **`prisma.service.ts` RLS boot assertions, `rls-extension.ts` context
  reset, `discovery-tools` global reference data, `secret-strength` zero-entropy
  heuristic (does not catch 2-char repeats like `abab…`), `searchParties`
  `mode:"insensitive"` substring DoS** — re-verified clean / accepted as
  defense-in-depth or product decisions this round; tenant isolation (RLS boot
  assertion + superuser boot refusal + app-level `tenantId` filters), secret
  redaction across REST/MCP/durable surfaces, idempotency-key charset
  consistency, and ReDoS remain intact. No new 🔴/🟡 exploit paths beyond the
  eight above.

## Test Results
```
shared:    170 passed (4 files)   (+3 — round 50 fragment/; Set-budget regressions)
mcp-tools: 136 passed (4 files)   (+2 — round 50 validation-message + non-string Map-key regressions)
database:   25 passed, 10 skipped (2 files)
api:       324 passed (15 files)  (+2 — round 50 Redis-host + telecom-countryCode regressions)
───────────────────────────────────
Total:     655 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 164, mcp-tools 134, database 25 (10 RLS
  isolation tests skipped without a live DB), api 322

## Findings & Actions (round 49)

### Fixed this round

1. **🔴 `sanitize.ts:152` — `sanitizeLogOutput` query-string secret rule
   *annotated* the secret instead of *replacing* it (live secret-leak in the
   core redaction primitive).** The rule matched the full `param=value` and
   returned `m.replace(...)+"[REDACTED]"`, so `api_key=sk_live_abc123` became
   `api_key=sk_live_abc123[REDACTED]` — the **secret text survived verbatim**
   in the output. Every surface (REST `DomainExceptionFilter`, MCP
   `error-handler`/`audit-log`/`idempotency`/`tool-registry`, durable sinks)
   composes `sanitizeLogOutput`, so this bypassed redaction everywhere it was
   used. It stayed hidden through rounds 44–48 because every existing regression
   test fed an `https://…?param=secret` URL, and the *subsequent*
   `(https?://)… → [HOST]/[PATH]` collapse folded the whole URL (secret included)
   away — masking the defective query rule. The leak is real whenever a
   secret-bearing query string appears **without** a leading `https://` URL (a
   bare `?api_key=…`, a `reasoning`/log line, a curl arg). The rule now
   captures the `param=` prefix and the bare value in separate groups and returns
   `param=[REDACTED]` (`api_key=sk_live_abc123` → `api_key=[REDACTED]`).
   Added a regression test that exercises the no-URL case (previously uncovered).

2. **🔴 `audit-log.ts:42` — `reasoning` was persisted to the durable
   `ai_action_log` sink un-sanitized (asymmetric secret-leak to the durable
   row).** `reasoning` originates from the AI agent / tool-call context
   (attacker-influenceable via the MCP request body) and is written verbatim to
   `ai_action_log.reasoning`, a cross-tenant audit table. Every *other* durable
   sink (`toolInput`, `toolOutput` → both `redactSensitiveFields`) and every
   agent-facing surface run through `sanitizeForLogOutput`, but `reasoning` was
   only length-sliced to `MAX_REASONING_LENGTH` — so a connection string,
   JWT, or `?api_key=…` embedded in it leaked into the durable row. This is
   the same class of asymmetric-leak round 44/48 closed for the other sinks,
   now extended to `reasoning`. It was also the *trigger* that exposed finding
   #1: a `reasoning` string carries no `https://` URL, so the masked
   query-rule defect surfaced. `reasoning` now runs through
   `sanitizeForLogOutput` before being persisted (matching `toolInput`
   handling). Added a regression test (connection string + `?api_key=…` in
   `reasoning` redacted in the durable row).

### Reviewed but NOT changed (false positives / out of scope)

- **`prisma.service.ts` `verifyRlsEnabled` (round 48 rewrite)** — re-verified:
  the query selects ALL `relkind='r'` tables in `public` and diffs the actual
  force-RLS set against the `tenantTables` enumeration; a force-RLS table not
  in the list still refuses to boot. No false-positive on global (non-tenant)
  tables. Intact.
- **`crypto.ts` aggregate byte budget / `truncate.ts` nested Map-Set /
  `idempotency.ts` soft-failure capping / `redactSensitiveFields` (round 48)
  / `tool-registry.ts` UNKNOWN_TOOL name sanitization (round 48)** — re-verified
  clean this round; tenant isolation (RLS boot assertion + superuser boot
  refusal + app-level `tenantId` filters), secret redaction across
  REST/MCP/durable surfaces, idempotency-key charset consistency, and ReDoS
  remain intact. No new 🔴/🟡 exploit paths beyond the two above.
- **`create-roles.sql` dev password / `role` claim parsed-but-unenforced /
  `taxId` returned verbatim in response DTOs / non-concurrent `CREATE INDEX` /
  `ai_action_log.igrant_id` nullable (closed round 48)** — same documented
  latent gaps / deferred items as rounds 45–48; no change this round.

## Test Results
```
shared:    167 passed (4 files)   (+1 — round 49 query-rule no-URL regression)
mcp-tools: 135 passed (4 files)   (+1 — round 49 reasoning-sanitize regression)
database:   25 passed, 10 skipped (2 files)
api:       322 passed (15 files)  (unchanged)
───────────────────────────────────
Total:     649 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 166, mcp-tools 134, database 25 (10 RLS
  isolation tests skipped without a live DB), api 322

## Findings & Actions (round 48)

### Fixed this round

1. **🔴 `sanitize.ts:161` — O(n²) ReDoS in the generic credential-URL catch-all
   (event-loop-blocking DoS).** `sanitizeLogOutput`/`sanitizeForLogOutput` had no
   input-length cap, and the generic `scheme://user:pass@host` catch-all used an
   unbounded greedy scheme prefix `[a-zA-Z][a-zA-Z0-9+.-]*`. On a long run of
   letters with no `://` the engine backtracked char-by-char at every offset —
   empirically ~6.9 s for a 100k-char string. This is called on hot, synchronous,
   agent-facing **and** durable-persist paths (MCP `error-handler`, `audit-log`,
   `idempotency`, `tool-registry`; and `redactSensitiveFieldValues` runs it on every
   string leaf), so a single crafted ~100k-char error/tool-output blocks the event
   loop for seconds. The scheme length is now capped at `{1,31}` (linear; ~13 ms at
   100k, verified), and a defensive `MAX_LOG_OUTPUT_LENGTH = 100_000` byte cap was
   added at the top of `sanitizeLogOutput` (the `.slice(...)` callers truncate
   *after* this runs, so they did not mitigate the cost). Added a regression test
   (100k letter run returns in < 500 ms; credential URLs still redacted).

2. **🟡 `audit-log.ts:256` — MCP `redactSensitiveFields` did not sanitize string
   leaves (asymmetric secret-leak vs. the canonical REST redactor).** The local
   `isTerminal` short-circuit returned raw **strings** verbatim, so a connection
   string / JWT / `?api_key=…` embedded in a tool result *value* under a
   benign-named key (`url`, `note`) survived the MCP redactor even though the canonical
   shared `redactSensitiveFieldValues` (used by the REST `DomainExceptionFilter`)
   scrubs every string leaf via `sanitizeForLogOutput`. The secret therefore leaked to
   the agent (live path, `audit-log.ts:85`), the `ai_action_log` durable row
   (`audit-log.ts:217`), and any idempotency replay (`idempotency.ts:267`). String
   leaves now pass through `sanitizeForLogOutput` (matching the REST surface). Added a
   regression test (connection string under `url`/`note` scrubbed on live + durable).

3. **🟡 `prisma.service.ts:255-289` — `verifyRlsEnabled` "unexpected table" guard
   was unreachable dead code (contradicted the round-44 invariant).** The query
   filtered `WHERE relname = ANY(tenantTables)`, so `forceRlsCount` was derived only
   from the enumerated rows and could never exceed `tenantTables.length` — the
   `unexpected` branch (meant to catch a new tenant table added to `rls-setup.sql`
   but omitted from the list) could never fire, so the gap round 44 #6 intended to
   close stayed open. The query now selects **all** `relkind='r'` tables in `public`
   and diffs the actual force-RLS set against the enumeration; a force-RLS table not
   in the list now refuses to boot. No false-positive on global (non-tenant) tables
   since those never have FORCE RLS.

4. **🟡 `migrations/20260718000000_ai_action_log_tenant_id_not_null` — closed the
   `ai_action_log.tenant_id` nullable drift (the long-deferred "nullable concern",
   real migration root cause).** The init migration declared `ai_action_log.tenant_id`
   as `TEXT` (nullable) while `schema.prisma` mandates `NOT NULL` and every other
   tenant table uses `TEXT NOT NULL`. Because the migrations are shipped/squashed, a
   freshly `migrate deploy`-ed database had a genuinely nullable column — a direct/raw
   insert could write a NULL `tenant_id` row invisible to all tenants under RLS (no
   cross-tenant leak, but a stranded-audit/data-integrity gap and a false assumption
   for any consumer trusting `tenant_id` is always present). New migration backfills
   any NULL to `''` and sets `NOT NULL`.

5. **🟢 `tool-registry.ts:149-157` — `UNKNOWN_TOOL` reflected the raw requested
   tool name without sanitization.** `name` is attacker-controlled (the requested
   tool) and the result bypasses `errorHandlerMiddleware`, so a crafted name embedding
   a secret-bearing URL (`foo?api_key=…`) reached the agent unsanitized. The name
   (and similar-name suggestions) now run through `sanitizeForLogOutput` before being
   reflected. Added a regression test.

### Reviewed but NOT changed (false positives / out of scope)

- **`create-roles.sql:19` committed dev password `'besterp_app_dev'`** — dev-only
  (`NOINHERIT`, documented in-file warning; `rls-setup.sql` refuses if `besterp_app`
  is a superuser). A real credential-hygiene footgun if copied to staging/prod
  verbatim, but out of scope for this round (tracked since round 35).
- **`role` claim parsed but dropped on the REST path** — `JwtStrategy.validate()`
  populates `JwtValidatedUser.role` (validated) but it is never consumed by
  `TenantContext`/a `RoleGuard` (grep-confirmed: no RBAC layer exists). Same
  documented latent gap as rounds 45/46; deferred to a dedicated RBAC follow-up.
- **`taxId` returned verbatim in `PartyResult`/`ContactMechanismResult`** — the
  sensitive-field redactor is applied only to *error* contexts and *durable* sinks,
  not successful response DTOs; consistent with how other tenant-owned PII is treated
  (product decision). Deferred (unchanged from round 45/46).
- **`migration/20260619000000…` non-concurrent `CREATE INDEX`** — flagged LOW in
  round 38; `IF NOT EXISTS` present, comment documents manual `CONCURRENTLY`.
  Changing shipped migrations is risky; deferred.
- **`party.service.ts` / `discovery-tools.ts` / `queue.module.ts` / `prisma.service.ts`
  / `mcp.module.ts` / `crypto.ts` / `truncate.ts` / `rls-extension.ts` / REST filter
  / `sanitize.ts` (other rules) / `sensitive-fields.ts`** — re-verified clean this
  round; tenant isolation (RLS boot assertion + superuser boot refusal + app-level
  `tenantId` filters), secret redaction across REST/MCP/durable surfaces, idempotency
  consistency, and ReDoS remain intact. No new 🔴/🟡 exploit paths beyond the five
   above.

## Test Results
```
shared:    166 passed (4 files)   (+2 — round 48 ReDoS + credential-URL regression)
mcp-tools: 134 passed (4 files)   (+2 — round 48 string-leaf + UNKNOWN_TOOL name regressions)
database:   25 passed, 10 skipped (2 files)
api:       322 passed (15 files)  (unchanged)
───────────────────────────────────
Total:     647 passed, 10 skipped
```

## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — all passing: shared 164, mcp-tools 132, database 25 (10 RLS
  isolation tests skipped without a live DB), api 322


## Baseline (before this round)
- `npm run typecheck` — clean across all workspaces
- `npm run lint` — 1 pre-existing complexity warning in `crypto.ts:sortKeysDeep`
  (cyclomatic complexity 17, max 15)
- `npm run test` — all passing: shared 164, mcp-tools 132, database 25 (10 RLS isolation
  tests skipped without a live DB), api 322

## Findings & Actions (round 47)

### Fixed this round

1. **🟢 `crypto.ts:sortKeysDeep` — cyclomatic complexity 17 exceeded the lint cap (15),
   the only outstanding lint warning from round 46.** The entry point inlined every
   type-dispatch branch (null/undefined, number, string, array/Map/Set/object, primitive)
   plus the depth guard, pushing it two points over the configured `max-complexity` of 15.
   Extracted the non-null/non-primitive dispatch into a new `dispatchContainer()` helper,
   which preserves the exact budget/ancestors threading (the `budget ?? { bytes: 0 }`
   defaulting for string/number short-circuits is kept local to `sortKeysDeep`) and the
   single recursive call site for each container type. `sortKeysDeep` drops to complexity 14;
   `dispatchContainer` is 6. `npm run lint` is now 0 errors / 0 warnings across all
   workspaces. No behavior change — full shared test suite (164) still passes, and the
   canonical-form / aggregate-budget / depth-guard regression tests are unchanged.

### Reviewed but NOT changed (false positives / out of scope)

- **`jwt.strategy.ts` `role` claim parsed but never enforced** — `JwtStrategy.validate()`
  populates `JwtValidatedUser.role` (validated, trimmed, length-capped) but it is never
  consumed by `TenantContext`, any `RoleGuard`, or an authorization check (grep-confirmed:
  no RBAC layer exists). This is the same design gap flagged in round 45. It is NOT a live
  exploit (an unused claim cannot grant or deny access), but it is a latent footgun that
  implies authz exists where none does. Round 45 framed the fix as "add a real RBAC layer
  or remove `role` from the JWT contract" — both are contract/feature changes that exceed a
  review-round fix and risk breaking live token issuers. Deferred to a dedicated RBAC
  follow-up; left documented here so it is tracked, not forgotten.
- **`taxId` returned verbatim in `PartyResult`/`ContactMechanismResult`** — re-verified: the
  sensitive-field redactor (`isSensitiveFieldName`) is applied only to *error* contexts and
  *durable* sinks, not to successful response DTOs, so a tenant-owned `taxId` is returned to
  any authenticated tenant member. This is consistent with how other tenant-owned PII is
  treated and is a product decision, not a cross-tenant leak. Deferred (unchanged from
  round 45).
- **`sanitize.ts` generic-URL catch-all (path-secret) "known limitation"** — re-verified:
  the generic `(https?:\/\/)[^\s"')}]+ → [HOST]/[PATH]` rule collapses the *entire* URL
  tail (path + query) into `[PATH]`, so a secret embedded anywhere in the URL — including
  the path — is already scrubbed. The round-44 "known limitation" (secret in URL path) is
  in fact already covered by this collapse; the dedicated regression test
  (`path contains sensitive data` → `sk-live-abc123` removed) passes. No change needed.
- **`party.service.ts` / `discovery-tools.ts` / `queue.module.ts` / `prisma.service.ts` /
  `mcp.module.ts` / `crypto.ts` (aggregate budget)** — re-verified clean: tenant isolation
  (RLS boot assertion + superuser boot refusal + app-level `tenantId` filters), secret
  redaction across REST/MCP/durable surfaces, and idempotency-key charset consistency remain
  intact. No new 🔴/🟡 exploit paths.

## Test Results
```
shared:    164 passed (4 files)   (unchanged)
mcp-tools: 132 passed (4 files)   (unchanged)
database:   25 passed, 10 skipped (2 files)
api:       322 passed (15 files)  (unchanged)
───────────────────────────────────
Total:     643 passed, 10 skipped
```

## Findings & Actions (round 46)

### Fixed this round

1. **🟡 `health.service.ts` — anonymous `/version` fingerprints the build in production.**
   `getVersion()` is served by the `@Public()` `HealthController.getVersion()` (no JWT), so
   it is reachable by anyone. It returned the package `name` + `version` (and `build`
   number/date) verbatim in **every** environment, including production — an exact
   name + semantic version fingerprints the deployed release and lets an attacker target
   known CVEs for that specific build. This is the same infrastructure-fingerprinting
   class the anonymous `/health` body was already minimised against (round 33/34): that
   endpoint returns only `{ status, timestamp, database }`. The `build`/`warning`
   suppression already keyed on `NODE_ENV === "production"`, but `name`/`version` were
   never gated. `getVersion()` now returns generic `"redacted"` markers for `name`/`version`
   (and omits `build`/`warning`) in production, matching the fail-closed `/health` body;
   non-production keeps the full triplet for operator debugging. Added regression tests
   (production redaction; non-production disclosure).

2. **🟡 `jwt-auth.guard.ts` / `tenant.guard.ts` — `@Public()` was an unscoped global auth
   opt-out (silent unauthentication footgun).** `@Public()` is a boolean decorator honoured
   by both `JwtAuthGuard` and `TenantGuard` for *any* controller or method. For a
   multi-tenant system that is a standing footgun: a single misplaced `@Public()` silently
   unauthenticates a tenant-scoped route — exposing data to anonymous callers with no
   warning at boot or runtime. Only `HealthController` is legitimately public today, so the
   broad opt-out was pure latent risk. Added `auth/public-scope.ts` with
   `isPublicAllowedForHandler()`, which fails closed (`ForbiddenException`) unless the
   handler's controller is `HealthController`; both guards now call it before honoring
   `@Public()`. A future attempt to opt any other controller out of authentication is
   rejected at request time rather than silently bypassed. Added a regression test
   (non-health `@Public()` throws `ForbiddenException`; health stays allowed).

### Reviewed but NOT changed (false positives / out of scope)

- **`role` claim parsed but dropped on the REST path** — `JwtStrategy.validate()` populates
  `JwtValidatedUser.role` (validated, trimmed, length-capped), but `TenantContext`
  (`tenant-context.ts`) has no `role` field, so it is never enforced. There is **no RBAC**
  layer anywhere in the codebase (grep-confirmed: `user.role`/`req.user` only appear in
  tests/comments), so the claim is unused for authorization. This is a design gap, not a
  live exploit — enforcing an unused claim would create a false sense of authz. Deferred:
  either add a real `RoleGuard`/`Roles()` RBAC layer or remove `role` from the JWT contract
  until RBAC exists. Flagged as a follow-up to track; out of scope for this round's
  concrete fixes.
- **`taxId` returned verbatim in `PartyResult`/`ContactMechanismResult`** — the redaction
  pattern (`redactSensitiveFieldValues`) is applied only to *error* contexts, not to
  successful response DTOs. `taxId` (PII/tax data) is therefore returned to any
  authenticated tenant member. Likely intended (tenant-owned data), but inconsistent with
  how contact-mechanism PII is treated elsewhere. Flagged for awareness; masking in
  list/search responses is a product decision, deferred.
- **`@IsDateString()` on optional date DTO fields** — default class-validator accepts some
  non-strict forms, but the service layer re-validates with `isValidISODate`, so the DTO
  check is not the final gate. Defense-in-depth holds. No change.
- **`party.service.ts` / `discovery-tools.ts` / `queue.module.ts` / `prisma.service.ts` /
  `mcp.module.ts`** — re-verified clean this round; tenant isolation (RLS boot assertion +
  superuser boot refusal + app-level `tenantId` filters + spread-after-`tenantId`
  controllers), secret redaction across all agent/REST/durable surfaces, and idempotency
  key charset consistency remain intact. No new 🔴/🟡 exploit paths.

## Test Results
```
shared:    164 passed (4 files)   (unchanged vs round 44)
mcp-tools: 132 passed (4 files)   (unchanged vs round 44)
database:   25 passed, 10 skipped (2 files)
api:       316 passed (14 files)  (+3 — round 45 /version redaction + @Public() scope tests)
───────────────────────────────────
Total:     637 passed, 10 skipped
```

## Findings & Actions (round 44)

### Fixed this round

1. **🔴 `domain-exception.filter.ts` — DomainError `message` reflected to REST clients
   was NOT secret-redacted (only HTML-stripped), an asymmetric leak vs. the parallel
   MCP agent surface.** The non-500 production path built
   `message: stripHtmlTags(sanitizeLogMessage(exception.message))` — `sanitizeLogMessage`
   only strips control chars/ANSI, so a connection string, `Bearer` token, or
   `?token=…` secret embedded in a DomainError message (which routinely echoes
   user-supplied input) reached REST clients verbatim while the same message was
   scrubbed to `[DATABASE_URL]`/`[REDACTED]` for AI agents. Changed the message to
   `stripHtmlTags(sanitizeForLogOutput(exception.message))`, matching the file's own
   `handleUnexpectedError` path and the MCP `error-handler`. Added a regression test
   (connection string in DomainError message redacted in production).

2. **🟡 `domain-exception.filter.ts` — dev `context` tree was control-char sanitized but
   NOT field-name redacted, leaking secrets under sensitive-named keys to REST dev
   clients.** `sanitizeContext` only ran `sanitizeForLogOutput` per string leaf; a
   `DomainError` thrown with `context: { apiKey: "sk_live_…" }` reflected verbatim to
   REST dev clients while MCP agents saw `"[REDACTED]"`. Promoted the field-name
   redactor to `@besterp/shared` as `isSensitiveFieldName` + `redactSensitiveFieldValues`
   (single source of truth, reused by the REST filter), and changed `sanitizeContext`
   to redact the whole tree at once so the key is visible to the redactor. Added a
   regression test (`password`/`apiKey` redacted in dev context).

3. **🟡 `domain-exception.filter.ts` — `HttpException` validation-array messages were not
   secret-scrubbed.** A custom validator embedding a `Bearer …`/connection-string secret
   in a non-quoted message survived to REST clients (the existing strip step only removes
   quoted/`received:` values). Each cleaned message now passes through `sanitizeForLogOutput`
   before being returned. Added a regression test (embedded bearer token redacted).

4. **🔴 `idempotency.ts` — soft-failure `error.message` was persisted to the durable
   `idempotency_record` WITHOUT secret redaction (asymmetric with the hard-fail path).**
   The thrown-error branch scrubs the message via `sanitizeForLogOutput`; the
   `success:false` (non-thrown) branch only `capString`'d it — so a tool returning a
   non-thrown failure whose message embeds a connection string persisted that secret
   verbatim into the 24h-TTL durable row, which the thrown path redacted. Wrapped the
   soft-failure `message` in `sanitizeForLogOutput` (matching the already-scrubbed
   `code`). Added a regression test (connection string redacted in soft-failure record).

5. **🟡 `sanitize.ts` — `sanitizeLogOutput` query-string secret redactor missed common
   secret-bearing param names** (`pwd`, `passwd`, `signature`, `sign`, `otp`, `code`,
   `session`, `client_id`, `bearer`). Broadened the alternation so secrets in those
   query params are redacted across every surface that uses `sanitizeLogOutput`. Added
   regression tests.

### Reviewed but NOT changed (false positives / out of scope)

- **`crypto.ts` aggregate hash budget quote-overhead rounding** — flagged by the
  shared-package review: `checkStringBounds`/`chargeKeyBytes` charge JSON quote/bracket
  overhead only for keys, not string *values*, so `JSON.stringify` output can exceed
  `MAX_HASH_TOTAL_BYTES` by a bounded margin (a few %). The cap is a safety backstop for
  idempotency hashing; legitimate inputs are tiny and the overflow is bounded by quote
  overhead, not orders of magnitude. Deferred as defense-in-depth — no exploit path.
- **`sanitize.ts` generic-URL catch-all (no userinfo)** — a non-credential URL with a
  secret in the *path* (not `user:pass@` userinfo) is not redacted by the catch-all.
  Low-frequency; out of scope for this round (query-string secrets are now covered, which
  covers the realistic cases). Documented as a known limitation.
- **`prisma.service.ts` tenant propagation, `mcp.module.ts` idempotency-key validation,
  `truncate.ts` byte safety, error-handler no-stack-leak** — re-verified clean this round.

## Test Results
```
shared:    154 passed (4 files)   (+1 — round 43 redactor + broadened-param tests)
mcp-tools: 130 passed (4 files)   (+1 — round 43 soft-failure durable-sanitize regression)
database:   25 passed, 10 skipped (2 files)
api:       312 passed (14 files)  (+3 — round 43 REST redaction regression tests)
───────────────────────────────────
Total:     621 passed, 10 skipped
```

## Findings & Actions (round 44)

### Fixed this round

1. **🔴 `sensitive-fields.ts` — the MCP surface used a divergent sensitive-field detector that
   omitted `code`/`session`/`signature`/`sign` (asymmetric secret leak).** Round 43 promoted
   `isSensitiveFieldName` to `@besterp/shared` as the single source of truth and added those four
   names to it, but the three MCP middlewares (`audit-log`, `error-handler`, `tool-registry`) kept
   using a local `isSensitiveField` without them. A value under a key named `code` (MFA/verification
   code), `session` (session token), `signature`, or `sign` (signing secret) was redacted on the
   REST surface but **leaked** on the agent-first MCP surface — through the live tool result,
   `ai_action_log.tool_input`/`toolOutput`, the idempotency persist + replay paths, and validation
   `issues.received`. Made `sensitive-fields.ts` delegate to the shared `isSensitiveFieldName`
   (and `splitFieldTokens` to the shared tokeniser), removing the duplicated local set/regex/tokens
   so the two surfaces cannot diverge. Added regression tests (the four previously-missed names are
   now redacted; the MCP detector agrees with the shared one on a sample).

2. **🔴 `sanitize.ts` — the shared `redactSensitiveFieldValues` (used by the REST filter's dev
   `context` reflection) dropped `Map`/`Set` to `{}` and had no recursion depth cap.** A `Map`/`Set`
   fell through to `Object.entries(...)` → `[]`, so it serialised to `{}` (data loss) and, unlike the
   MCP `redactSensitiveFields`, it never redacted sensitive-named Map/Set keys — `new Map([["password",
   "hunter2"]])` reflected as `{}` on REST while the MCP surface redacted it. With no depth guard, a
   deeply nested attacker-influenced `DomainError.context` could blow the stack on the REST dev path
   (DoS). Rewrote it as the complete canonical redactor: depth-guarded (`"[Too deep]"` past
   `MAX_REDACTION_DEPTH`), Map/Set-aware (converted to JSON-safe `[k,v]`/array form with sensitive
   keys redacted), cycle-guarded. Split container handling into helper functions to stay under the
   lint complexity cap. Added regression tests (Map key redaction, Map/Set preservation, depth guard).

3. **🔴 `domain-exception.filter.ts` — the REST `HttpException` string `message`/`error` branches
   were not secret-scrubbed in production (asymmetric leak).** Round 43 sanitized the array
   validation-message branch and `DomainError` messages, but the `typeof res.message === "string"`
   branch copied the message verbatim and `res.error` was copied verbatim. A custom/upstream
   `HttpException` carrying a connection string or `Bearer` token in its string `message`/`error`
   reached REST clients in production unredacted while the same value was scrubbed on the MCP surface
   and the array branch. Both string branches now pass through `sanitizeForLogOutput`. Added a
   regression test (embedded `postgres://…` secret redacted in the string message/error).

4. **🟡 `idempotency.ts` / `audit-log.ts` — the thrown-error `error.code` was persisted raw and
   un-capped (asymmetric with the already-fixed soft-failure branch).** Round 32 #4 / round 43 #4
   fixed only the soft-failure `error.code` (`capString(sanitizeForLogOutput(...))`). The idempotency
   hard-throw path stored `code: getErrorCode(error)` verbatim and the audit-log thrown-error path
   stored `code: getErrorCode(error)` raw. `getErrorCode` is a free-form (non-allowlisted) string, so
   a thrown custom error with a long/secret `.code` persisted verbatim into the durable 24h-TTL
   `idempotency_record.error.code` / `ai_action_log.toolOutput.error.code`. Both now apply
   `capString(sanitizeForLogOutput(...), MAX_SOFT_FAILURE_MESSAGE_SIZE)`. Added a regression test
   (oversized hard-throw code capped + truncated).

5. **🟡 `cleanup-expired-idempotency.ts` — the cleanup silently rolled back on real datasets.** The
   whole scan + batched-delete runs in one interactive `$transaction` whose default Prisma timeout is
   5s; any non-trivial cleanup (a few thousand expired rows, or a transaction holding the advisory
   lock past 5s) timed out, rolled back (deleting nothing), and exited non-zero having cleaned 0 rows
   — defeating its only purpose while the table grew unbounded. Pass an explicit `timeout` (default
   600s, tunable via `CLEANUP_TX_TIMEOUT_MS`).

6. **🟢 `prisma.service.ts` — the RLS boot check could pass vacuously for newly-added tenant
   tables.** `verifyRlsEnabled` treats the hard-coded `tenantTables` list as authoritative; a new
   tenant table added to `schema.prisma` + `rls-setup.sql` but omitted from the list is simply never
   inspected, so the check passes and that table's tenant isolation goes unverified. The query now
   also fails closed if the DB reports MORE force-RLS tables than the enumeration covers (with a clear
   message). Global tables never have FORCE RLS applied, so no false-positive.

### Reviewed but NOT changed (false positives / out of scope)

- **`redactSensitiveFieldValues` over-redaction of benign `error.code`** — because `code` is now a
  sensitive field name (round 43 single source of truth), the audit-log `toolOutput.error.code`
  (e.g. `P2002`) is redacted to `[REDACTED]` on every surface. This is consistent with the established
  policy (over-redaction of `code`/`session` was an accepted trade-off in round 43) and matches the
  REST surface; intentional, not a regression.
- **`crypto.ts` aggregate byte budget under-counts key names** — already documented (round 40
  deferred); bounded by `MAX_HASH_KEYS` (10k), no DoS path.
- **`sanitize.ts` generic-URL catch-all (no userinfo)** — a non-credential URL with a secret in the
  *path* is not redacted by the catch-all; query-string secrets are now covered (round 43). Known
  limitation, out of scope.
- **`ai_action_log.tenant_id` nullable** — flagged LOW in rounds 38–43; a NULL tenant_id row is
  invisible to all tenants under RLS (no leak). Changing a shipped migration carries risk; deferred.
- **`migrations/20260619000000…` non-concurrent `CREATE INDEX`** — flagged LOW in round 38; `IF NOT
  EXISTS` present, comment documents manual `CONCURRENTLY`. Deferred.

## Test Results
```
shared:    164 passed (4 files)   (+10 — round 44 Map/Set + depth + regression tests)
mcp-tools: 132 passed (4 files)   (+2 — round 44 shared-detector + hard-throw-code regressions)
database:   25 passed, 10 skipped (2 files)
api:       313 passed (14 files)  (+1 — round 44 REST string-message/error regression)
───────────────────────────────────
Total:     634 passed, 10 skipped
```

## Findings & Actions (round 42)

### Fixed this round

1. **🟡 `tool-registry.ts` — Zod validation `issues` were returned to the AI agent
   without sensitive-field redaction or log-output sanitization (asymmetric leak
   vector).** The failed-validation `INVALID_INPUT` path built
   `context: { issues: parsed.error.issues.slice(0, MAX_VALIDATION_ISSUES) }` and
   returned it verbatim to the agent. Unlike every other agent-facing error surface
   (the live `ToolResult` via `redactSensitiveFields`, `DomainError.context` via
   `sanitizeContextValue`, and the audit/idempotency durable sinks), this path was
   **not** filtered: a schema whose issue `message` echoes the received input (a
   common custom-errorMap pattern) would surface that value to the agent, and a
   value carried under a sensitive-named path (`password`, `apiKey`, `token`, …)
   bypassed the key-based redaction applied to live results. Also, any URL/connection
   string embedded in an issue message reached the agent unsanitized. Added
   `sanitizeIssues`, which strips URLs/paths/ANSI from every issue `message`/`path`
   (`sanitizeForLogOutput`) and redacts a `received` value when its path ends in a
   sensitive-named key (`isSensitiveField`) — matching `redactSensitiveFields` /
   `sanitizeContextValue`. The already-capped joined `message` summary is likewise
   sanitized at the call site. Added two regression tests (URL redaction in issue
   message; secret `received` value redacted under a sensitive-named path).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-setup.sql` `set_tenant_context`** — dynamic SQL via `format(..., %L)` quotes
  the tenant id, and `validateTenantIdEnhanced` validates `/^[a-zA-Z0-9_-]+$/`
  at three boundaries, so no SQLi/injection path; SECURITY INVOKER + `search_path`
  pin are present. Defense-in-depth only — no change.
- **`migrations/20260619000000…` non-concurrent `CREATE INDEX`** — flagged LOW in
  round 38, explicitly deferred (changing shipped migrations is risky; the
  migration comment documents manual `CONCURRENTLY` application). No change.
- **`health.controller.ts` `/version` fingerprinting** — flagged LOW in round 38,
  accepted as an operator liveness/version probe (`@Public()`). No change.
- **`discovery-tools.ts`, `queue.module.ts`, `seed.ts`, `cleanup-expired-idempotency.ts`,
  `party-tools.ts`, `party.dto.ts`, `jwt.strategy.ts`, `tenant.ts`, `main.ts`** —
  re-verified clean this round (independent sub-review confirmed no new 🔴/🟡
  exploit paths; all agent-facing surfaces apply consistent redaction/sanitization,
  tenant isolation is enforced at the RLS + app-layer).

## Test Results
```
shared:    153 passed (4 files)   (+0 vs round 41)
mcp-tools: 131 passed (4 files)   (+2 — round 42 issue-sanitization regression tests)
database:   25 passed, 10 skipped (2 files)
api:       309 passed (14 files)
───────────────────────────────────
Total:     618 passed, 10 skipped
```

## Findings & Actions (round 41)

### Fixed this round

1. **🟡 `mcp.module.ts` — idempotency-key charset guard was inconsistent across
   the three boundaries that handle the key (deferred-class / consistency gap).**
   `SAFE_IDEMPOTENCY_KEY` (printable-ASCII only; rejects control chars and
   non-ASCII) was duplicated in `idempotency.ts` and `tool-registry.ts` but the
   MCP auth boundary `McpModule.buildContext` never applied it. A key carrying a
   newline or non-ASCII byte therefore passed `buildContext` and was then
   silently treated as a no-op by the idempotency middleware (which skips
   idempotency on an unsafe key with no error) — replay/dedup protection was
   silently disabled and the caller bug stayed invisible. Promoted the regex to
   `@besterp/shared` (`constants.ts`) as the single source of truth, imported it
   in `idempotency.ts` / `tool-registry.ts`, and added the check to `buildContext`
   so an unsafe key now throws a structured `InvalidTypeValueError` (422) at the
   entry point — matching how every other malformed boundary input is rejected.
   Added a regression test (control-char + non-ASCII keys rejected).

### Reviewed but NOT changed (false positives / out of scope)

- **`rls-extension.ts` shared-pool context reset** — flagged in rounds 38/39; the
  design relies on `SET LOCAL app.current_tenant` within a dedicated-connection
  transaction, plus the fail-closed `verifyRlsEnabled` / `verifyAppClientRole`
  boot assertions. No live exploit path; deferred.
- **`ai_action_log.tenant_id` nullable** — flagged LOW in rounds 39/40; a NULL
  tenant_id row is invisible to all tenants under RLS (no leak). Changing a
  shipped migration carries risk; deferred.
- **`spike-rls.ts` Test 3** — spike-only (excluded from build); deferred.
- **`party.service.ts` `searchParties` type-table joins, CORS, RLS-cache closure
  capture, discovery-tools type-table allowlist, queue module, JWT strategy** —
  re-verified clean this round; no new issues.

## Test Results
```
shared:    153 passed (4 files)   (+0 vs round 40)
mcp-tools: 129 passed (4 files)   (+0 vs round 40)
database:   25 passed, 10 skipped (2 files)
api:       309 passed (14 files)  (+1 — round 41 idempotency-key boundary test)
───────────────────────────────────
Total:     616 passed, 10 skipped
```

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
