# BestERP — Security & Architecture Fixes

## Changes Applied (2026-07-17) — Code Review Round 44

### 🔴 `sanitize.ts` / `sensitive-fields.ts` — MCP surface used a divergent sensitive-field detector (asymmetric secret leak)

**Problem:** Round 43 promoted `isSensitiveFieldName` to `@besterp/shared` as the single source of truth and added `code`, `session`, `signature`, `sign` to it — but the three MCP middlewares (`audit-log`, `error-handler`, `tool-registry`) kept using a *local* `isSensitiveField` that omitted those four names. A value under a key literally named `code` (MFA/verification code), `session` (session token), `signature`, or `sign` (signing secret) was redacted on the REST surface but **leaked** on the agent-first MCP surface — via the live tool result, `ai_action_log.tool_input`/`toolOutput`, the idempotency persist + replay paths, and validation `issues.received`. The exact asymmetric-leak pattern the codebase's review process targets.

**Fix:** Made `packages/mcp-tools/src/middleware/sensitive-fields.ts` delegate `isSensitiveField` to the shared `isSensitiveFieldName` (and `splitFieldTokens` to the shared tokeniser) so the MCP/durable surfaces and the REST `DomainExceptionFilter` share one definition of "sensitive" permanently. Removed the duplicated local constant set/regex/tokens.

### 🔴 `sanitize.ts` — shared `redactSensitiveFieldValues` dropped Map/Set and had no recursion depth cap

**Problem:** The canonical redactor promoted in round 43 (used by the REST filter's dev `context` reflection) only handled plain objects/arrays. A `Map`/`Set` fell through to `Object.entries(...)` → `[]`, silently serialising to `{}` (data loss), and unlike the MCP `redactSensitiveFields` it **never redacted sensitive-named Map/Set keys** — so `new Map([["password","hunter2"]])` reflected as `{}` on REST while the MCP surface redacted it. It also had no depth guard, so an attacker-influenced deeply nested `DomainError.context` could blow the stack on the REST dev path (DoS). The two sibling redactors (`redactSensitiveFields`, `sanitizeContextValue`) are depth-bounded.

**Fix:** Rewrote `redactSensitiveFieldValues` as the complete canonical redactor: depth-guarded (returns `"[Too deep]"` past `MAX_REDACTION_DEPTH`), Map/Set-aware (converted to JSON-safe `[k,v]`/array form, with sensitive-named keys redacted to `"[REDACTED]"`), cycle-guarded via `WeakSet`. Split container handling into `redactArray`/`redactMap`/`redactSet`/`redactPlainObject` helpers to stay under the lint complexity cap. Added regression tests (Map key redaction, Map/Set preservation, depth guard).

### 🔴 `domain-exception.filter.ts` — REST `HttpException` string `message`/`error` not secret-scrubbed

**Problem:** Round 43 sanitized the *array* validation-message branch and `DomainError` messages, but the `typeof res.message === "string"` branch copied the message verbatim and `res.error` was copied verbatim in production. A custom/upstream `HttpException` carrying a connection string or `Bearer` token in its string `message`/`error` reached REST clients in production unredacted — while the same value was scrubbed on the MCP surface and the array branch. Asymmetric leak on the production REST path.

**Fix:** Both the string `message` and `error` branches now pass through `sanitizeForLogOutput` before being returned (matching the array branch and `DomainError` path). Added a regression test asserting a `postgres://…` secret in the string message/error is redacted in production.

### 🟡 `idempotency.ts` / `audit-log.ts` — thrown-error `error.code` persisted raw/un-capped (asymmetric with soft-fail)

**Problem:** Round 32 #4 / round 43 #4 fixed only the *soft-failure* `error.code` to `capString(sanitizeForLogOutput(...))`. The idempotency **hard-throw** path (`executeAndUpdate`) stored `code: getErrorCode(error)` with no cap and no sanitization, and the audit-log **thrown-error** path stored `code: getErrorCode(error)` raw. `getErrorCode` returns a free-form (non-allowlisted) string, so a thrown custom error with a long/secret `.code` persisted verbatim into the durable 24h-TTL `idempotency_record.error.code` / `ai_action_log.toolOutput.error.code`. Asymmetric vs the already-fixed sibling path.

**Fix:** The idempotency hard-throw `error.code` and the audit-log thrown-error `code` now both apply `capString(sanitizeForLogOutput(...), MAX_SOFT_FAILURE_MESSAGE_SIZE)`. Added a regression test (oversized hard-throw code capped + truncated).

### 🟡 `cleanup-expired-idempotency.ts` — cleanup silently rolled back on real datasets (transaction timeout)

**Problem:** The whole scan + batched-delete runs inside one interactive `$transaction`. Prisma's default interactive-transaction `timeout` is 5s, so any non-trivial cleanup (a few thousand expired rows, or a single transaction holding the advisory lock past 5s) times out, the transaction **rolls back** (deleting nothing), and the script exits non-zero having cleaned 0 rows — silently defeating its only purpose while the table grows unbounded.

**Fix:** Pass an explicit `timeout` (default 600s, tunable via `CLEANUP_TX_TIMEOUT_MS`) to the interactive transaction so the cleanup completes instead of rolling back.

### 🟢 `prisma.service.ts` — RLS boot check could pass vacuously for newly-added tenant tables

**Problem:** `verifyRlsEnabled` treats the hard-coded `tenantTables` list as authoritative. If a new tenant table is added to `schema.prisma` + `rls-setup.sql` (so it gets RLS+FORCE at the DB) but the developer forgets to add it to `tenantTables`, the `= ANY(list)` query simply never inspects that table — the check passes and the new table's tenant isolation goes unverified.

**Fix:** The query now also fails closed if the DB reports MORE force-RLS tables than the enumeration covers (a forgotten-list-entry signal), with a clear message naming the discrepancy. Global (non-tenant) tables never have FORCE RLS applied, so this cannot false-positive.

## Changes Applied (2026-07-17) — Code Review Round 43

### 🔴 `domain-exception.filter.ts` — REST DomainError message not secret-redacted (asymmetric with MCP)

**Problem:** The non-500 production path reflected `message: stripHtmlTags(sanitizeLogMessage(exception.message))`. `sanitizeLogMessage` only strips control chars/ANSI, so a connection string, `Bearer` token, or `?token=…` secret embedded in a DomainError message (which routinely echoes user-supplied input) reached REST clients verbatim — while the same message was scrubbed to `[DATABASE_URL]`/`[REDACTED]` for AI agents via the MCP `error-handler`. Inconsistent agent-facing redaction across the two surfaces.

**Fix:** Changed the message to `stripHtmlTags(sanitizeForLogOutput(exception.message))`, matching the file's `handleUnexpectedError` path and the MCP middleware. Added a regression test.

### 🟡 `domain-exception.filter.ts` — dev `context` not field-name redacted

**Problem:** `sanitizeContext` only ran `sanitizeForLogOutput` per string leaf; a `DomainError` with `context: { apiKey: "…" }` reflected verbatim to REST dev clients while MCP agents saw `"[REDACTED]"`.

**Fix:** Promoted the field-name redactor to `@besterp/shared` as `isSensitiveFieldName` + `redactSensitiveFieldValues` (single source of truth) and changed `sanitizeContext` to redact the whole tree at once so the key is visible. Added a regression test.

### 🟡 `domain-exception.filter.ts` — `HttpException` validation-array messages not secret-scrubbed

**Fix:** Each cleaned validation message now passes through `sanitizeForLogOutput` before being returned. Added a regression test (embedded bearer token redacted).

### 🔴 `idempotency.ts` — soft-failure `error.message` persisted to durable store without redaction

**Problem:** The thrown-error branch scrubs the message via `sanitizeForLogOutput`; the `success:false` (non-thrown) branch only `capString`'d it — so a tool returning a non-thrown failure whose message embeds a connection string persisted that secret verbatim into the 24h-TTL durable `idempotency_record`, which the thrown path redacted. Asymmetric durable-sink leak.

**Fix:** Wrapped the soft-failure `message` in `sanitizeForLogOutput` (matching the already-scrubbed `code`). Added a regression test.

### 🟡 `sanitize.ts` — broadened query-string secret param names

**Fix:** Added `pwd`, `passwd`, `signature`, `sign`, `otp`, `code`, `session`, `client_id`, `bearer` to the query-string secret redactor so secrets in those params are redacted across every `sanitizeLogOutput` consumer. Added regression tests.

## Changes Applied (2026-07-17) — Code Review Round 42

### 🟡 `tool-registry.ts` — validation `issues` returned to agent without redaction/sanitization

**Problem:** The failed-validation `INVALID_INPUT` path returned Zod `issues` verbatim to the AI agent in `context.issues`. Unlike every other agent-facing surface — the live `ToolResult` (`redactSensitiveFields`), `DomainError.context` (`sanitizeContextValue`), and the audit/idempotency durable sinks — this path applied neither sensitive-field redaction nor log-output sanitization. A schema whose issue `message` echoes the received input (a common custom-errorMap pattern) would surface that value to the agent, and a `received` value carried under a sensitive-named path (`password`, `apiKey`, `token`, …) bypassed the key-based redaction applied to live results. URLs/connection strings embedded in issue messages also reached the agent unsanitized.

**Fix:** Added `sanitizeIssues`, which strips URLs/paths/ANSI from every issue `message`/`path` via `sanitizeForLogOutput` and redacts a `received` value when its path ends in a sensitive-named key (`isSensitiveField`) — matching `redactSensitiveFields` / `sanitizeContextValue`. The capped joined `message` summary is sanitized at the call site. Added two regression tests (URL redaction in issue message; secret `received` value redacted under a sensitive-named path).

## Changes Applied (2026-07-17) — Code Review Round 41

### 🟡 `mcp.module.ts` / `constants.ts` — idempotency-key charset guard inconsistent across boundaries

**Problem:** The printable-ASCII rule for idempotency keys (`SAFE_IDEMPOTENCY_KEY`, rejecting control chars and non-ASCII) was duplicated in `idempotency.ts` and `tool-registry.ts` but absent from the MCP auth boundary `McpModule.buildContext`. A key with a newline or non-ASCII byte passed `buildContext` cleanly, then was silently treated as a no-op by the idempotency middleware (which skips idempotency on an unsafe key) — no error, dedup silently disabled. That asymmetry masked caller bugs and could let a malformed key silently defeat replay protection.

**Fix:** Promoted `SAFE_IDEMPOTENCY_KEY` to `@besterp/shared` (`constants.ts`) as the single source of truth, imported it in `idempotency.ts` and `tool-registry.ts`, and added the check to `buildContext` so an unsafe key now throws a structured `InvalidTypeValueError` (422) at the entry point — consistent with how the other malformed-boundary inputs are rejected. Added a regression test asserting control-char and non-ASCII keys are rejected.

## Changes Applied (2026-07-17) — Code Review Round 40

### 🟢 `crypto.ts` — aggregate byte budget under-counted key names

**Problem:** `checkStringBounds` charged only string *values* to `MAX_HASH_TOTAL_BYTES`, so the JSON-serialized form of object/Map *keys* escaped the guard. A wide object/Map of long keys (e.g. 12k keys × ~200 bytes) adds ~2.4 MB of key bytes on top of the value budget, exceeding the 2 MB cap without tripping the DoS guard.

**Fix:** Added `chargeKeyBytes` (key + 2 quote bytes) and call it from `sortPlainObject` (object keys) and `sortMap` (Map keys). Both now throw the aggregate size-limit `InvalidTypeValueError`. Added regression tests for wide object keys and wide Map keys.

### 🟢 `truncate.ts` — nested Map/Set dropped from persisted payload

**Problem:** `serializeObjectValue` converted only a *top-level* Map/Set to arrays; a Map/Set nested inside an array/object was silently turned into `{}`/`[]` by `JSON.stringify`, losing data from the audit/idempotency record (data-loss, not a leak).

**Fix:** Added `normaliseForTruncation`, which recursively converts nested Map/Set (and arrays/plain objects) to JSON-safe arrays, with a `WeakSet` cycle guard and a pass-through for special objects (Date/Error/RegExp/class instances) so their `toJSON`/built-in serialization is preserved. Added regression tests for nested Map-in-array, nested Set-in-object, and circular-nested detection.

## Changes Applied (2026-07-16) — Code Review Round 37

### 🔴 `sanitize.ts` — `stripHtmlTags` DoS guard measured code units, not bytes

**Problem:** The 100k length guard compared `input.length` (UTF-16 code units). A string of 99k multi-byte characters is ~400 KB in UTF-8 but stayed under the cap, then entered the entity-decode/strip loop and could balloon past the intended budget.

**Fix:** Guard now measures `Buffer.byteLength(input, "utf8")`. Added regression test for oversized multi-byte input.

### 🟡 `sanitize.ts` — bare bearer/JWT secrets leaked; `at /path` rule false-redacted prose

**Problem:** `Authorization: Bearer sk_live_…` and bare JWTs reached operator logs unredacted. The `at /path` rule collapsed ordinary prose ("meet me at /home/user later") into "meet me [PATH] later", destroying legitimate log context.

**Fix:** Added `Bearer …` and JWT redaction. Rewrote the path rule to redact only absolute, file-like paths (extension or `:line` suffix), leaving plain prose intact. Added regression tests.

### 🟢 `validation.ts` — `EMAIL_REGEX` accepted invalid local parts

**Problem:** Consecutive/leading/trailing dots (`a..b@x.com`, `.a@x.com`) were accepted.

**Fix:** Added look-ahead/look-behind guards rejecting `.` at the start, end, or consecutively in the local part.

### 🟡 `error-handler.ts` — MCP `DomainError.message` not sanitized for the agent

**Problem:** `handleDomainError` returned the raw message (which embeds user input) to the AI agent, unlike every other agent-facing / durable error surface that runs `sanitizeForLogOutput`.

**Fix:** Apply `sanitizeForLogOutput` to the message before returning it.

### 🟡 `tool-registry.ts` — unbounded `context.issues` returned to the agent

**Problem:** A crafted large invalid array produced an arbitrarily large Zod issues array in the tool result (memory amplification / DoS).

**Fix:** Cap `context.issues` at `MAX_VALIDATION_ISSUES = 50`; the already-capped message string preserves a readable summary.

### 🟡 `domain-exception.filter.ts` — reflected message not HTML-stripped; hardening gated on exact `production`

**Problem:** `DomainError.message` (user input) was only control-char sanitized, so `<script>` reflected intact into the JSON response. HTTP-exception detail stripping only ran under `NODE_ENV === "production"`, so staging/preview deployments leaked raw validation bodies.

**Fix:** `handleDomainError` now also runs `stripHtmlTags`. `handleHttpException` inverts the gate to strict-unless-`development` so hardening is the default.

### 🔴 `prisma.service.ts` — superuser check by name; no boot-time RLS assertion

**Problem:** `verifyAppClientRole` only matched role names `besterp`/`postgres`, missing any role granted `SUPERUSER`. RLS enable + policies live in the standalone `rls-setup.sql` (not run by `prisma migrate deploy`), so a forgotten apply silently disabled tenant isolation.

**Fix:** Detect superuser via `pg_roles.rolsuper`/`rolcatupdate`. Added `verifyRlsEnabled()` that refuses to boot if RLS is not enabled on the core tenant tables.

### 🟢 `migrations/…/migration.sql` — non-idempotent `CREATE INDEX`

**Problem:** A manual re-run during production recovery aborted on "relation already exists".

**Fix:** Added `IF NOT EXISTS`.

## Changes Applied (2026-07-16) — Code Review Round 35

### 🔴 `idempotency.ts` / `truncate.ts` — `_truncated` marker collided with real user data

**Problem:** The idempotency replay path detected truncation via a bare `"_truncated" in data` check. A tool whose result genuinely contains a top-level `_truncated` field would be falsely reported to the agent as "was truncated for storage", and such a field could be misread on replay.

**Fix:** `truncateValue` now emits a high-entropy private discriminator (`__besterp_trunc`) alongside the `_truncated` flag. `handleExistingRecord` detects truncation via the exported `isTruncationMarker` helper, which requires the discriminator — a real user field named `_truncated` can no longer trigger the false note. Added regression tests.

### 🔴 `sanitize.ts` — secrets in HTTP URL query strings were not redacted

**Problem:** The generic `https?://…` rule reduced a URL to `[HOST]/[PATH]` but preserved the full query string, so `https://api.example.com/v1/charge?api_key=sk_live_abc123&token=xyz` leaked both secrets to operator logs.

**Fix:** A new regex redacts common secret-bearing query parameters (`key`, `token`, `secret`, `password`, `access_token`, `auth`, `api_key`, `apikey`, `client_secret`) to `[REDACTED]` after the `[HOST]/[PATH]` reduction. Added regression test.

### 🟡 `validation.ts` — ISO date regex accepted invalid timezone offsets

**Problem:** The offset minute group was unconstrained for extreme hours, so `+14:30`, `+14:59`, `-12:30`, and `-13:00` were accepted even though they fall outside the valid -12:00..+14:00 window.

**Fix:** The regex now restricts `+14` to `:00` only and `-12` to `:00` only. Added regression test.

### 🟡 `errors.ts` — `DomainError.toJSON` serialized non-Error `cause` via `String(cause)`

**Problem:** A non-`Error` cause (e.g. an attached object) would have its data stringified into audit logs / idempotency records; a custom class `toString()` can embed sensitive field data.

**Fix:** Non-Error causes now serialize to the safe placeholder `[Non-error cause]`. Updated the regression test.

### 🟡 `idempotency.ts` — idempotency key leaked 32 plaintext chars to agent-facing errors

**Problem:** `redactKey` embedded `key.slice(0, 32)` verbatim in agent-facing error messages. If a key ever carried a secret, up to 32 chars reached the AI agent.

**Fix:** Keys are now hashed with SHA-256 and only a 12-char opaque prefix (`id-…`) is shown. Updated the regression test that asserted the raw key appeared in stderr.

### 🟢 `sensitive-fields.test.ts` — pre-existing broken test file

**Problem:** The `redactSensitiveFields` describe block used a top-level `await import(...)` outside an async function, so the entire file failed to transform and 0 tests ran.

**Fix:** Replaced the dynamic import with a static top-level import. The file now executes.

## Changes Applied (2026-07-16) — Code Review Round 34

### 🔴 `crypto.ts` — `Error.cause` hashed shallow / circular `cause` not detected

**Problem:** `serializeSpecialObject` flattened `Error.cause` to a single level (`{name, message}`), so a nested `cause.cause` was dropped — two inputs differing only in `cause` depth hashed **identically**, collapsing distinct idempotency inputs. It also never added the `Error` to the `ancestors` set, so a circular `cause` chain did **not** throw like every other circular type (silent hash instead of an error).

**Fix:** `cause` is now recursively serialized via `sortKeysDeep(value.cause, ancestors, depth + 1)`, inheriting the same circular-reference + depth guards and full depth fidelity. Added regression tests (distinct hashes for differing cause depth; throws on circular cause).

### 🔴 `idempotency.ts` — success/failure `result` persisted & replayed **without** sensitive-field redaction

**Problem:** `updateIdempotencyRecordWithRetry` stored `toolResult.data` after `truncateValue` only — no `redactSensitiveFields`. A tool returning a value under a sensitive-named key (e.g. a "create credential" tool) would persist it **unredacted** in `idempotency_record.result` and replay it to the agent verbatim. The parallel audit log (`audit-log.ts`) redacts, so this was an asymmetric secret-leak path between the two durable sinks.

**Fix:** `redactSensitiveFields` is now applied before `truncateValue` in the persist path, and re-applied on the replay path (`handleExistingRecord`) for defense-in-depth against pre-fix rows. `redactSensitiveFields` was exported from `audit-log.ts` and reused so both sinks share one implementation. Added regression tests.

### 🟡 `truncate.ts` — `JSON.parse` could throw, violating the "never throws" contract

**Problem:** `truncateValue` round-tripped `JSON.parse(result.serialized)` with no try/catch. A value `JSON.stringify` emits but cannot re-parse (e.g. a custom `toJSON` emitting a lone UTF-16 surrogate) would throw and crash a fire-and-forget audit/idempotency write.

**Fix:** Added a local `safeParse` that returns the string form on parse failure, so `truncateValue` keeps its "never throws" guarantee. Added a regression test.

### 🟡 `error-handler.ts` — Prisma `meta.target` echoed to the agent unsanitized

**Problem:** The `P2002` handler interpolated `meta.target` (a field/column name, user-influenced under compound constraints) verbatim into the `DUPLICATE_ENTITY` message and `context.conflictingFields` returned to the agent — inconsistent with every other externally-derived string in the file.

**Fix:** `target` is now run through `sanitizeLogMessage(...)` before interpolation.

### 🟡 `party.service.ts` — party existence checks relied solely on RLS (incomplete round-32 hardening)

**Problem:** Round 32 hardened `getParty` with an explicit `tenantId` filter but left two sibling existence checks (`addPartyRoleTransaction`, `createContactMechanismTransaction`) querying `party.findUnique({ where: { partyId } })` with no `tenantId` — the same RLS-only pattern flagged as risky. A regression in the proxy/`set_tenant_context` path would have allowed operating on another tenant's party.

**Fix:** Added `tenantId` to both `where` clauses, mirroring `getParty`.

### 🟡 `cleanup-expired-idempotency.ts` — advisory lock ineffective across Prisma's connection pool

**Problem:** `pg_try_advisory_lock` is *session*-scoped. Under Prisma's default connection pool the lock acquisition and the subsequent `findMany`/`deleteMany` could execute on different backend connections, so the lock did **not** actually serialize overlapping runs (the stated safety guarantee was void).

**Fix:** The entire cleanup (lock acquire → scan → batched deletes → unlock) now runs inside a single interactive `$transaction`, so every statement shares one backend and the lock is effective. The server still releases the lock on commit/rollback.

### 🟡 `.github/workflows/ci.yml` — round-33 `ALLOW_SEED` guard broke the CI seed step

**Problem:** Round 33 made seeding require `ALLOW_SEED=1`. CI ran `npm run db:seed` with only `DATABASE_URL`/`DATABASE_ADMIN_URL` set (no `ALLOW_SEED`), so the "Seed database" step would throw and fail the pipeline.

**Fix:** Added `ALLOW_SEED: "1"` to the CI seed step (the CI Postgres is ephemeral, so the opt-in is safe).

### 🟢 `rls-setup.sql` — `set_tenant_context` lacked `search_path` pin; no superuser assertion

**Problem:** `set_tenant_context` (SECURITY INVOKER) had no `SET search_path`, the classic function-based wrong-resolution footgun. Nothing asserted `besterp_app` is non-superuser at setup, so a misprovisioned role would silently disable RLS.

**Fix:** Added `SET search_path = pg_catalog, public` to the function and a `DO $$` assertion that raises if `besterp_app` is a superuser.

### 🟢 `health.controller.ts` — unauthenticated `/health` leaked environment/memory/uptime

**Problem:** The `@Public()` `/health` success path returned the full `HealthStatus` including `environment`, `memory`, and `uptime` to anonymous callers — mild infrastructure fingerprinting (the round-33 fix only addressed the error path / debug log).

**Fix:** The anonymous `/health` response now returns only `{ status, timestamp, database }`. Updated `health.controller.spec.ts`.

## Changes Applied (2026-07-16) — Code Review Round 33

### 🟡 `seed.ts` — seed guard bypassable by non-prod `NODE_ENV` pointing at prod DB

**Problem:** The seed refused `production`/`staging` only. An operator whose `DATABASE_ADMIN_URL` points at a production database while leaving `NODE_ENV` unset or set to `development` (a common container-env reuse mistake) would silently insert the hard-coded `tenant-acme` / `tenant-globex` test tenants into prod. The file's own comment acknowledged this exact risk.

**Fix:** Seeding now requires an explicit opt-in (`ALLOW_SEED=1`) in addition to the `NODE_ENV` refusal. There is no safe default that permits the destructive insert without a deliberate signal. Added the guard before any DB write.

### 🟢 `health.controller.ts` — unsanitized `debug` log (log-injection inconsistency)

**Problem:** The readiness race handler interpolated the raw DB error `message` into a `logger.debug` call, inconsistent with the rest of the codebase which wraps infra-derived messages in `sanitizeForLogOutput(...)`.

**Fix:** Wrapped the message in `sanitizeForLogOutput(...)` so a crafted/compromised driver error cannot inject ANSI escapes or CRLF into logs.

### 🟢 `cleanup-expired-idempotency.ts` — destructive prod script lacked opt-in

**Problem:** The cron script runs as superuser (bypasses RLS) and deletes rows. A misconfigured `DATABASE_ADMIN_URL` pointing at prod could wipe expired idempotency records unattended.

**Fix:** Normalized `NODE_ENV` and refuse to run in `production` unless `ALLOW_CLEANUP_PRODUCTION=1` is explicitly set.

### 🟢 `pluralize.ts` — single-letter input force-uppercased (cosmetic casing bug)

**Problem:** `preserveCasing` checked the all-caps branch first, so a single uppercase letter like `"Y"` produced an all-caps plural (`"IES"`) instead of preserving the single leading capital. Cosmetic — affects MCP error messages / suggested tool names only.

**Fix:** Excluded length-1 inputs from the all-caps branch so they fall through to the leading-capital rule. Added a regression test in `pluralize.test.ts`.

### 🟢 `spike-rls.ts` — hardcoded-looking DB credential in a committed spike

**Problem:** The dev spike embedded a real-looking connection string (`besterp_app:besterp_app_dev@localhost:5434`). It is excluded from the published build and only runs via `npm run spike:rls`, but it trips secret scanners.

**Fix:** Replaced with a `<user>:<pass>@<host>:<port>` placeholder.

## Changes Applied (2026-07-16) — Code Review Round 31

### 🟡 `party.service.ts` — duplicate email/phone check not scoped to the party (false negative)

**Problem:** `checkEmailDuplicate` / `checkTelecomDuplicate` ran a tenant-wide `findFirst` and then validated ownership in memory via `contactMechanism.partyContacts.some((pc) => pc.partyId === partyId)`. `findFirst` returns an indeterminate match across all parties in the tenant, so the in-memory `some()` check could run against the *wrong* party's row — e.g. party B's email is returned, the check looks for party A → `false` → a genuine duplicate for party A is allowed. Confirmed by reasoning through the query shape (the `some()` ran on the row `findFirst` happened to pick, not on the requesting party).

**Fix:** Pushed `partyContacts: { some: { partyId } }` into the Prisma `where.contactMechanism` filter so the query itself is scoped to the requesting party; the post-query `some()` re-check was removed (the match is now authoritative). Applied identically to `checkTelecomDuplicate`. Added a regression test asserting `where.contactMechanism.partyContacts.some.partyId` equals the requesting party and that a same-email-on-a-different-party does not throw `DuplicateEntityError`.

### 🟡 `truncate.ts` — `Date` size check double-encoded (inaccurate truncation threshold)

**Problem:** `normalisePrimitive` for `Date` ran `JSON.stringify(iso)` before `TextEncoder.encode`. `JSON.stringify` wraps the string in quotes, inflating the byte count by 2, so the oversize decision was made against a length 2 bytes larger than what is actually stored. Values hovering at the threshold could be misclassified and the `_preview` boundary drifted.

**Fix:** Encode the ISO string directly via `textEncoder.encode(iso)` (strings are JSON-safe; no quoting needed), mirroring the existing `string` fast path. Non-oversize values are unchanged; only the boundary/truncation classification is now accurate.

### 🟢 `crypto.ts` — `ancestors.delete` skipped on early return (ancestor-set leak)

**Problem:** `sortArray`, `sortMap`, `sortSet`, and `sortObject` added the value to the `ancestors` circular-reference `Set` but only deleted it on the final `return`. Any branch that returned early left the value in the set, so a later sibling value that legitimately shared that reference could be misreported as a circular reference (`InvalidTypeValueError`).

**Fix:** Wrapped each in `try { ... } finally { ancestors.delete(value); }` so cleanup runs on every exit path. Behaviour is unchanged for normal inputs; the leak only manifested on graphs where a reference appeared under two different parents.

### 🟢 `prisma.service.ts` — `BYPASSSED` typo broke the RLS-bypass re-throw guard

**Problem:** The superuser-RLS-bypass error message and the `catch` block that re-throws on that exact substring both spelled `BYPASSED` as `BYPASSSED`. The mismatch meant the `catch` guard (`message.includes("RLS will be BYPASSED")`) never matched, so a genuine bypass condition fell through to a generic `warn` instead of being surfaced as an error in production.

**Fix:** Corrected the spelling in both the message constant and the `.includes()` guard so the re-throw path is live again.

### 🟢 `health.module.ts` — removed unused `HealthService` export

**Problem:** `HealthModule` re-exported `HealthService`, but no other module imports it — the controller injects it locally within the module. The `exports` entry was dead code that implied a shared provider boundary that didn't exist.

**Fix:** Removed `exports: [HealthService]` from `HealthModule`. No call sites affected.

---

## Changes Applied (2026-07-15) — Code Review Round 28

### 🔴 `main.ts` — catch-all Express error handler leaks `err.message` in development

**Problem:** The catch-all Express error handler (safety net for errors escaping NestJS exception filters) returned `sanitizeForLogOutput(err.message)` to the client in development mode. While `sanitizeForLogOutput` strips connection strings, paths, and control characters, it was designed for log output, not client responses. Internal error messages from body-parser, middleware, or unhandled throws can contain stack traces, internal hostnames, or implementation details that shouldn't reach the client even in dev.

**Fix:** Always returns a generic `"Internal server error"` message to the client in all environments. The full sanitized error is still logged server-side via `logger.error()` for debugging. This is the same pattern used by the `DomainExceptionFilter` for 500 errors in production.

### 🟡 `domain-exception.filter.ts` — production validation message stripping too aggressive

**Problem:** In production, validation error arrays from `ValidationPipe` had every message stripped to just the field name via `.replace(/ .*$/, "")`. A message like `"name must be shorter than or equal to 500 characters"` became just `"name"` — the client knew which field failed but not why. This hurt API usability with no meaningful security gain, since NestJS validation messages don't contain user-supplied values.

**Fix:** Replaced with targeted regex that only strips user-supplied values: `"received: ..."` suffixes, trailing quoted values, and trailing punctuation. Constraint descriptions (field name + rule) are preserved. Messages with no user values pass through unchanged.

### 🟡 `crypto.ts` — `hashInput` has no input size limit (DoS risk)

**Problem:** `hashInput` had `MAX_HASH_DEPTH` (100) to prevent deep nesting, but no limit on the total number of keys. A flat object with millions of keys would cause `JSON.stringify` to allocate a massive string and the SHA-256 computation to block the event loop.

**Fix:** Added `MAX_HASH_KEYS` (10,000) limit with a recursive `countKeys()` helper. Inputs exceeding the key count are rejected with a clear `InvalidTypeValueError` before serialization.

### 🟢 `tenant.ts` — DRY `setTenantContext` extracted from 3 call sites

**Problem:** The `set_tenant_context()` parameterized call with its DomainError-preserving error handling was copy-pasted in three places: `withTenant()`, `createTransactionWrapper()`, and `createModelDelegateProxy()`. The `tenant.ts` version preserved `DomainError` codes, but the two `rls-extension.ts` versions always wrapped as `TenantContextFailedError`, losing the original error code.

**Fix:** Extracted `setTenantContext(tx, tenantId)` in `tenant.ts` as a shared helper. All three call sites now use it, ensuring consistent DomainError preservation. Exported from `@besterp/shared`.

### 🟢 `tenant.ts` — `withTenant` now supports `isolationLevel` option

**Problem:** `withTenant()` only accepted `{ timeout }` in its options, but `$transaction` also supports `isolationLevel`. The idempotency middleware needed `Serializable` isolation and was forced to call `prisma.$transaction` directly, bypassing the shared utility.

**Fix:** Added `isolationLevel?: Prisma.TransactionIsolationLevel` to the options type.

### 🟢 `errors.ts` — `DomainError.toJSON` allocates an IIFE per call

**Problem:** The `cause` serialization in `toJSON()` used an inline arrow function `(() => { ... })()`, allocating a new function scope on every call. In hot paths with many error serializations, this creates unnecessary GC pressure.

**Fix:** Extracted `serializeCause()` as a named module-level function.

### 🟢 `mcp.module.ts` — pre-trim empty check order was misleading

**Problem:** `validateOptionalField` checked `value.length === 0` before calling `value.trim()`. This only caught truly empty strings, not whitespace-only strings, making the code misleading — the whitespace-only case was actually caught by the subsequent `trimmed.length === 0` check.

**Fix:** Moved the empty-string normalization to after `trim()`, distinguishing truly empty strings (return `undefined`) from whitespace-only strings (throw `InvalidTypeValueError`) in a single branch.

### 🟢 `audit-log.ts` — BackpressureManager exposes `getStats()` for observability

**Problem:** `activeWrites`, `writeQueue.length`, `droppedCount`, and `errorCount` were closure-local with no getter. Operators couldn't monitor backpressure health.

**Fix:** Added `getStats()` method to the `BackpressureManager` interface returning `{ activeWrites, queueLength, droppedCount, errorCount }`.

---

## Changes Applied (2026-07-14) — Code Review Round 27

### 🟡 `domain-exception.filter.ts` — `DomainError.message` reflected into HTTP responses unsanitized

**Problem:** Round 26 closed the log/response-injection surface on `DomainError.context` values but missed the `message` field. DomainError messages routinely embed user-supplied input that is only `.trim()`'d upstream — e.g. `Invalid fromDate format: ${trimmed}` (party.service.ts `parseFromDate`), `${field} is not a valid ISO 8601 date. Received: ${value}` (`requireValidDate`), `Invalid tenant ID: "${preview}"` (shared `validateTenantId`). `.trim()` only strips leading/trailing whitespace, so interior control characters (newlines, tabs, ANSI escapes) survive into the message.

The filter sent `exception.message` verbatim into the response body for every non-500 DomainError — in **both development and production** (unlike context, which is dev-only). A user-controlled value like `fromDate: "x\n[INFO] admin logged in"` was reflected into the HTTP response body and, when that body was logged by a monitoring tool or API client, would inject a forged log line. Confirmed by a failing assertion: a 422 `InvalidTypeValueError` with the payload `Invalid fromDate format: line1\nline2\t\x1b[31mFAKE\x1b[0m` previously returned the raw string in `body.message`.

**Fix:** Applied `sanitizeLogMessage()` to `exception.message` when building the response body, mirroring the round-26 context treatment (same sanitizer, same control-character/newline/ANSI stripping). The generic 500-in-production message is unaffected. `sanitizeLogMessage` is already imported (used by `sanitizeContext`). Added a regression test asserting the reflected message has newlines/tabs → `_` and ANSI CSI escapes stripped, in production mode.

### 🟢 `domain-exception.filter.ts` — `sanitizeContext` did not recurse into nested objects

**Problem:** The `ContextValue` type permits arbitrarily nested objects and arrays (`string | number | boolean | null | ContextValue[] | { [key: string]: ContextValue }`), but `sanitizeContext` only scrubbed top-level strings and the string elements of top-level arrays — a value under a nested key (e.g. `context.input.field`) passed through verbatim. No current DomainError call site nests objects in context (all are flat — verified by grepping every `context: {` in the codebase), so this was latent rather than exploitable today, but it was an incomplete implementation of the round-26 goal of sanitizing context values.

**Fix:** Extracted a recursive `sanitizeContextValue()` helper that walks the full value tree — strings are `sanitizeLogMessage`'d at every depth; arrays and plain objects are recursed; primitives (number, boolean, null) pass through unchanged. `sanitizeContext` now delegates to it. Added a regression test asserting a nested `context.nested.malicious` string and `context.list[]` elements are sanitized while `context.count` (number) is preserved.

---

## Changes Applied (2026-07-14) — Code Review Round 26

### 🔴 `rls-extension.ts` — silent `undefined` return for non-existent model delegates

**Problem:** When accessing a model that doesn't exist in the Prisma schema (e.g., `scoped.nonExistentModel`), the tenant-scoped Proxy's `get` trap fell through to `const delegate = (target as any)[prop]; if (!delegate || typeof delegate !== "object") return delegate;`, returning `undefined`. The caller would then hit a confusing `TypeError: Cannot read properties of undefined (reading 'findMany')` deep in the call stack, with no indication of which model name was wrong.

**Fix:** Changed the fallthrough to throw a clear `Error` naming the missing model and suggesting `schema.prisma` as the fix target: `Model '${prop}' does not exist on the Prisma schema. Check the model name and ensure it is included in schema.prisma.` Non-function, non-object delegates (the only realistic case is `undefined` for a non-existent model) now fail fast with an actionable message.

### 🟡 `party.service.ts` — missing explicit `throw` after `handleTransactionError` in catch blocks

**Problem:** `handleTransactionError` is typed `never` (always throws), but the catch blocks in `createPartyTransaction`, `searchParties`, `addPartyRoleTransaction`, and `createContactMechanismTransaction` relied solely on the `never` return type for TypeScript flow analysis. If `handleTransactionError` were ever refactored to not always throw (e.g., for a soft-error logging path), the functions would silently return `undefined`, causing downstream `TypeError: Cannot read properties of undefined` errors.

**Fix:** Added explicit `throw err; // Unreachable — handleTransactionError always throws. Defense-in-depth for future refactors.` after each `handleTransactionError` call in the four catch blocks.

### 🟡 `domain-exception.filter.ts` — unsanitized `context` values in development HTTP responses

**Problem:** `DomainError.context` carries diagnostic fields (field names, received values, invalid inputs). In development mode, these were included verbatim in the HTTP response body. A user-supplied value containing newlines, ANSI escapes, or other control characters could inject false log entries when the response body is logged by monitoring tools or API clients (`log injection`).

**Fix:** Added `sanitizeContext()` helper that applies `sanitizeLogMessage()` to all string values in the context before including them in the development-mode HTTP response. Non-string values (numbers, booleans, null) pass through unchanged. Added import of `sanitizeLogMessage` and `ContextValue` type from `@besterp/shared`.

### 🟢 `idempotency.ts` — redundant `length === 0` check

**Problem:** The guard `!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH` contained a redundant `length === 0` check — empty strings are already caught by `!idempotencyKey` (empty string is falsy).

**Fix:** Removed the redundant `idempotencyKey.length === 0` check.

---

## Changes Applied (2026-07-13) — Code Review Round 25

### 🟡 Security: `sensitive-fields.ts` — redaction bypass for `dateOfBirth`, `passcode`, `passphrase`

**Problem:** The sensitive-field detector (`isSensitiveField`, shared by the audit-log and error-handler middlewares) missed three classes of sensitive key names:
- **`dateOfBirth`** — the camelCase Date-Of-Noun form of date of birth. The sibling forms `birthDate`, `birth_date`, `date_of_birth`, and `dob` were all caught, but this specific camelCase variant was not (it is not in `SENSITIVE_FIELDS`, does not match `SENSITIVE_FIELD_PATTERN`, and its `splitFieldTokens` output `date`/`Of`/`Birth` has no entry in `SENSITIVE_TOKENS`).
- **`passcode`** and **`passphrase`** — common auth-secret field names with no matching regex branch (the `password` branch requires the full word, and `passcode`/`passphrase` are distinct words), no explicit-set entry, and no token entry.

Confirmed by probe: `isSensitiveField("dateOfBirth")`, `isSensitiveField("passcode")`, and `isSensitiveField("passphrase")` all returned `false`. An MCP tool input like `{ dateOfBirth: "1990-01-01" }` or `{ passcode: "1234" }` would therefore be persisted verbatim to `ai_action_log.tool_input` (audit-log path) and returned to the AI agent in `ToolResult.error.context` (error-handler path).

**Fix:** Added `dateOfBirth`, `passcode`, and `passphrase` to `SENSITIVE_FIELDS`, and added `passcode` and `passphrase` to `SENSITIVE_TOKENS` (the token fallback catches camelCase variants like `newPasscode`, `verifyPassphrase`, `passcodeVerify`, and snake_case `passcode_hash`/`user_passphrase` that the regex misses). The DOB fix deliberately uses the explicit-set approach rather than adding a `birth` token — `birth` is too broad for this ERP domain and would over-redact benign demographic fields like `birthRate`. Added regression tests: a "passcode/passphrase + camelCase variants" block, an "all DOB variants consistency" block, and `birthRate`/`birthday` non-over-redaction assertions. `sensitive-fields.test.ts` now has 18 tests (was 16).

### 🟢 Docs: `cleanup-expired-idempotency.ts` — misleading usage comment referenced the wrong env var

**Problem:** The header usage example read `DATABASE_URL="..." npx tsx ...`, but the script gates on `DATABASE_ADMIN_URL` (`if (!process.env.DATABASE_ADMIN_URL) { ... process.exit(1); }`) because the app role cannot see tenant-scoped expired records through RLS policies. A copy-paste from the comment would exit immediately with `DATABASE_ADMIN_URL is required`.

**Fix:** Updated the comment to reference `DATABASE_ADMIN_URL`, matching the actual guard.

## Changes Applied (2026-07-13) — Code Review Round 22

### 🟡 Security: `sensitive-fields.ts` — OTP/MFA fields missing from redaction lists (redaction bypass)

**Problem:** `SENSITIVE_FIELDS` and `SENSITIVE_TOKENS` did not include OTP/MFA-related field names (`otp`, `mfa`, `otp_code`, `one_time_password`, `mfa_secret`). Bare `otp` is not caught by `SENSITIVE_FIELD_PATTERN` (no matching regex branch), and the token-based fallback splits it to `["otp"]` which wasn't in `SENSITIVE_TOKENS`. An MCP tool input like `{ otp: "123456" }` or `{ mfaToken: "..." }` would be persisted verbatim to `ai_action_log.tool_input`. `mfa_secret` is caught by the regex's `secret` branch, but bare `otp` and `mfa` are not.

**Fix:** Added `"otp"`, `"otp_code"`, `"one_time_password"`, `"mfa"`, `"mfa_secret"` to `SENSITIVE_FIELDS`, and `"otp"`, `"mfa"` to `SENSITIVE_TOKENS`. Also applied `Object.freeze()` to both sets for runtime immutability (previously they were TypeScript-only `ReadonlySet` without runtime enforcement). Added a dedicated `sensitive-fields.test.ts` (16 tests) covering explicit names, OTP/MFA fields, snake/camelCase detection, benign-field non-over-redaction, `splitFieldTokens`, `SENSITIVE_FIELDS`/`SENSITIVE_TOKENS` contents, `SENSITIVE_FIELD_PATTERN` regex matches, and freeze assertions.

### 🟡 Correctness: `idempotency.ts` — hash computed on invalid (un-normalised) input caused false mismatch on retry

**Problem:** When `safeParse` fails (invalid input from a buggy AI agent), the middleware hashed the **raw input**. The handler then returned `INVALID_INPUT` without executing. A subsequent retry with valid (Zod-normalised, e.g. `.trim()`-transformed) input computed a *different* hash because Zod transforms normalise the data. The hash mismatch caused a confusing `IDEMPOTENCY_KEY_MISMATCH` error instead of allowing the retry to proceed.

**Fix:** When `safeParse` fails, skip idempotency entirely — pass through to the handler which returns `INVALID_INPUT`. No idempotency record is created, so a subsequent retry with valid input starts fresh. Added a regression test asserting that a Zod validation failure passes through without creating or querying any idempotency record.

### 🟡 Correctness: `party.service.ts` — belt-and-suspenders guard against `Invalid Date` from `new Date(userInput)`

**Problem:** `createPartyTransaction` calls `new Date(sanitizedPerson.birthDate)` and `new Date(sanitizedOrg.registrationDate)` to convert validated ISO strings to `Date` objects. While `requireValidDate` already rejects non-ISO strings upstream, a future call path that bypasses validation could silently store an `Invalid Date` (Prisma accepts it as a corrupt timestamp with no error). `new Date("not-a-date")` returns an `Invalid Date` object rather than throwing.

**Fix:** Added `isNaN(parsedDate.getTime())` guards after each `new Date()` call that throws `InvalidTypeValueError` with the invalid value in context. This is defence-in-depth — the guard never fires in practice because `requireValidDate` + `isValidISODate` already validate upstream — but closes the silent-corruption gap.

### 🟢 Correctness: `rls-extension.ts` — non-function model properties silently returned `undefined`

**Problem:** `createModelDelegateProxy`'s `get` trap checked `typeof originalFn !== "function"` and returned `undefined`. Any non-function property access on a model delegate (e.g., a hypothetical static property or getter) would silently become `undefined` instead of the actual value.

**Fix:** Changed to `return originalFn` — pass through the original value unchanged. Only DATA_METHODS that are functions get wrapped.

### 🟢 Correctness: `truncate.ts` — `Date` objects silently changed type from `Date` to `string` after JSON roundtrip

**Problem:** `Date` objects fell through to `serializeObjectValue`, which called `JSON.stringify(date)`. `JSON.stringify(new Date())` produces a quoted string (`"\"2024-01-01T00:00:00.000Z\""`), then `JSON.parse` converts it to a plain string — silently changing the type from `Date` to `string`. While this doesn't cause bugs in practice (JSONB stores both as text), it's surprising and inconsistent with explicit handling of other types.

**Fix:** Added an explicit `Date` check in `normalisePrimitive` that converts to ISO string directly without the JSON stringify/parse roundtrip. Also extracted the primitive-handling fast path into a `normalisePrimitive` helper to keep `truncateValue`'s cyclomatic complexity within the lint threshold (was 17, now split across two functions). Added a regression test asserting `truncateValue(new Date("2024-06-15T14:30:00.000Z"))` returns `"2024-06-15T14:30:00.000Z"`.

### 🟢 Clarity: `error-handler.ts` — explicit return type on `handlePrismaError`

**Problem:** `handlePrismaError` had an inferred return type. If `PRISMA_ERROR_HANDLERS` changes shape, the compiler wouldn't catch mismatches at the call site.

**Fix:** Added explicit `PrismaErrorResult | null` return type annotation.

## Changes Applied (2026-07-12) — Code Review Round 21

### 🟢 Defense-in-depth: `error-handler.ts` — `DomainError.context` was not redacted by field name (secret-named keys could reach the AI agent)

**Problem:** The error-handler middleware sanitises `DomainError.context` before returning it to the AI agent via `sanitizeContextValue`, but that pass only scrubs string *values* (URL/path redaction + control-char stripping) — it does **not** redact by *field name*. The sibling audit-log middleware (`redactSensitiveFields`) does both. So the two agent-facing surfaces applied different redaction postures: a `password`/`apiKey`/`clientSecret` placed in a `DomainError`'s `context` would be persisted to the audit row as `[REDACTED]` but returned to the agent in the `ToolResult.error.context` verbatim. `DomainError.context` is application-constructed and by design never carries raw user secrets, so this was not an active leak — but it was the exact defense-in-depth gap the round-20 report called out as a candidate ("a future DomainError that places a secret in `context` would surface it to the AI agent").

**Fix:** The sensitive-field detection (`isSensitiveField` + its `SENSITIVE_FIELDS` set, `SENSITIVE_FIELD_PATTERN` regex, and `SENSITIVE_TOKENS`/`splitFieldTokens` camelCase fallback) is now shared between the two middlewares via a new `middleware/sensitive-fields.ts` module — a behaviour-preserving extraction (the audit-log imports it instead of defining it locally). The error-handler's `sanitizeObject` now redacts any value whose key `isSensitiveField` marks sensitive to `[REDACTED]`, before the value-level URL/path scrub runs, so both surfaces apply identical key-based redaction. Verified by probe that **none** of the 34 field names actually used across every existing `DomainError` call site (`partyId`, `field`, `conflictingFields`, `prismaCode`, `email`, `invalidValue`, `originalInputHash`, `requestedTool`, …) is flagged sensitive, so the change is behaviour-preserving in practice — it only closes the future-leak gap. Added regression tests asserting sensitive-named keys (`password`, `apiKey`, `api_key`, `accessToken`, `clientSecret`) are redacted while benign diagnostic fields pass through, that the raw secrets never reach the agent, and that URL/path scrubbing on non-sensitive values still composes correctly.

## Changes Applied (2026-07-12) — Code Review Round 20

### 🟡 Correctness: `idempotency.ts` — wasted all retries + backoff latency when the idempotency record expired mid-operation (P2025)

**Problem:** After a tool completes, `updateIdempotencyRecordWithRetry` persists the result by updating the pending record. If the 24h-TTL cleanup job (or a concurrent reset) removed the row between acquire and update, the update throws Prisma `P2025` ("record to update not found"). Because `P2025` was not special-cased, the loop retried it `IDEMPOTENCY_MAX_RETRIES` times — every retry re-throws `P2025` since the row is gone permanently — burning `IDEMPOTENCY_RETRY_BASE_DELAY_MS * (1+2) = 150 ms` of backoff before throwing `ConcurrencyConflictError`. That error was then swallowed by both call sites in `executeAndUpdate` (the success path and the throw path each wrap the call in `try/catch` + `logIdempotencyWarn`), so the only observable effect was wasted latency and a misleading "could not be updated after N attempts" warning that blamed retries for an unrecoverable condition.

**Fix:** `P2025` is now detected on the first attempt and short-circuits — log once (explaining the expiry, not blaming retries) and return, since there is nothing to update and both callers already tolerate a non-throwing return. Other transient errors keep the existing retry-then-throw behaviour. Verified the regression test fails on the pre-fix code (3 update attempts + propagated `ConcurrencyConflictError`) and passes on the fix (1 attempt, result returned). Also merged two adjacent `if (code !== "P2034")` blocks in `acquireIdempotencyRecord`'s catch into one (identical condition, behaviour-preserving).

### 🟡 Correctness: `party.service.ts` — duplicate-email redaction was malformed for short local parts

**Problem:** `checkEmailDuplicate` masks the offending address before putting it in the `DuplicateEntityError` message + `context`. The preview was computed as `${email.slice(0, 2)}***@${domain}` unconditionally. For a valid address with a single-character local part (`a@x.com` — accepted by `EMAIL_REGEX`), the 2-char slice spans into the `@`, producing `a@***@x.com` — a malformed address emitted to the AI agent and stored in the structured error context. Confirmed by probe: `"a@x.com"` → `"a@***@x.com"`. This path was previously untested.

**Fix:** The preview is now clamped to `slice(0, Math.min(2, atIdx))` so the `@` never lands inside it. Behaviour is unchanged for local parts ≥ 2 chars (`ab@x.com` → `ab***@x.com`); the 1-char case is now `a***@x.com`. Added a regression test that exercises `emailAddress.findFirst` returning an existing match and asserts the redacted shape, the absence of the malformed double-`@`, and that the full unmasked address never reaches the error surface. Verified the test fails on the pre-fix code.

## Changes Applied (2026-07-11) — Code Review Round 14

### 🟡 Security: `audit-log.ts` — camelCase sensitive fields leaked past catch-all redaction regex (redaction bypass)

**Problem:** `SENSITIVE_FIELD_PATTERN` uses alnum-only lookarounds (`(?<![a-zA-Z0-9])` / `(?![a-zA-Z0-9])`) so `_` and `-` act as separators, but the lowercase→uppercase transition does **not**. The snake_case siblings were redacted (`client_secret`, `bearer_token`, `access_token`) while their camelCase forms — `clientSecret`, `bearerToken`, `accessToken`, `refreshToken`, `userPassword`, `sessionToken` — leaked verbatim into `ai_action_log.tool_input`. Confirmed by probe: `isSensitiveField("clientSecret")` returned `false` while `isSensitiveField("client_secret")` returned `true`. These are common OAuth/credential field names, so the gap was a real redaction bypass on a durable, cross-tenant audit table. The code comment even claimed camelCase was caught, but the implementation only delivered that for `auth`-prefixed names (`authToken`) via the dedicated `auth(?:token|key|code|…)?` branch.

**Fix:** Added a token-based fallback to `isSensitiveField`. `splitFieldTokens()` splits a field name at snake_case, kebab-case, **and** camelCase boundaries (`clientSecret` → `[client, Secret]`), then each token is checked against `SENSITIVE_TOKENS` (`password`, `passwd`, `pwd`, `secret`, `token`, `credential`, `credentials`). `key` is intentionally excluded — it over-redacts benign names like `primaryKey`/`foreignKey`/`sortKey`; key-bearing sensitive fields stay covered by the explicit `SENSITIVE_FIELDS` set and the `api[_-]?key` regex. None of the current party-tool field names (`idempotencyKey`, `lineNumber`, `birthDate`, `partyType`, …) contain a sensitive token, so there is no over-redaction in practice. Added a regression test in `middleware.test.ts` asserting the camelCase forms are redacted, their snake_case siblings stay redacted, and `primaryKey`/`foreignKey`/`idempotencyKey`/`tokenize`/`secrets` are preserved.

### 🟡 Security: `sanitize.ts` — credential-bearing URLs with unlisted schemes leaked to operator logs

**Problem:** `sanitizeLogOutput` had explicit patterns for `postgres(ql)://`, `redis://`, `mongodb://`, `mysql://`, `amqp(s)://`, `http(s)://`, `ftp/sftp://`, and `ws/wss://`, but no catch-all for other schemes. A driver/library error can embed a credential-bearing URL in any scheme — e.g. `ssh://user:pass@host`, `ldap://cn=admin:password@host`, `vault://token:s3cret@host` — and these passed through verbatim, leaking inline credentials to stderr/audit logs. Confirmed by probe: all three were returned unchanged.

**Fix:** Added a generic credential-URL pattern `[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@"']+:[^\s/@"']+@[^\s"']+` → `[REDACTED_URL]`, placed **after** the scheme-specific patterns so they keep their labelled output (`[DATABASE_URL]`, `[REDIS_URL]`, …) and this only catches what they miss. The pattern requires a userinfo segment (`user:pass@`), so credential-free URLs of arbitrary schemes (`file:///etc/passwd`, `custom://host`) are not false positives. Added regression tests in `sanitize.test.ts` covering `ssh`/`ldap`/`ldaps`/`vault` schemes, mid-sentence credentials, the no-false-positive case, and labelled-output preservation.

## Changes Applied (2026-07-11) — Code Review Round 13

### 🟡 Correctness: `crypto.ts` — `hashInput` silently hashed WeakMap/WeakSet as `{}` (hash collision)

**Problem:** `sortKeysDeep` has explicit branches for `Map` and `Set` (converted to sorted arrays) and throws for `function` values, but no branch for `WeakMap`/`WeakSet`. These are non-enumerable, so they fell through `sortObject` → `serializeSpecialObject` → `sortPlainObject`, where `Object.keys()` returns `[]`. Result: `hashInput(new WeakMap())` produced the **same hash as `hashInput({})`** (and every distinct WeakMap collided with every other) — confirmed by probe. That is silent data loss for an idempotency hash: two tool inputs differing only in an unhashable Weak collection would be treated as identical, defeating mismatch detection. Both `audit-log.ts` and `error-handler.ts` already guard Weak collections (`"[WeakCollection]"`), making this an inconsistency.

**Fix:** Added a guard in `serializeSpecialObject` (the non-plain-object dispatch point that Weak collections actually reach — `WeakMap.prototype`/`WeakSet.prototype` are neither `Object.prototype` nor `null`, so they bypass `sortPlainObject`'s direct path) that throws `InvalidTypeValueError`, mirroring the existing `function` guard. The guard lives there rather than in `sortKeysDeep` so the latter keeps its prior cyclomatic complexity (no new lint warning). Added a regression test in `crypto.test.ts` asserting `hashInput` throws for a bare `WeakMap`/`WeakSet`, for one nested inside an object, and that a plain `{}` still hashes successfully.

### 🟡 Security: `audit-log.ts` — `redactSensitiveFields` returned raw unredacted value past depth cap (redaction bypass)

**Problem:** `isTerminal` short-circuited to `true` when `depth > MAX_REDACTION_DEPTH`, and `redactSensitiveFields` then `return value` — the raw object. Because the key-name redaction loop runs *inside* `redactSensitiveFields` (after the terminal check), an object sitting deeper than the cap was returned whole with its sensitive keys never inspected: a `password` buried >10 levels deep would be persisted verbatim to `ai_action_log.tool_input`. The sibling `error-handler.ts` `sanitizeContextValue` returns `"[Too deep]"` at its cap; for a *redaction* function, returning unredacted data is the riskier choice.

**Fix:** Split the depth guard out of `isTerminal`: `redactSensitiveFields` now returns `"[Too deep]"` when `depth > MAX_REDACTION_DEPTH` (matching `sanitizeContextValue`), and `isTerminal` checks only primitive/terminal types. Added a regression test in `middleware.test.ts` that nests `{ password: "leak-me" }` 12 levels deep and asserts the serialized stored `toolInput` neither contains `"leak-me"` nor omits the `"[Too deep]"` placeholder. Verified the test fails on the pre-fix code (raw `"password":"leak-me"` in the stored row) and passes on the fix.

## Changes Applied (2026-07-11) — Code Review Round 12

### 🟡 Correctness: `main.ts` — JWT_SECRET weak-secret heuristic flagged legitimate high-entropy secrets (false positive)

**Problem:** The startup weak-secret check used the pattern `/^(0{32}|[a-f]{32})$/i`, documented as catching "all-same-case hex (no entropy)". But `[a-f]{32}` matches **any** 32-character string composed solely of `a–f` letters — e.g. `"abcdefabcdefabcdefabcdefabcdefab"` (~82 bits of entropy) — not just a single repeated character. An operator using a random 16-byte hex secret that happened to contain no digits received a spurious `JWT_SECRET appears to be a weak or default value` warning. Worse, because this logic lived inline in the bootstrap (which calls `process.exit`), it had no unit tests.

**Fix:** Extracted the heuristics into a standalone, testable module `apps/api/src/auth/secret-strength.ts` exporting `isWeakSecret()` and `MIN_JWT_SECRET_LENGTH`. Replaced the buggy pattern with `/^(.)\1{31,}$/`, which matches a single character repeated for the whole string — the correct expression of zero entropy (`0`×32, `f`×32, spaces, …) — without false-positiving on real hex secrets. `main.ts` now delegates to the helper. Added `secret-strength.spec.ts` with a regression test asserting that `"abcdef..."` (32 a–f letters) and a random 32-char hex are both classified as **not** weak, while all-zero / all-`f` / default literals are.

### 🟢 Consistency: `auth.module.ts` — `JWT_EXPIRES_IN` warning regex aligned with the authoritative startup gate

**Problem:** `auth.module.ts` validated `JWT_EXPIRES_IN` with `/^\d+\s*[smhd]$/` (optional whitespace), while `main.ts`'s `validateEnvironment()` enforces `/^\d+[smhd]$/` strictly and exits on mismatch. Because ESM module-level code evaluates before `main.ts` runs, the module-level warning is the first signal an operator sees; a divergent regex either warns about values the app accepts or stays silent about values the app rejects.

**Fix:** Dropped the `\s*` so the warning regex exactly mirrors the hard gate. The warning remains a best-effort preview (the authoritative exit happens in `main.ts`).

### 🟢 Log hygiene: `cleanup-expired-idempotency.ts` — removed emoji from structured stderr line

**Problem:** The failure log emitted `❌ Cleanup failed:` while every other structured log line across the middlewares and this script is plain ASCII. The leading emoji risked glyph/encoding surprises in log shippers that don't expect multi-byte symbols on the error stream.

**Fix:** Dropped the `❌` for consistency with the rest of the operator-log output.

## Changes Applied (2026-07-07) — Code Review Round 39

### 🟡 Security: `audit-log.ts` — snake_case sensitive fields leaked past catch-all redaction regex

**Problem:** `SENSITIVE_FIELD_PATTERN` used `\b` word boundaries: `/\b(password|secret|token|api[_-]?key|credential|auth(?:Token|Key|Code)?)\b/i`. Under JS regex, `_` is a word character (`\w` = `[A-Za-z0-9_]`), so there is **no word boundary** between `_` and an adjacent keyword. Consequently `\btoken\b` could not match `session_token`, `auth_token`, `bearer_token`, `id_token`, `user_token`, or `client_secret`, and the `auth` subgroup could not match `auth_token` / `auth_key` / `auth_code`. The explicit `SENSITIVE_FIELDS` set covered `access_token` / `refresh_token`, but every other `*_token` / `*_secret` / `auth_*` field name leaked into `ai_action_log.tool_input` verbatim. This is a real credential-leak surface: an MCP tool input like `{ auth_token: "eyJ..." }` or `{ client_secret: "..." }` would be persisted to the durable audit table unredacted.

**Fix:** Replaced the `\b` boundaries with alnum-only lookarounds (`(?<![a-z0-9])` / `(?![a-z0-9])`) so `_` and `-` act as separators, and extended the `auth` subgroup to accept a snake/camel `token|key|code` suffix:
`/(?<![a-z0-9])(password|secret|token|api[_-]?key|credential|auth(?:token|key|code|[_-](?:token|key|code))?)(?![a-z0-9])/i`.
This catches `auth_token`, `session_token`, `bearer_token`, `id_token`, `client_secret`, `user_token`, `auth_key`, `auth_code`, and `authToken`/`authKey` (camelCase) while still rejecting infix matches inside unrelated words (`tokenize`, `keywords`, …). Verified no over-redaction of the legitimate party/contact field names. Added a regression test asserting each snake_case variant is redacted and that `tokenize`/`name` are left intact.

### 🟡 Log hygiene: `prisma.service.ts` — DB connection errors logged with raw datasource URLs

**Problem:** `onModuleInit` (connect-failure catch) and `onModuleDestroy` (per-client disconnect rejection) wrote Prisma/driver error `message` and `stack` straight to the NestJS logger. Driver connection errors routinely embed the datasource URL (credentials + hostname, e.g. `postgres://besterp:s3cret@10.0.0.5:5432/besterp`), and `${result.reason}` stringifies an `Error` as `name: message`, so the URL reached operator logs verbatim. This was inconsistent with `main.ts` (shutdown paths), the global `DomainExceptionFilter`, and the MCP error-handler middleware, all of which scrub such messages via `sanitizeForLogOutput`.

**Fix:** Wrapped both log sites (message + stack in `onModuleInit`; reason in `onModuleDestroy`) with `sanitizeForLogOutput` so connection strings/hostnames/paths are redacted to `[DATABASE_URL]` / `[HOST]` / `[PATH]`. Added two regression tests that inject a URL-bearing connection error and assert the password and scheme never reach the log while `[DATABASE_URL]` does.

### 🟢 Log hygiene: `idempotency.ts` + `audit-log.ts` — driver errors in stderr warnings scrubbed

**Problem:** Two fire-and-forget stderr warning paths wrote raw driver error messages: (1) `acquireIdempotencyRecord`'s non-P2034 warning included `e.message`, and (2) `updateIdempotencyRecordWithRetry`'s final-attempt warning included raw `detail` (the thrown `InvalidTypeValueError` already sanitized the same detail, but the stderr line did not). Separately, the audit-log backpressure manager's `.catch` on a failed `aiActionLog.create` wrote `logErr.message` to stderr. All three can carry a DB connection string.

**Fix:** Applied `sanitizeLogOutput` to the embedded error message in each of the three warning sites, matching the audit-log error-persistence path (`executeAndLog`'s throw branch) and the error-handler middleware. Added regression tests: the idempotency acquire non-P2034 path and the audit-write failure path now inject a URL-bearing driver error and assert `[DATABASE_URL]` replaces it before it reaches stderr.

## Changes Applied (2026-07-03) — Code Review Round 17

### 🟢 Cleanup: `party-tools.ts` — Eliminated Double `trim()` Call in `optionalSanitizedString`

**Problem:** The `optionalSanitizedString` helper called `s.trim()` twice — once in the
truthiness check (`s?.trim()`) and again in the HTML-strip call (`stripHtmlTags(s.trim())`).
This was a minor performance waste and set a misleading pattern for future helpers.

**Fix:** Captured the trimmed result in a local variable so `.trim()` runs exactly once.

## Changes Applied (2026-07-02) — Code Review Round 8

### 🟡 Fix: `sanitize.ts` — non-CSI ANSI escape regex missed lowercase finals

**Problem:** `sanitizeForLog`'s third ANSI branch is documented as "ESC followed by a final byte" but its character class excluded lowercase letters (`a`–`z`, 0x61–0x7A). Real two-character ESC sequences with lowercase finals fell through — `ESC c` (RIS, full terminal reset), `ESC n` (LS2), `ESC o` (LS3). The ESC initiator is always neutralized by the subsequent control-char replacement pass, so this was **not** an active terminal-control security hole; the trailing final byte just survived as a stray character (`"\x1bc"` → `"_c"` instead of `""`), leaving junk in sanitized log lines.

**Fix:** Added `a-z` to the class so the full ECMA-48 final-byte range (0x30–0x7E) is covered. Added a comment explaining the nuance (the ESC byte is always stripped by the control-char pass, so this is a log-completeness fix, not a security fix). Added regression tests for RIS/LS2/LS3, including an explicit guard that the output is not the old `"_c"` shape.

### 🟡 Fix: `main.ts` — untrusted `x-request-id` reflected without charset validation

**Problem:** The request-correlation middleware only ran `raw.slice(0, 128)` on the client-supplied `x-request-id` header before reflecting it via `res.setHeader("x-request-id", …)` and storing it on `req.requestId`. Raw CRLF is already gated by Node's HTTP parser + `setHeader` validation, so this was not an exploitable response-splitting bug — but spaces, tabs, non-ASCII bytes, and multi-valued (array) headers were accepted verbatim and flowed into both the response header and log correlation.

**Fix:** Extracted a pure, tested `resolveRequestId(raw)` helper (`apps/api/src/common/request-id.ts`) that honours the header only when it is a printable-ASCII token (0x21–0x7E, no whitespace/control bytes, ≤128 chars) and falls back to a fresh UUID v4 otherwise. `main.ts` now delegates to it. Covered by 12 unit tests (valid UUID/ULID/traceparent/base64 passthrough, trim, empty/array/non-string → UUID, CRLF/NUL/ESC rejection, non-ASCII rejection, boundary length). Removed the now-unused `randomUUID` import from `main.ts`.

### 🟢 Test: locked in untested `crypto.ts` behavior (Map/Set + depth guard)

**Problem:** The non-trivial `sortKeysDeep` paths for `Map`/`Set` (canonical sorted-key/value conversion) and the `MAX_HASH_DEPTH` DoS guard had no direct coverage, so regressions in idempotency-hash determinism could slip through unnoticed.

**Fix:** Added tests in `crypto.test.ts` for Map key-order independence, Set value-order independence, distinct-content differentiation, and the depth-limit throw (`InvalidTypeValueError` / "maximum nesting depth"). Behavior is unchanged; these are pure coverage locks.

## Changes Applied (2026-07-02) — Code Review Round 7

### 🟡 Fix: `truncate.ts` — UTF-8 multibyte split in stored previews

**Problem:** `truncateValue()` (used by the audit-log and idempotency middlewares to cap JSONB payloads at 64 KB) generated its `_preview` via a naive `textDecoder.decode(encoded.slice(0, PREVIEW_BYTES))`. When the 1 KB preview boundary landed in the middle of a multi-byte UTF-8 character (CJK text, emoji, accented chars), `TextDecoder` emitted a spurious U+FFFD (replacement character) at the end of the stored preview. The sibling `capString()` in the *same file* already walked backwards over continuation bytes to avoid exactly this — so the two functions were inconsistent, and the durable `ai_action_log` / `idempotency_record` previews could silently contain corrupt trailing replacement characters.

**Fix:**
- Extracted a shared `safeSliceUtf8(encoded, byteLimit)` helper that walks back over UTF-8 continuation bytes (`10xxxxxx`, 0x80–0xBF) so a slice never ends mid-code-point.
- `capString()` now delegates to it (replacing its inline walk-back loop) and all four `_preview` sites in `truncateValue()` (string/boolean, number, bigint, and general-object branches) use it via a new `truncationMarker(encoded)` builder.
- Behaviour is otherwise identical; only the previously-broken previews change (they get one code point shorter instead of gaining a U+FFFD).

### 🟢 Test: New `truncate.test.ts` (16 tests)

**Problem:** `truncateValue` / `capString` had no direct unit coverage — they were only exercised indirectly through the middleware integration tests, and none of those covered the multibyte boundary.

**Fix:** Added `packages/mcp-tools/src/__tests__/truncate.test.ts` covering pass-through of primitives/null/undefined, bigint→string, symbol/function markers, oversize truncation markers, circular-reference error markers, and — critically — deterministic multibyte-boundary cases for both the `_preview` path and `capString`. The two preview cases are constructed so the byte cap lands on a known continuation byte; they fail against the old naive slice (verified by temporarily reverting) and pass with `safeSliceUtf8`.

## Changes Applied (2026-07-02) — Code Review Round 6

### 🟢 Cleanup: `mcp.module.ts` — Removed Duplicate `validateReasoningField`

**Problem:** `validateReasoningField` was byte-for-byte identical to `validateOptionalField` — same type guard, same trim, same whitespace-only rejection, same length cap, and the exact same error strings. The only difference was the hardcoded `"reasoning"` field name, which `validateOptionalField` already accepts as a parameter. ~33 lines of duplicated logic.

**Fix:** Deleted `validateReasoningField` and routed the `reasoning` field through `validateOptionalField("reasoning", overrides.reasoning, MAX_REASONING_LENGTH)`. All existing `mcp.module.spec.ts` assertions (type error, too-long, whitespace-only, trim, null→undefined, max-length) continue to pass unchanged.

### 🟢 Cleanup: `party-tools.ts` — Replaced Magic Numbers with Shared Pagination Constants

**Problem:** The `search_parties` Zod schema hardcoded `.min(1).max(500)` for `limit` and `.min(0)` for `offset`, while the sibling REST DTO (`party.dto.ts`) and the service layer (`party.service.ts`) both use the `MIN_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` / `MIN_SEARCH_OFFSET` constants from `@besterp/shared`. If the shared constant changes, the MCP schema would silently drift out of sync, accepting input the service then has to reject/clamp.

**Fix:** Imported the three constants and used them in both the validators and the AI-facing `.describe()` strings (`max ${MAX_SEARCH_LIMIT}`, `min ${MIN_SEARCH_OFFSET}`).

### 🟢 Cleanup: `party-tools.ts` — Extracted `uuidParam()` Helper

**Problem:** The `partyId` field `z.string().min(1).max(200).regex(UUID_REGEX, "Must be a valid UUID")` was duplicated verbatim across three tools (`get_party`, `add_party_role`, `add_contact_mechanism`).

**Fix:** Extracted a `uuidParam(description)` helper alongside the existing `sanitizedString` / `optionalIsoDate` builders, centralizing the UUID contract (including the 200-char generous input cap, documented inline) so it can't drift between tools.

### 🟡 Robustness: `domain-exception.filter.ts` — Generic Fallback Message for Scrubbed HttpExceptions

**Problem:** The production branch of `handleHttpException` only kept `res.message` when it was a string. `ValidationPipe` errors carry `message` as an **array** of detail strings, so in production a 400 returned a bare `{ statusCode: 400, error: "Bad Request" }` with no `message` field — useless to API clients trying to understand why their request was rejected.

**Fix:** When `res.message` is not a string, substitute a generic, status-appropriate message (`"Validation failed"` for 400, `"Request error"` otherwise). The security goal is preserved — internal field names from the validation detail array are still stripped — but clients now receive a usable body.

### 🟢 Test: Added `domain-exception.filter.spec.ts` (11 tests)

**Problem:** `DomainExceptionFilter` is a critical globally-registered component (maps every DomainError/HttpException/unexpected error to an HTTP response) yet had **zero** test coverage.

**Fix:** Added a focused spec covering: DomainError→status mapping (404/409/422), unknown-code 500 generic message, production scrubbing of `suggestedTools`/`context`, the new ValidationPipe array-message fallback, string-message pass-through, non-production pass-through, unexpected-error sanitization (verifies connection strings are redacted), and the headers-already-sent guard.

## Changes Applied (2026-07-02) — Code Review Round 5

### 🟢 Cleanup: `party-tools.ts` — Removed Duplicate `optionalSanitizedText` Helper

**Problem:** `optionalSanitizedText` was byte-for-byte identical to `optionalSanitizedString`. Its doc comment claimed a behavioral difference ("whitespace-only input becomes undefined"), but both functions already did this via the `s?.trim() ? ... : undefined` transform — so the second function was dead code with a misleading comment.

**Fix:**
- Removed `optionalSanitizedText` entirely
- Updated its 4 call sites (`addressLine2`, `stateProvince`, `extension`, `description`) to use `optionalSanitizedString`
- Folded the (accurate) whitespace-normalization note into `optionalSanitizedString`'s doc comment

### 🟢 Cleanup: `party-tools.ts` — Simplified `optionalIsoDate` Refine Predicate

**Problem:** The refine check `v === undefined || v.length > 0 && isValidISODate(v)` mixed `||` and `&&` without parentheses (a readability trap) and included a redundant `v.length > 0` — the preceding transform already converts empty/whitespace input to `undefined`, so any non-`undefined` `v` reaching the refine is guaranteed non-empty.

**Fix:** Simplified to `v === undefined || isValidISODate(v)` with a comment explaining why the length check is implicit. Behavior is identical.

### 🟢 Cleanup: `audit-log.ts` — Eliminated Double Redaction of `toolInput`

**Problem:** `redactSensitiveFields(entry.toolInput)` ran in `logAction()`, but `toolInput` had *already* been redacted by `createBaseEntry()` before it entered the backpressure queue. The second pass re-traversed the (potentially large) object graph for no effect, doubling redaction cost on every audited tool call.

**Fix:** `logAction()` now trusts the pre-redacted `entry.toolInput` and only runs `redactSensitiveFields` on `toolOutput` (which is added raw in `executeAndLog()`).

## Changes Applied (2026-07-01) — Code Review Round 4

### 🟢 Cleanup: `health.service.spec.ts` — Removed Unused `appClient` Mock

**Problem:** `createMockPrisma()` created a mock for `appClient` but `getHealth()` only uses `this.prisma.admin`. The `appClient` mock was dead code.

**Fix:** Removed the unused `appClient` from the mock factory.

### 🟢 Cleanup: `main.ts` — Explicit Import of `tenant-context.ts` for Module Augmentation

**Problem:** `req.requestId` relied on the Express module augmentation (`declare module "express" { interface Request { requestId?: string } }`) being transitively imported via `AppModule → PartyModule → PartyController → tenant-context.ts`. If this import chain changed, `req.requestId` would silently cause a TypeScript error.

**Fix:** Added an explicit `import "./common/tenant-context.js"` in `main.ts` to make the dependency direct and stable.

## Changes Applied (2026-07-01) — Code Review Round 3

### 🟢 Cleanup: `validatePersonData` / `validateOrganizationData` — Eliminated Redundant `.trim()` Calls

**Problem:** `firstName`, `lastName`, and `legalName` were trimmed twice — once in the emptiness check and again in the `requireMaxLength` call.

**Fix:**
- Captured trimmed value once and reused for both checks
- Same fix applied to all three fields

### 🟢 Cleanup: `validateContactMechanismSubtype` — Captured Trimmed Return Values

**Problem:** `requireStringField()` returns the trimmed value, but the return values for `addressLine1`, `city`, and `country` were discarded in the POSTAL_ADDRESS branch, forcing `sanitizePostalAddress` to re-trim redundantly.

**Fix:**
- Captured `trimmedCountry` return value and reused for the ISO 3166-1 min-length check
- Calls for `addressLine1`, `city`, `areaCode`, and `lineNumber` now follow the same capture-or-discard pattern with clear intent

### 🟢 Fix: `DomainExceptionFilter` — Include Error Code in Production Responses

**Problem:** The `error` code field (e.g., `"ENTITY_NOT_FOUND"`, `"DUPLICATE_ENTITY"`) was stripped from production HTTP responses. This forced API consumers to parse the `message` string to distinguish error types programmatically.

**Fix:**
- `error` code is now always included in the response body, regardless of environment
- `suggestedTools` and `context` fields remain development-only (they may leak implementation details)

## Previous Changes (2026-07-01) — Code Review Round 2

### 🟢 Defense-in-Depth: Non-String `partyType` Guard Added

**Problem:** `createParty()` assumed `partyType` was always a string. Direct/internal callers bypassing the DTO/Zod boundary could pass non-string values (e.g., `null`, `undefined`, numbers), causing a cryptic crash at `.trim()`.

**Fix:**
- Added `typeof partyType !== "string" || !partyType.trim()` guard before trimming
- Returns `InvalidTypeValueError` with clear message and context

### 🟢 Defense-in-Depth: Name Fully Consumed by HTML Sanitization Check

**Problem:** A name like `"<script>alert(1)</script>"` passes length validation but is entirely consumed by `stripHtmlTags`, resulting in an empty stored name. Boundary layers (REST DTO, MCP Zod) strip HTML before validation, but an internal caller bypassing them could store an empty name.

**Fix:**
- Added `if (!sanitizedName)` check after `sanitizeCreatePartyInput`
- Validates the name still has visible characters after HTML stripping

### 🟢 Fix: `gender` Whitespace-Only Input Normalized to `undefined`

**Problem:** `sanitizeCreatePartyInput` used `personData.gender ?` for the truthiness check, which passes for whitespace-only strings like `"   "`, resulting in an empty string being stored.

**Fix:**
- Changed to `personData.gender?.trim() ?` — consistent with the `middleName` pattern

### 🟢 Fix: Empty Description After HTML Stripping Normalized to `null`

**Problem:** A `description` like `"<script></script>"` validated as non-empty (length > 0 after trim), but `stripHtmlTags` consumed it entirely, storing an empty string.

**Fix:**
- `sanitizedDescription` now uses `stripHtmlTags(...) || null` to normalize empty results

## Previous Changes (2026-06-29) — Initial Review Recommendations

### 🟢 Test Coverage: `@besterp/shared/sanitize.ts` — 49 Unit Tests Added

**Problem:** `stripHtmlTags`, `sanitizeLogOutput`, `sanitizeForLog`, and `safeFromCodePoint` had zero unit test coverage despite handling security-critical input sanitization.

**Fix:**
- 18 tests for `stripHtmlTags`: empty string, plain text, HTML tag removal, script/style stripping, entity decoding (including double-encoded), HTML comments, null bytes, orphaned tags, deeply nested encoded strings, oversized input, mixed content, C0 controls, and edge cases.
- 10 tests for `sanitizeLogOutput`: redaction of PostgreSQL, Redis, MongoDB, MySQL, AMQP connection strings; generic `protocol://HOST/` patterns; file path scrubbing; multiple concurrent patterns; and safe message preservation.
- 8 tests for `sanitizeForLog`: newline, carriage return, tab, and ANSI escape removal; C0 control character replacement; and multi-injection input.
- 6 tests for `safeFromCodePoint`: valid code points, lone surrogates, negative values, out-of-range values, and NaN.

### 🟢 Cleanup: `EmailAddressDto.email` — Removed Redundant Double Transform

**Problem:** `email` field had both `@sanitizeTransform()` (`stripHtmlTags` + `trim`) and a separate `@Transform` (`trim` + `toLowerCase`), producing a wasteful double trim and a misleading separation of sanitization concerns.

**Fix:** Consolidated into a single `@Transform` that does `stripHtmlTags` + `trim` + `toLowerCase` in one pass. Also fixed the type annotation from `{ value }: { value: string }` to the correct `{ value }: TransformFnParams`.

### 🟢 Cleanup: `PostalAddressDto.country` — Fixed `@Transform` Type Annotation

**Problem:** The inline `@Transform` callback used `{ value }: { value: string }` instead of the proper `TransformFnParams` type that was already imported.

**Fix:** Changed to `{ value }: TransformFnParams` for type consistency with `sanitizeTransform()` and the rest of the codebase.

### 🟡 Significant: `requireStringField` Now Returns Trimmed Value

**Problem:** `PartyService.requireStringField()` returned `void`. Every call site had a two-line pattern:
`this.requireStringField(tenantId, ...); const trimmedTenantId = tenantId.trim();` — redundant
trimming that could drift out of sync.

**Fix:**
- `requireStringField()` now returns the trimmed value directly
- Simplified 6 call sites to a single line: `const trimmed = this.requireStringField(...)`
- Same pattern applied to `validateContactMechanismType`

### 🟡 Significant: `@prisma/client` Moved to Runtime Dependencies

**Problem:** `@prisma/client` was listed as a devDependency in `@besterp/shared/package.json`.
At runtime, `import { Prisma } from "@prisma/client"` in `errors.ts` would fail because
devDependencies are not installed in production.

**Fix:**
- Moved `@prisma/client` from devDependencies to dependencies in `@besterp/shared`

### 🟢 Cleanup: Void Floating Promises Explicitly

**Problem:** `health.controller.ts` `ready()` method had `healthPromise.catch(...)` without
`void`, triggering `@typescript-eslint/no-floating-promises` error.

**Fix:**
- Added `void` prefix to the fire-and-forget `.catch()` chain

### 🟢 Cleanup: Removed Dead `validation-utils.ts`

**Problem:** `packages/shared/src/validation-utils.ts` was a stale, 318-line file with
incompatible exports and dead code, removed in a prior commit but the file persisted.

**Fix:**
- Deleted `validation-utils.ts`
- All callers use the consolidated `validation.ts` module

### 🟢 Cleanup: `main.ts` Express Imports & Error Handler

- Changed `express` import from `import express from "express"` to static named import
  for tree-shaking consistency
- Added catch-all Express error handler middleware for safety net

### 🟢 Cleanup: PartyService — Trim `tenantId` Before Subtype Check

- Moved `tenantId.trim()` call before `partyType.trim()` in `createParty()` to match
  the validation order used by all other service methods
- `QueueModule` — trim `host` before connection validation

### 🔴 Critical: RLS Proxy `$transaction` Bug Fixed

**Problem:** `createTenantClient()` returned a Proxy that passed `$transaction` through
to the raw PrismaClient without intercepting it. When `PartyService` called
`db.$transaction(async (tx) => { tx.party.create(...) })`, the transaction
callback received the raw `tx` — `SET LOCAL` was never called, so RLS policies
were not active inside transactions.

**Fix:**
- The Proxy now intercepts `$transaction(fn)` and `$transaction(fn, options)` calls
- Before invoking the user's callback, it executes `SET LOCAL app.current_tenant`
- The transaction client (`tx`) inherits the tenant context for all its queries
- Batch `$transaction([...promises])` calls pass through (use interactive transactions for tenant-scoped ops)

### 🔴 Critical: Global Domain Exception Filter Added

**Problem:** Domain errors (EntityNotFoundError, InvalidTypeValueError, etc.) thrown
in services resulted in raw 500 Internal Server Errors. The `domainErrorToHttp()`
function existed but was never wired up.

**Fix:**
- New `DomainExceptionFilter` registered globally via `APP_FILTER` in AppModule
- Catches `DomainError` and maps to appropriate HTTP status codes:
  - `ENTITY_NOT_FOUND` → 404
  - `DUPLICATE_ENTITY`, `CONCURRENCY_CONFLICT` → 409
  - `MISSING_SUBTYPE_DATA`, `INVALID_TYPE_VALUE` → 422
- Returns structured JSON with `error`, `message`, `suggestedTools`, and `context`

### 🔴 Critical: Input Validation DTOs Added

**Problem:** The global `ValidationPipe` was configured but all controller methods used
plain TypeScript interfaces as body types. `class-validator` had no decorators to validate
against — all request bodies passed through unvalidated.

**Fix:**
- New `party.dto.ts` with class-validator DTOs for all party endpoints
- `CreatePartyDto`, `SearchPartiesDto`, `AddPartyRoleDto`, `AddContactMechanismDto`
- Subtype DTOs: `CreatePersonDto`, `CreateOrganizationDto`, `PostalAddressDto`, etc.
- `@ValidateNested()` + `@Type()` for nested object validation
- `SearchPartiesDto` replaces manual `parseInt` query parameter parsing with `@IsInt()` + `@Type()`
- Added `class-validator` and `class-transformer` as dependencies

### 🟡 Significant: TenantGuard Changed from Request-Scoped to Singleton

**Problem:** `TenantGuard` was annotated with `@Injectable({ scope: Scope.REQUEST })`,
which forces the entire injection chain to become request-scoped — a known NestJS
performance anti-pattern.

**Fix:**
- Removed `Scope.REQUEST` — guard is now singleton (default)
- Uses `context.switchToHttp().getRequest<Request>()` instead of `@Inject(REQUEST)`
- Accesses `req.user` via the ExecutionContext, which is always request-specific

### 🟡 Significant: `toPartyResult` Typed Properly

**Problem:** `toPartyResult(party: any)` used `any`, losing type safety at the
mapping boundary. Renaming a Prisma field would not cause a compile error.

**Fix:**
- Extracted `PartyWithIncludes` type alias using `Prisma.PartyGetPayload<{include: ...}>`
- `toPartyResult(party: PartyWithIncludes)` is now fully typed
- Removed all `any` casts in `searchParties` mapping

### 🟡 Significant: Missing Database Indexes Added

**Problem:** `party_role` had no index on `partyId` or `roleTypeId`. RLS policies
query `party_role` by `partyId IN (subquery)` — without an index, this becomes
a sequential scan as data grows.

**Fix:**
- Added `@@index([partyId])` and `@@index([roleTypeId])` on `PartyRole` model
- Added `@@index([contactMechanismId])` on `PartyContactMechanism` model
- Requires `npm run db:migrate` to apply

### 🟡 Significant: Idempotency Keys Now Required on All Write Tools

**Problem:** `add_party_role` and `add_contact_mechanism` MCP tools had
`idempotencyKey` as optional, inconsistent with ADR-004 which states "every
write tool must accept an idempotency key."

**Fix:**
- `idempotencyKey` is now required on `add_party_role` and `add_contact_mechanism`
- Updated descriptions with format guidance

### 🟡 Significant: Environment Variable Validation at Startup

**Problem:** `DATABASE_URL` and other critical env vars were not validated at startup.
Missing values caused confusing runtime errors deep in Prisma connection logic.

**Fix:**
- Added startup validation in `main.ts` for `DATABASE_URL` and `JWT_SECRET`
- Missing vars log a warning in development, exit with error in production

### 🟢 Cleanup: Removed Unused `TENANT_PRISMA` Token

- `TENANT_PRISMA` injection token was declared in `PrismaService` but never used
- Removed the unused export and cleaned up imports (`REQUEST`, `Scope`, `Inject`, etc.)

### 🟢 Cleanup: Idempotency Cleanup Script

- New `packages/database/scripts/cleanup-expired-idempotency.ts`
- Deletes expired idempotency records to prevent unbounded table growth
- Added `npm run db:cleanup` root script
- Should be run as a scheduled job (cron) in production

### 🟢 Cleanup: Fixed Health Controller Test

- Simplified from NestJS Test module to direct construction
- Removed fragile guard override that wasn't working

## New Files

- `apps/api/src/common/domain-exception.filter.ts` — Global DomainError → HTTP filter
- `apps/api/src/modules/core/party/party.dto.ts` — class-validator DTOs for party endpoints
- `packages/database/scripts/cleanup-expired-idempotency.ts` — Expired record cleanup

## Modified Files

- `packages/database/src/rls-extension.ts` — Intercept `$transaction` to inject SET LOCAL
- `apps/api/src/app.module.ts` — Added APP_FILTER registration
- `apps/api/src/main.ts` — Added env var validation
- `apps/api/src/modules/core/party/party.controller.ts` — Uses DTOs instead of plain types
- `apps/api/src/modules/core/party/party.service.ts` — Typed `toPartyResult`, removed `any`
- `apps/api/src/auth/tenant.guard.ts` — Singleton scope, uses ExecutionContext
- `apps/api/src/prisma/prisma.service.ts` — Removed unused TENANT_PRISMA + imports
- `apps/api/src/common/errors.ts` — Fixed MISSING_SUBTYPE_DATA → 422, added docs
- `apps/api/src/mcp/tools/party-tools.ts` — Required idempotencyKey on write tools
- `packages/database/prisma/schema.prisma` — Added indexes on party_role, party_contact_mechanism
- `apps/api/src/health.controller.spec.ts` — Simplified test construction
- `package.json` — Added `db:cleanup` script

## New Dependencies

- `apps/api`: class-validator, class-transformer

---

### 🔒 Critical: RLS Wired Into the Application

**Problem:** `PartyService` used the admin PrismaClient directly, filtering by `tenantId`
in `WHERE` clauses (application-level filtering). The RLS policies existed in the database
but were never exercised by the running application.

**Fix:**
- `PrismaService` now manages TWO connections:
  - `admin` — the superuser client (for migrations, audit, idempotency records)
  - `appClient` — the non-superuser client (subject to RLS)
- New `tenantScoped(tenantId)` method returns an RLS-enforced PrismaClient via `createTenantClient()`
- `PartyService` now uses `this.prisma.tenantScoped(tenantId)` for all domain operations
- Application-level `where: { tenantId }` filters retained as defense-in-depth

### 🔒 Critical: JWT Authentication Added

**Problem:** REST endpoints accepted `x-tenant-id` as a plain header with zero auth.
Anyone could access any tenant's data.

**Fix:**
- New `AuthModule` with `@nestjs/jwt` + `@nestjs/passport` + `passport-jwt`
- `JwtStrategy` validates tokens, extracts `{ sub, tenantId, role, agentId }`
- `JwtAuthGuard` applied globally via `APP_GUARD` — all endpoints require JWT
- `@Public()` decorator for health endpoints
- `TenantGuard` extracts `TenantContext` from JWT claims → `req.tenantContext`
- `PartyController` reads tenant from authenticated user, no more `x-tenant-id` header
- JWT_SECRET env var required (fails in production if missing)

### 🔒 Critical: `.env` and `dist/` Removed from Git Tracking

- Verified `.gitignore` properly excludes `.env`, `.env.local`, and `dist/`
- No tracked sensitive files found (already properly gitignored)

### 🛡️ Significant: Custom Domain Error Classes

**Problem:** Services threw `new Error("CODE: message")` strings, parsed by
`errorHandlerMiddleware` via fragile `indexOf(": ")` pattern matching.

**Fix:**
- New error classes in `@besterp/shared`: `DomainError`, `MissingSubtypeDataError`,
  `InvalidTypeValueError`, `DuplicateEntityError`, `EntityNotFoundError`, `ConcurrencyError`
- Each carries `code`, `message`, `suggestedTools`, and `context`
- `errorHandlerMiddleware` checks `isDomainError()` before falling back to Prisma/legacy patterns
- `PartyService` uses typed error classes throughout

### 🛡️ Significant: Idempotency Race Condition Fixed

**Problem:** Check-then-insert pattern in `idempotencyMiddleware` had a race window
where two concurrent requests with the same key could both create pending records.

**Fix:**
- Uses `prisma.idempotencyRecord.upsert()` for atomic check-or-create
- Only one concurrent request wins the create; others see the existing record

### 🛡️ Significant: `hashInput()` Determinism Fixed

**Problem:** `JSON.stringify(input)` doesn't guarantee key ordering.
`{ a: 1, b: 2 }` vs `{ b: 2, a: 1 }` produced different hashes.

**Fix:**
- New `sortKeysDeep()` helper recursively sorts object keys
- `hashInput()` now produces deterministic hashes regardless of key insertion order
- Added 2 new unit tests confirming key-order independence

### 🧹 Cleanup: Dead Code Removed

**Problem:** `tenantScopeExtension` in `@besterp/database` used `Prisma.defineExtension()`
with a `tenantScoped()` method that always threw an error at runtime.

**Fix:**
- Removed the misleading extension; `createTenantClient()` (Proxy-based) is the only API
- Simplified `@besterp/database` public API to just `createTenantClient`
- Added `"main"` and `"types"` fields to `packages/database/package.json`

### 🧹 Cleanup: Audit Middleware Uses Admin Client Explicitly

- `McpModule` now passes `this.prisma.admin` to audit/idempotency middleware
- Makes it explicit that these operations bypass RLS (intentional for cross-tenant audit)

---

## New Files

- `apps/api/src/auth/auth.module.ts` — JWT auth module
- `apps/api/src/auth/jwt.strategy.ts` — Passport JWT strategy
- `apps/api/src/auth/jwt-auth.guard.ts` — Global JWT guard with @Public() support
- `apps/api/src/auth/public.decorator.ts` — @Public() decorator
- `apps/api/src/auth/tenant.guard.ts` — Extracts tenant context from JWT
- `apps/api/src/common/tenant-context.ts` — TenantContext interface
- `apps/api/src/common/errors.ts` — HTTP error mapping utilities

## Modified Files

- `apps/api/src/app.module.ts` — Added AuthModule, global guards
- `apps/api/src/main.ts` — Added ValidationPipe, JWT_SECRET check
- `apps/api/src/health.controller.ts` — Added @Public() decorator
- `apps/api/src/prisma/prisma.service.ts` — Dual-client (admin + app/RLS), tenantScoped()
- `apps/api/src/modules/core/party/party.service.ts` — RLS client + typed errors
- `apps/api/src/modules/core/party/party.controller.ts` — JWT auth, no x-tenant-id
- `apps/api/src/mcp/mcp.module.ts` — Explicit admin client for middleware
- `packages/shared/src/errors.ts` — Added DomainError hierarchy + kept richError
- `packages/shared/src/crypto.ts` — Deterministic key sorting
- `packages/shared/src/index.ts` — Updated exports
- `packages/database/src/rls-extension.ts` — Removed dead extension, kept createTenantClient
- `packages/database/src/index.ts` — Simplified exports
- `packages/mcp-tools/src/middleware/idempotency.ts` — Atomic upsert
- `packages/mcp-tools/src/middleware/error-handler.ts` — DomainError support
- `.env.example` — Added JWT_SECRET
- `.env` — Added JWT_SECRET (dev only)

## New Dependencies

- `apps/api`: @nestjs/jwt, @nestjs/passport, passport, passport-jwt, joi, @types/passport-jwt
