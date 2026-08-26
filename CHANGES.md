# BestERP — Security & Architecture Fixes

## Changes Applied (2026-08-26) — Code Review Round 176

### 🟡 `searchParties` pagination clamp propagated NaN/non-integers into Prisma `take`/`skip`

**Problem:** The clamp `Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT)` does not normalize garbage: `Math.max(NaN, 1)` is `NaN` and non-integers pass through. Both boundary layers reject these (REST `@IsInt/@Min/@Max`, MCP `z.number().int()`), but the service is the last line of defense for direct/internal callers — and every other out-of-contract field there produces a structured `InvalidTypeValueError` (round-151/159 typeof-guard class). A direct caller passing `limit: NaN` or `limit: 12.5` instead handed Prisma a garbage `take`/`skip`; Prisma's client-side ValidationError carries no P-code, so `handleTransactionError` re-threw it unchanged and the caller saw an opaque 500 / MCP INTERNAL_ERROR.

**Fix:** New `requireIntegerPageParam` validates finite+integer before clamping (received value stringified in the error context when non-finite, since `JSON.stringify(NaN)` → null would erase it). Four regression tests added (NaN limit/offset, non-integer limit, Infinity offset).

### 🟡 `attachAuditWarning` wiped Map/Set/Date payloads and flattened class instances on the backpressure-drop path

**Problem:** The function exists to attach the audit-gap warning WITHOUT corrupting the payload, but its plain-object gate was only `typeof === "object" && !Array.isArray`. A `Map`, `Set`, or `Date` slipped through to the spread branch, where spreading yields `{}` (none of them own enumerable properties) — the ENTIRE tool payload was silently replaced by `{ _auditWarning }` exactly when the durable audit row had already been dropped. Class instances survived as own-property bags but lost their prototype/methods.

**Fix:** A prototype-based `isPlainObjectData` discriminator (same convention as truncate.ts's normaliseContainer / crypto.ts's sortObject) routes every non-plain object to the non-destructive wrapper branch `{ _auditWarning, data }`; null-prototype objects still merge. Five regression tests added (Map preserved by identity with entries intact, Set/Date wrapped, class-instance methods retained, null-prototype merges).

## Changes Applied (2026-08-26) — Code Review Round 175

### 🟡 Service-layer postal `country` validation diverged from boundaries and storage sanitizer

**Problem:** `PartyService.validatePostalAddressSubtype` validated the RAW trimmed country against the length cap and the uppercase-only ISO regex before any normalization. An HTML-wrapped code like `"<b>DE</b>"` was rejected as too long at the service while the same input succeeded on REST/MCP after their strip→uppercase transforms (round-170 divergence class), and lowercase `"de"` failed the uppercase-only regex although every other layer normalizes and stores it uppercased. A non-string `country` also crashed with a raw TypeError instead of a structured domain error.

**Fix:** Type-guard first, then strip HTML + normalize case BEFORE the length/format checks; emptiness is checked post-strip so HTML-only values are rejected as required. Four regression tests added.

## Changes Applied (2026-08-26) — Code Review Round 174

### 🔴 Non-string `idempotencyKey` envelope silently disabled idempotency protection (fail-closed contract violated)

**Problem:** `ToolRegistry.execute()` promotes the `idempotencyKey` envelope from raw tool input into the context under an explicit fail-closed contract: any present key must reach the idempotency middleware so out-of-contract keys are REJECTED, because silently dropping one disables deduplication for that call (a retry could duplicate the write). But the promotion gate required `typeof raw?.idempotencyKey === "string"` — a caller passing a numeric (`12345`), boolean, or object key had its envelope silently stripped by `stripPromotedIdempotencyKey()` while the write executed WITHOUT idempotency protection. The idempotency middleware's `validateIdempotencyKey` already validates the key as `unknown` and returns `INVALID_IDEMPOTENCY_KEY` for non-strings, so the safe behavior existed one layer down; the registry just never forwarded such values to it. Existing tests covered over-length and empty STRING keys only.

**Fix:** The promotion condition is now `raw?.idempotencyKey != null` (any present value), so non-string keys reach the middleware and fail closed with `INVALID_IDEMPOTENCY_KEY`. Regression tests added at both layers: registry-level promotion of a numeric key (and envelope still stripped from pipeline input for strict schemas), and middleware-level rejection of a non-string key without record creation or handler execution.

## Changes Applied (2026-08-26) — Code Review Round 173

### 🔴 Round-172 strict-schema change silently disabled idempotency for every idempotent tool call

**Problem:** Round 172 converted all tool input schemas to `z.strictObject` and added `stripPromotedIdempotencyKey` — but only in the registry's final Zod-validation step, which runs AFTER the idempotency middleware in the pipeline. That middleware computes its input hash via `definition.inputSchema.safeParse(input)` on the RAW pipeline input, which still carried the promoted `idempotencyKey` envelope — an undeclared key that `z.strictObject` rejects. Verified by probe: every idempotent call logged "Skipping idempotency … input failed Zod validation", no record was created, and a second identical call re-executed the handler (`replayed: undefined`) — exactly the duplicate-write risk idempotency exists to prevent, hitting precisely the calls that request protection. Existing middleware tests missed it because they use a permissive mock schema (`safeParse: () => ({success:true})`) rather than a real `z.strictObject`.

**Fix:** `ToolRegistry.execute()` strips the envelope once, before any middleware runs; the final-handler strip remains as belt-and-suspenders for pipelines invoked outside `execute()`. End-to-end probe confirms record creation (`pending` → `completed`) and replay of the second identical call without re-execution. Regression test uses a real `z.strictObject` schema.

### 🟡 `validateOptionalIdentityField` crashed on non-string context values instead of returning its structured error

**Problem:** The guard called `.trim()` BEFORE its own `typeof value !== "string"` check — making the check unreachable for exactly the values it was written to guard. A direct JS caller constructing `ToolContext` with `agentId: 123` threw a raw TypeError out of `execute()`, before any middleware was composed, so nothing converted it into the structured `INVALID_CONTEXT_ID` result.

**Fix:** Type-check first. Explicit `null` optional IDs are now treated as absent, consistent with `JwtStrategy.validateOptionalField` and McpService's `validateOptionalString` (both upstream of this boundary); `normalizedOptionalIdentityField` normalizes null→undefined too. Regression tests added.

## Changes Applied (2026-08-19) — Code Review Round 172

### 🔴 Schema/migration drift: 14 indexes declared in `schema.prisma` were never created by any migration

**Problem:** Every `@@index` added after the init migration (FK-support indexes like `party.party_type_id` and `*_parent_type_id`, audit-query indexes like `ai_action_log (tenant_id, created_at)`, cleanup indexes like `idempotency_record (status, expires_at)`, and `email_address (email)`) existed only in the schema — a fresh `migrate deploy` database did not match `schema.prisma`, so the next `prisma migrate dev` would emit a large surprise migration and production lacked the indexes (every FK check cascading to a seq scan). The repo already had two migrations fixing exactly this drift class.

**Fix:** Migration `20260819000000_add_schema_declared_indexes` creates all 14 with Prisma-convention names (`<table>_<columns>_idx`) and `IF NOT EXISTS`, matching the established style.

### 🔴 Naive ISO datetimes silently shifted stored dates by the host timezone

**Problem:** Per ES spec, `new Date("2024-06-15")` is UTC midnight but `new Date("2024-06-15T00:00:00")` (no offset) is LOCAL midnight — two semantically identical inputs differing by the host TZ offset (verified 8h on Asia/Taipei). `birthDate`, `registrationDate`, and role `fromDate` were all parsed with bare `new Date(value)`, so stored dates depended on the server's timezone and could shift by a day.

**Fix:** New shared helpers `normalizeISODateTimeToUTC` / `parseISODateTimeAsUTC` (exported from `@besterp/shared`) append `Z` to the naive-datetime form so every accepted form resolves to the same instant; all three parse sites in `party.service.ts` use them. `isValidISODate` computes its verdict on the normalized value. Regression tests added (meaningful on any host TZ).

### 🔴 `ai_action_log.user_id` nullable in the database but required in the schema

**Problem:** Same drift class as round-38's `tenant_id`: the init migration declared `user_id` TEXT (nullable) while `schema.prisma` mandates NOT NULL — the 20260718 migration closed only `tenant_id`. A `migrate deploy` database could accept NULL user_id audit rows the schema promises cannot exist, breaking audit attribution.

**Fix:** Migration `20260819000001_ai_action_log_user_id_not_null` (backfill `''` + `SET NOT NULL`, mirroring the 20260718 pattern).

### 🔴 Email/telecom duplicate pre-checks contradicted their own DB constraints

**Problem:** `@@unique([tenantId, email])` is tenant-scoped, but `checkEmailDuplicate` scoped its `findFirst` to the requesting party — an email already held by a *different* party in the tenant passed the pre-check, then the create tripped P2002 and surfaced the generic transaction-error message instead of the curated redacted-email error (caller-visible detail depended on which party held the address). Conversely, telecom had **no** DB constraint at all: `checkTelecomDuplicate` was a find-then-insert TOCTOU race with no backstop, unlike both sibling paths in the same transaction.

**Fix:** `checkEmailDuplicate` is now tenant-scoped (matching the constraint exactly), message updated to "already registered in this tenant". Telecom gets the same enforcement net email has: migration `20260819000003_telecom_number_tenant_unique` adds a denormalized `tenant_id` (backfilled from `contact_mechanism`, NOT NULL) plus `@@unique([tenantId, countryCode, areaCode, lineNumber])`; schema, RLS policy (own `tenant_id` check, mirroring email), service pre-check scope, and the nested create all updated. Tests updated/added for both.

### 🟡 RLS policy on `email_address` ignored the table's own `tenant_id` column

**Problem:** Every other tenant_id-bearing table enforces `tenant_id = current_setting('app.current_tenant')` in both `USING` and `WITH CHECK`; `email_address` only validated the parent contact mechanism. A buggy/legacy write could persist a row whose `tenant_id` disagrees with its owning tenant — silently occupying a slot in the `(tenant_id, email)` unique index while invisible to that tenant, producing unexplainable duplicate-email errors.

**Fix:** Both policy clauses now additionally require the row's own `tenant_id` to match (applied to `telecom_number` too, same rationale). Stale subtype-table header comment fixed.

### 🟡 Email unique index created under a non-Prisma name → permanent `migrate dev` drift

**Problem:** Migration 20260724 created `email_address_tenant_email_unique_idx`, but the schema's `@@unique([tenantId, email])` expects Prisma's generated name `email_address_tenant_id_email_key`. Prisma identifies indexes by name, so every `migrate dev` diff emitted DROP+CREATE churn for the index enforcing tenant-scoped email uniqueness.

**Fix:** Migration `20260819000002_rename_email_unique_index` renames it (`IF EXISTS`-guarded).

### 🟡 MCP silently stripped unknown input keys while REST rejected them

**Problem:** REST's ValidationPipe uses `forbidNonWhitelisted` (loud 400 on a typo'd field), but the MCP tool schemas were plain `z.object` — the identical payload "succeeded" with the field dropped, so an agent believed data was stored that never was. The registry now strips the promoted `idempotencyKey` envelope from raw input before validation (it lives in the context), so strictness does not break idempotent calls.

**Fix:** All tool input schemas (party + discovery, top-level and nested) converted to `z.strictObject`; unknown keys return `INVALID_INPUT`. Tests added (unknown top-level key, unknown nested key, idempotencyKey envelope still accepted).

### 🟡 Boot-time env validators were unreachable for the scenarios they describe

**Problem:** `AuthModule`'s `JwtModule.register({ secret: resolveJwtSecret() })` and `QueueModule.forRoot()` evaluate at module-load time; `main.ts` statically imported `AppModule`, so with `JWT_SECRET` missing in production (or Redis misconfigured) the process died during ESM evaluation with a raw import-time stack trace — the carefully-reasoned `validateJwtSecretPresence` / `validateRedisConfig` clean one-line exits never ran.

**Fix:** `main.ts` now dynamic-imports `AppModule` after `validateEnvironment()`, making the fail-fast contract authoritative. Also: the dev-mode `DATABASE_URL` warning described a degraded-boot posture that cannot occur (`PrismaService.initializeAppClient` throws unconditionally) — it is now a clean fatal error matching actual behavior.

### 🟡 Audit-drop warning could attach to the wrong response

**Problem:** `wasDropDetected()` read-and-reset a single process-global flag shared by all concurrent tool executions: when request A's audit write was dropped, an unrelated request B could consume the flag and carry the `_auditWarning`, while A's own response never did — under N drops at most one warning landed, on an arbitrary response.

**Fix:** `BackpressureManager.log()` now returns a per-entry handle (`wasDropped()`); queue-full drops are known synchronously and attributed exactly; slot-timeout drops flip the entry's own flag (best-effort) while keeping the stderr log as the durable signal.

### 🟡 Inconsistent idempotency-key retry guidance could double-execute writes

**Problem:** P2034/P2028 said "retry with the same idempotency key (do not use a new key)" while P2024, P1000–P1003/P1017, and the generic INTERNAL_ERROR path said "try again with a **new** idempotency key". P1017 (connection dropped mid-flight) is precisely the ambiguous-outcome case where a new key defeats idempotency — the original write may have committed, contradicting the key-hopping rationale documented in `idempotency.ts`.

**Fix:** All ambiguous-outcome messages now direct same-key retries.

### 🟢 Country code accepted non-letter values on every layer despite the documented ISO 3166-1 contract

**Problem:** All three layers enforced only length 2–3, so `"1A"` / `"A-"` passed REST, MCP, and the service and were stored as `country`.

**Fix:** New shared `COUNTRY_CODE_ISO_REGEX` (`/^[A-Z]{2,3}$/`) applied at all three layers (DTO `@Matches`, MCP `.regex()`, service check). Tests added.

### 🟢 `DomainExceptionFilter` array-message path omitted `stripHtmlTags`

**Problem:** The string-message path applied `stripHtmlTags(sanitizeForLogOutput(...))` but the array (ValidationPipe) path only ran `sanitizeForLogOutput`, which does not strip HTML — a validation message echoing markup reached clients verbatim while the string path stripped it.

**Fix:** Array map now applies both, matching the string path. Test added.

### 🟢 Seed tenants typed `ORGANIZATION` although the seed defines a `TENANT` type for them

**Problem:** The seed creates `pt-tenant` ("Automatically used when onboarding a new tenant organization") but seeded `tenant-acme`/`tenant-globex` as `pt-org` — `pt-tenant` was defined-but-unused and tenant detection by type returned nothing in a seeded database.

**Fix:** Seed tenants now use `pt-tenant` (upserts keep existing rows' type via `update: {}`).

### 🟢 `rls-setup.sql` superuser guard silently passed when `besterp_app` was missing

**Problem:** `IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'besterp_app')` evaluates to `IF NULL` → false when the role does not exist (create-roles.sql not yet run), so the "fail loudly at setup time" guard proceeded silently into a GRANT-free state.

**Fix:** The guard also fails when the role is missing.

### 🟢 `OPTIONAL_ID_PATTERN` did not reject zero-width/bidi characters despite its documented purpose

**Problem:** JS `\s` does not cover U+200B–200F, U+202A–202E, U+2060–206F, U+00AD, U+061C, U+FEFF — two visually-identical userIds both passed the auth gate and hashed to different idempotency composite keys.

**Fix:** These ranges added to the negated class. Also: `agentId`/`conversationId` were validated *untrimmed* while `userId` was accepted-after-trim (`" agent-1"` hard-rejected, `" user-1"` accepted) — optional identity fields are now trimmed and the trimmed values propagate (same contract as tenantId/userId). Tests added.

### 🟢 `EMAIL_REGEX` TLD rule was simultaneously too lax and too strict

**Problem:** The optional `(?:[a-zA-Z-]{0,61}[a-zA-Z])?` tail admitted non-existent hyphenated TLDs (`example.co-m`) while still rejecting the only legitimate hyphen+digit TLD family (punycode `xn--*`) — contradicting its own "alpha-only TLD" doc.

**Fix:** TLD is now strictly `[a-zA-Z]{2,63}`. Tests added.

### 🟢 Misc consistency

- `MAX_PHONE_COUNTRY_CODE_LENGTH` 5 → 4 (matches `COUNTRY_CODE_REGEX`: `+` + 1–3 digits; a 5-char code previously passed length pre-checks then failed the regex with a less specific error).
- `findSimilarNames` 2-char minimum now guards both sides of the stem-matching disjunct (a 1-char part previously matched any existing part containing it).
- `findSimilarNames`/dead-code: unused `_definition` parameter removed from `executeAndUpdate`.
- `test:watch` added to `@besterp/shared` and `@besterp/mcp-tools` (previously only `@besterp/database` had it).
- Deliberately kept: the `@deprecated sanitizeLogOutput` alias (3-line delegate, heavily covered by tests; removal is churn without functional benefit) and `postinstall: "prisma generate || true"` (CI installs without a DB — failures surface at typecheck instead).

## Changes Applied (2026-08-19) — Code Review Round 171

### 🟡 README quickstart never delivered `.env` values to the tools that need them

**Problem:** The "Getting Started" flow says `cp .env.example .env` at the repo root, but no downstream tool auto-loads that file: `npm run db:migrate` runs `prisma migrate dev` from `packages/database` and Prisma only auto-loads `.env` from the CWD/schema dir (verified: `P1012 Environment variable not found: DATABASE_URL` with only a root `.env`); `npm run db:seed` runs via `tsx`, which loads no `.env` (verified, tsx 4.23); and `docker compose up -d` from `docker/` reads `.env` from the compose project directory (`docker/`), so `${POSTGRES_PASSWORD}` & co. never resolved. A user following the README verbatim failed at step 5 with misleading tool errors.

**Fix:** The quickstart now exports the file once (`set -a; source .env; set +a`) with a comment explaining why — the shell environment propagates to compose interpolation and every npm/tsx/prisma child process, fixing all consumers with one step.

### 🟡 README quickstart seed step omitted the required `ALLOW_SEED=1` opt-in

**Problem:** Round 33 made `db:seed` refuse to run without `ALLOW_SEED=1` (it inserts hard-coded test tenants). CI was updated to set it, but the README was not — `npm run db:seed` exited with "Refusing to seed: ALLOW_SEED is not set to '1'."

**Fix:** The step is now `ALLOW_SEED=1 npm run db:seed` with a one-line rationale.

### 🟢 `.env.example` `CORS_ORIGINS` comment described the opposite of the actual behavior

**Problem:** The comment said "leave empty for wide-open dev mode", but an unset/empty `CORS_ORIGINS` falls back to a *restrictive* localhost allowlist in development (`DEV_LOCALHOST_ORIGINS`) and *aborts boot* in every non-development environment. The comment invited operators to rely on behavior that does not exist.

**Fix:** The comment now states the real contract (restrictive localhost fallback in dev; required elsewhere).

### 🟢 `.env.example` `JWT_EXPIRES_IN` did not document the boot-time constraints

**Problem:** `main.ts` exits at boot for zero-leading values (`0s`, `007d`) and lifetimes over 30 days (`MAX_JWT_EXPIRES_IN_DAYS`); the env file only mentioned the 24h default.

**Fix:** Both constraints are now documented next to the knob.

### 🟢 `tenant-context.ts` stale "or API key" comment

**Problem:** The header claimed the context is populated "from JWT claims or API key" — no API-key path exists anywhere; `TenantGuard` reads only the validated JWT user.

**Fix:** Comment now matches the code (JWT claims only).

## Changes Applied (2026-08-19) — Code Review Round 170

### 🟡 `add_contact_mechanism` `countryCode` strip-HTML parity — REST accepted what MCP rejected

**Problem:** The MCP `telecomNumberSchema.countryCode` transform only trimmed, while the REST `TelecomNumberDto.countryCode` strips HTML via `@optionalSanitizeTransform` (and every other MCP string helper strips it). An HTML-wrapped E.164 code like `"+44<script>alert(1)</script>"` was accepted on REST (sanitized to `"+44"`, within the cap after strip) but rejected on MCP (raw 27-char string exceeded the cap and failed the E.164 regex) — a silent cross-surface divergence, with MCP contradicting its own storage path (`sanitizeTelecomNumber`, `checkTelecomDuplicate`), which stores `"+44"`.

**Fix:** the MCP countryCode transform now strips HTML and normalizes HTML-only input to `undefined` (so the service default `'+1'` applies), matching REST exactly. The service's `validateTelecomSubtype` also now strips HTML *before* the length/E.164 regex checks (mirroring `validateEmailSubtype`'s strip-then-validate), so direct/internal callers no longer get rejected for input their own storage layer would sanitize to valid; the error message reports the stripped value actually validated. Four regression tests added (2 MCP, 2 service). No behavioural change for legitimate codes (`+1`, `+44`, …).

### 🟢 `rls-setup.sql` subtype-table comment inaccuracy

**Problem:** The comment claimed subtype policies join through the parent `party` table, but only `person`/`organization` do — `postal_address`/`telecom_number`/`email_address` join through `contact_mechanism`.

**Fix:** the comment now describes both accurately.

## Changes Applied (2026-08-16) — Code Review Round 151

### 🟡 `search_parties` advertised paginated pages that the offset ceiling makes unreachable

**Problem:** `hasMore` was `offset + limit < total` while `offset` is clamped to `MAX_SEARCH_OFFSET` (10,000) and both boundary layers reject `offset > 10000` (REST DTO `@Max`, MCP Zod `.max()`). A tenant with more than `MAX_SEARCH_OFFSET + limit` rows got `hasMore=true` forever, and every suggested next offset (REST `X-Next-Offset`, MCP hint) returned 400/`INVALID_INPUT` — a dead-end pagination loop.

**Fix:** `hasMore` is now `offset + limit < total && offset + limit <= MAX_SEARCH_OFFSET`, so the API stops advertising pages beyond the offset ceiling. Regression test added.

### 🟡 `search_parties` `roleType` filter matched terminated roles

**Problem:** `where.roles = { some: { roleType: {...} } }` matched any `party_role` regardless of `thruDate`, so a party whose only matching role had ended (e.g. a lapsed Customer) still appeared under that role filter — inconsistent with the active-role semantics the `party_active_role_unique` partial index establishes.

**Fix:** the `some` filter now requires `thruDate: null`, matching the domain's active-role semantics. Regression test asserts the where clause carries `thruDate: null`.

### 🟢 Non-string nested subtype fields threw raw `TypeError` from the service layer

**Problem:** `validatePersonData`/`validateOrganizationData` and the sanitize helpers called `.trim()` without a type guard on required/optional subtype fields (`firstName`, `lastName`, `legalName`, `middleName`, `gender`, `birthDate`, `registrationDate`). A direct/internal caller bypassing the REST DTO / MCP Zod strings — the exact "service is the last line of defense" scenario — passing e.g. `person: { firstName: 123 }` hit `TypeError: ...trim is not a function` → 500 `INTERNAL_ERROR` instead of the documented `InvalidTypeValueError`.

**Fix:** explicit `typeof` guards throw `InvalidTypeValueError` in both validators; sanitizers guard optional fields before `.trim()`.

### 🟢 Test-suite fixes: dead validator mirror, bare `toThrow()`s, unasserted claim

- `prisma.service.spec.ts`: the `@besterp/database` mock defined a hand-rolled `validateTenantIdEnhanced` throwing `InvalidTypeValueError`, but `PrismaService` imports and calls `validateTenantIdEnhancedForAuth` from `@besterp/shared` (real, throws `InvalidTenantIdError`) — the mock was dead and its contract had silently diverged, invisible behind a bare `toThrow()`. Removed the dead mock; pinned the test to `InvalidTenantIdError`.
- `mcp.module.spec.ts`: the empty-tenant-ID test used bare `toThrow()`; pinned to `InvalidTenantIdError` + message regex (matching the adjacent null-tenant test).
- `party.service.spec.ts`: the "ensure toPartyResult not called" test asserted only `rejects.toThrow`; added a spy asserting `toPartyResult` is not called.

## Changes Applied (2026-08-14) — Code Review Round 150

### 🟡 Audit-log middleware silently dropped durable rows for tools with no data/input (Prisma Json null handling)

**Problem:** `logAction` passed `truncateValue(...)` results straight into `aiActionLog.create`. A successful tool with no `data` produced `toolOutput: null`, and a tool invoked with no input produced `toolInput: undefined` — both rejected by Prisma for `Json` columns ("Provided Json null, expected JsonNull or DbNull"), so the create threw and the fire-and-forget catch dropped the audit row for every such call. `idempotency.ts` already used the correct sentinels for the identical situation.

**Fix:** `toolInput` (required column) maps null/undefined to `Prisma.JsonNull`; `toolOutput` (nullable) maps to `Prisma.DbNull`, mirroring idempotency.ts. Also converted the `type Prisma` import to a value import — the sentinels were a runtime `ReferenceError` before (caught by the new regression test).

### 🟡 CI `test` job failed before migrations (Prisma schema not found) and cached a non-existent client path

**Problem:** `npx prisma migrate deploy` ran from the repo root where Prisma cannot find `packages/database/prisma/schema.prisma`; the job exited non-zero before roles/RLS/seed/tests. Both Prisma-client cache steps cached `packages/database/node_modules/.prisma`, which is never populated under npm workspace hoisting (the client generates into the root `node_modules/.prisma`).

**Fix:** migrations now run via `npm run migrate:deploy --workspace=@besterp/database`; cache paths corrected to `node_modules/.prisma`.

### 🟡 Contact-mechanism cross-subtype data was silently discarded by the service layer

**Problem:** `validateContactMechanismSubtype` validated only the required subtype; a POSTAL_ADDRESS request also carrying `emailAddress` passed validation and the extra object was dropped by the transaction's type gates — the caller believed data was stored that never was. Both boundary layers and the party-type equivalent (`validateCreatePartySubtype`) reject this.

**Fix:** mismatched subtype objects now throw `InvalidTypeValueError` (unknown types rejected first with the actionable "valid types" error); per-subtype validators extracted (`validatePostalAddressSubtype`/`validateTelecomSubtype`/`validateEmailSubtype`) to respect the complexity cap. Two regression tests added.

### 🟡 Whitespace-only optional strings behaved differently per surface (REST 422 vs MCP success; MCP search silently widened)

**Problem:** Optional value fields (`description`, `countryCode`, …) got 422 on REST but succeeded on MCP; MCP `search_parties` with a whitespace-only `name` silently dropped the filter and returned the unfiltered listing while REST 422'd via `requireNonEmptyFilter` — whose regression test explicitly forbids silent widening.

**Fix:** (a) REST DTO gains `optionalSanitizeTransform` — optional value fields that sanitize to empty become `undefined`, matching MCP's `optionalFilteredString`; (b) MCP search filters use the new `optionalSearchFilterString`, which REJECTS whitespace-only values at the schema layer, matching the service contract both surfaces share. New `party.dto.spec.ts` (9 tests); 2 party-tools tests updated.

### 🟡 Redis health probe authenticated with the untrimmed REDIS_PASSWORD

**Problem:** `QueueModule.resolvePassword` trims; the probe sent the raw value — a whitespace-padded password connected fine on the queue while `/api/health` reported `redis: "disconnected"` forever (WRONGPASS). Host/port were already aligned with the queue; password was the last unaligned knob.

**Fix:** The probe trims exactly like the queue.

### 🟡 Stale spikes: dead `richError` import and pre-composite-PK idempotency selectors

**Problem:** `packages/mcp-tools/spikes/server.ts` imported `richError` from `@besterp/shared` (removed when the DomainError hierarchy landed), crashing at module load, and both it and `packages/database/spikes/spike-rls.ts` used `where: { idempotencyKey }` selectors invalid since the `idempotency_composite_pk` migration — `npm run dev` / `npm run spike:rls` died mid-run, undetected because spikes were excluded from every check.

**Fix:** composite `idempotencyKey_tenantId` selectors; spike-local `richError` helper preserving the agent-facing shape; corrected usage header. Spikes are now typechecked via `tsconfig.scripts.json` in both packages (`spikes/server.ts` excluded — MCP SDK tool registration with inline Zod costs >4 GB compiler heap; `test-agent.ts` checks in 1.6 s).

### 🟡 Idempotency cleanup: comment promised a composite-index raw delete, code ran the OR-array it dismissed

**Problem:** Load-bearing comment justified raw SQL ("ORM deleteMany with an OR array … can degrade to a full table scan") directly above that exact ORM OR-array — the class of comment/code drift that previously broke this script twice.

**Fix:** Implemented the documented approach: `DELETE … USING (VALUES …)` row comparison hitting the composite PK, fully parameter-bound via `Prisma.sql`.

### 🟢 SuggestedTools — the last unsanitized agent-facing field

`error-handler.ts` and `DomainError.toJSON` sanitized `code`/`message`/`context` but echoed `suggestedTools` verbatim; both now map every entry through `sanitizeForLogOutput` (regression tests added).

### 🟢 tool-registry: fabricated `received` and discarded trimmed identity

`sanitizeIssues` no longer fabricates `received: "[REDACTED]"` for missing-value issues on sensitive paths. `validateContextIdentity` now returns the normalized (trimmed) tenantId/userId and `execute` propagates them — previously the untrimmed context keyed the idempotency record under a different tenant string than the RLS query used, so a correctly-trimmed retry re-executed the write (regression test added).

### 🟢 Idempotency contention message invited key-hopping

P2034-exhaustion told agents to "retry with a new idempotency key" while its own comment correctly noted a new key won't help and bypasses idempotency. The message now instructs waiting and retrying the same key.

### 🟢 Consistency and ambiguity cleanup

`main.ts parsePort` fail-fast like the other boot knobs; `TenantGuard` missing `req.user` → 401 with diagnostic (was generic 403); `health.service.ts` overallStatus comment aligned with code; `sanitizeTelecomNumber` uses the exported `DEFAULT_PHONE_COUNTRY_CODE`; `decodeCommonEntities`/`withTenant`/`setTenantContext` comments match actual behavior; dead `BackpressureManager.getStats()` + phantom `getErrorStats` reference removed; misleading "strip HTML" identity test in `mcp.module.spec.ts` renamed to describe the actual charset-rejection contract.

## Changes Applied (2026-08-14) — Code Review Round 143

### 🟡 Audit-log middleware lost all error detail for soft-failure results (the real production error path)

**Problem:** In the compiled MCP pipeline the OUTERMOST `errorHandlerMiddleware` converts every thrown error (Zod validation, domain, Prisma) into a non-thrown `{ success: false }` ToolResult. The audit middleware in `packages/mcp-tools/src/middleware/audit-log.ts` only persisted error detail in its own throw branch, so for the common failure modes it stored `toolOutput: null` — the durable `ai_action_log` trail recorded no indication of why any action failed.

**Fix:** The soft-failure branch now persists `{ error: { message, code } }`, mirroring the throw branch: both fields are run through `sanitizeForLogOutput` + `capString`/`MAX_SOFT_FAILURE_MESSAGE_SIZE`, and `code` is redacted to `[REDACTED]` at the durable sink the same way as the throw branch. The shaping logic was extracted into `formatSoftFailureOutput` to keep `executeAndLog` within the lint complexity cap. Added 2 regression tests (stored shape + DB connection-string scrub on the soft-failure path).

### 🟢 `get_type_table_values` queried type tables without an ORDER BY (non-deterministic row order)

**Problem:** `apps/api/src/mcp/tools/discovery-tools.ts` ran `findMany` on the admin-curated type tables with no `orderBy`, so Postgres returned rows in unspecified (heap/insertion) order — the same "valid values" call could present the vocabulary in a different order per call, and durable audit snapshots could differ.

**Fix:** Added `orderBy: { name: "asc" }` (total and stable, since `name` is `@unique`/never null) and widened the intentionally-narrow `PrismaModelDelegate.findMany` interface to accept `orderBy`. Added 1 regression test asserting deterministic ordering across all three type tables.

## Changes Applied (2026-08-14) — Code Review Round 142

### 🟡 Dependency audit — 15 known vulnerabilities (1 critical) reduced to 0

**Problem:** `npm audit` reported 15 vulnerabilities, including one critical and three high-severity advisories in the runtime dependency chain:

1. **Critical — `vitest@3.2.4`** (all workspaces, dev dependency): advisory for the vitest UI server allowing file reads outside the workspace root.
2. **High — `multer@2.1.1`** (runtime, via `@nestjs/platform-express@~11.0.0`): DoS via crafted multipart parsing.
3. **Moderate — `qs@6.15.1`** (runtime, via `express@5.2.1`/`body-parser@2.2.2`): DoS via deep/large query-string parsing.
4. **Transitive dev-chain issues**: `vite@7.3.3` → `postcss@8.5.14` → `nanoid@3.3.12` (moderate, via `vitest`); `@nestjs/cli` → `js-yaml@4.1.1`; `@modelcontextprotocol/sdk` → `express-rate-limit@8.5.1` → `ip-address@10.2.0` (high).

**Fix:**
- Bumped `@nestjs/platform-express` to `^11.1.29` (resolves to `multer@2.2.0`, fixing the high-severity DoS) and `vitest` to `^3.2.7` in all four workspaces (fixes the critical advisory).
- Added root `overrides` pinning the transitive fixes: `qs@6.15.3`, `ip-address@10.5.0` (via `express-rate-limit@8.6.2`), `js-yaml@4.3.1`, `vite@7.3.6`, `postcss@8.5.26`, `nanoid@3.3.18`.
- Regenerated the lockfile (the overrides do not apply to the existing `package-lock.json` without a clean reinstall).
- Verified resolved versions in `npm ls` and re-ran the full suite: **`npm audit` → 0 vulnerabilities**, lint ✓, typecheck ✓, 418 api tests still passing.

## Changes Applied (2026-08-13) — Code Review Round 138

### 🟡 `apps/api/src/auth/jwt.strategy.ts` — `validateTenantId` catch swallowed the original error message

**Problem:** The catch block re-threw as `UnauthorizedException("Invalid token: tenantId failed format validation.")` with no context about *why* validation failed (e.g. whether the cause was an `INVALID_TENANT_ID` vs a charset mismatch). This was inconsistent with `tenant.guard.ts`, which round 133 already fixed to include the original message in the exception. Operators reading client-facing errors could not distinguish between different tenant-validation failure modes.

**Fix:** Included `msg` in the `UnauthorizedException` to match the `tenant.guard.ts` pattern (`Invalid token: tenantId failed format validation. ${msg}`). Added a regression test asserting the original cause is present in the thrown exception.

## Changes Applied (2026-08-13) — Code Review Round 135

### 🟡 `apps/api/src/health.service.ts` — missing `REDIS_PORT` in non-dev violated the documented "never throws" probe contract

**Problem:** `runRedisProbe` threw on a missing `REDIS_PORT` in non-development, contradicting its own doc comment and `probeRedis`'s promise that the probe "never throws" and warns-and-skips on a missing or invalid port. When that path fired, `getHealth()` rejected and `/api/health` + `/api/health/ready` returned a bare 500 (masked as a generic error in production) instead of the documented structured status body with the Redis warning — an inconsistency with the invalid-port branch, which already warns once and reports `"disconnected"`.

**Fix:** The missing-port path now matches the invalid-port branch: warn once and skip the probe, reporting `"disconnected"` (not `"not_configured"`) so the health payload still flags the misconfiguration. QueueModule's boot-time port validation remains the real fail-closed gate that keeps a misconfigured deploy from starting, so startup enforcement is unchanged. Added a regression test (`NODE_ENV=staging`, `REDIS_HOST` set, `REDIS_PORT` unset → no socket opened, redis `"disconnected"`, warning present).

### 🟢 `apps/api/src/modules/core/party/party.service.ts` — `searchParties` offset pagination non-deterministic for tied `createdAt`

**Problem:** `orderBy: { createdAt: "desc" }` alone leaves rows sharing an identical `createdAt` (timestamp(3), millisecond precision) in an arbitrary DB order. Bulk and concurrent inserts routinely share a timestamp, so offset pagination could return duplicate or skipped parties across pages each time the DB chooses a different order among tied rows.

**Fix:** Added `{ partyId: "asc" }` as a deterministic tiebreaker (`orderBy: [{ createdAt: "desc" }, { partyId: "asc" }]`), making offset pagination total and stable. Added a regression test asserting the ordering is passed to `findMany`.

## Changes Applied (2026-08-12) — Code Review Round 134

### 🟢 `packages/database/scripts/cleanup-expired-idempotency.ts` — misleading leading-underscore variable names

**Problem:** The convention `const _foo = ...` signals "intentionally unused" to both TypeScript (`noUnusedLocals`), ESLint (`varsIgnorePattern: "^_"`), and human readers. The cleanup script used `_ADVISORY_LOCK_KEY` (referenced in two SQL interpolations) and `_unlockResult` (silenced by `void`) — both were live variables whose underscore prefixes were misleading.

**Fix:** Renamed to `ADVISORY_LOCK_KEY` and `unlockResult`. No behavioural change.

## Changes Applied (2026-08-12) — Code Review Round 133

### 🟡 `apps/api/src/main.ts` — CORS origins accepted arbitrary strings without format validation

**Problem:** `parseAllowedOrigins()` split `CORS_ORIGINS` and returned every non-empty token verbatim, so a typo like `CORS_ORIGINS=evil.com` (missing the `https://` scheme) would enable cross-origin requests unconditionally.

**Fix:** Added a post-parse check that flags any origin not matching a URL-like pattern (`https?://...`) with a boot-time `logger.warn`. Validation remains permissive (we do not reject, only warn) so genuine origins that use unusual schemes are not blocked, but a mistyped or omitted scheme is immediately visible in operator logs.

### 🟡 `apps/api/src/mcp/tools/party-tools.ts` — tool description used an invalid UUID example

**Problem:** The `add_party_role` description example showed `partyId: "abc-123"`, which does not match `UUID_REGEX` and would confuse agents that treat the example as a template.

**Fix:** Replaced with a valid UUID (`550e8400-e29b-41d4-a716-446655440000`) so the example is structurally correct.

### 🟡 `apps/api/src/auth/tenant.guard.ts` — `validateTenantId` swallowed the original error message

**Problem:** The `catch` block re-threw as `UnauthorizedException("TenantGuard: tenantId failed format validation.")` with no context about *why* validation failed, making debugging token issues harder for operators.

**Fix:** The catch now includes the sanitized original message in the `UnauthorizedException`, giving both the guard label and the specific cause.

### 🟢 `packages/database/scripts/cleanup-expired-idempotency.ts` — advisory lock key was a local literal

**Problem:** The cleanup script defined `const _ADVISORY_LOCK_KEY = 0x626573746572` locally. If another script ever needed the same lock it would have to re-derive the value, creating drift risk.

**Fix:** Exported `ADVISORY_LOCK_KEY_CLEANUP_IDEMPOTENCY` from `@besterp/shared/constants.ts` with full documentation of the value's origin and constraints, and imported it in the cleanup script.

### 🟢 `packages/shared/src/sanitize.ts` — `sanitizeForLogOutput` pipeline was a 10-deep nested call chain

**Problem:** Each reduction step was a function call nested inside another, making the pipeline hard to read, extend, or test independently.

**Fix:** Extracted the pipeline into a named `Array<(s: string) => string>` and reduced over it. Behaviour is identical; the change is structural for maintainability.

## Changes Applied (2026-08-08) — Code Review Round 114

### 🟢 `apps/api/src/modules/core/party/party.service.ts` — dead fabricated-timestamp fallbacks on `fromDate`

**Problem:** `PartyRole.fromDate` is `NOT NULL` in the schema (DB default `now()`), so two `?? new Date().toISOString()` fallbacks were unreachable — and silently fabricated timestamps if the invariant ever drifted (same dead-fallback class removed in rounds 108–109).

**Fix:** Removed both fallbacks (`addPartyRole` result mapping and the `addPartyRoleTransaction` duplicate-error path). A `null` `fromDate` now fails loudly with a `TypeError` instead of inventing data; comments document the NOT NULL invariant. Added 3 regression tests (DB-stored `fromDate` returned verbatim; null `fromDate` rejects loudly; duplicate error reports the existing role's real DB `fromDate`).

### 🟡 `apps/api/src/main.ts` — middleware order left 429/preflight responses without `x-request-id`

**Problem:** The request-ID middleware ran after helmet, the health-aware rate limiter, and CORS. Body-parser 413/400 responses carry the header, but rate-limited 429s and CORS preflight OPTIONS short-circuited before the middleware — so the abusive traffic you most want to correlate lacked a request ID.

**Fix:** Moved the request-ID middleware directly after helmet (kept first for security headers), before the limiter and CORS, so every early-exit response carries the correlation header.

## Changes Applied (2026-08-08) — Code Review Round 113

### 🟡 `apps/api/src/mcp/tools/discovery-tools.ts` — `list_available_tools` `entity` filter silently returned an empty list for whitespace-only input

**Problem:** A whitespace-only `entity` (`"   "`) passed the old schema (`z.string().max(64).optional()` — no trim, no empty normalization), then the handler trimmed it to `""` and compared `"" === (t.entity ?? "")`. Every tool declares a non-empty entity, so that comparison never matches and the tool returned zero results — silently narrowing the listing to nothing. This is the exact footgun round 107 removed from `optionalFilteredString`, where a whitespace-only optional filter means *no filter*.

**Fix:** The schema now mirrors `optionalFilteredString` (`z.string().optional().transform()` trims and maps empty/whitespace-only to `undefined`, `.pipe(z.string().max(64).optional())` caps length on the TRIMMED value). A whitespace-only `entity` now returns all tools, and surrounding whitespace is trimmed before matching. Added 2 regression tests.

### 🟡 `apps/api/src/main.ts` — unbounded `app.close()` on the listen-failure path could leave a half-initialized process running

**Problem:** The `catch` around `app.listen()` awaited `app.close()` with no hard-exit bound, while `gracefulShutdown` bounds teardown with an unref'd hard-exit timer. If teardown hung after a listen failure (e.g. a stuck database connection pool), the process would never exit.

**Fix:** Extracted `closeWithTimeout(app, label, timeoutMs)` — hard-exit timer + `unref()` + `finally` clear, close errors propagating to the caller — and used it in both `gracefulShutdown` (identical behaviour, logic now shared) and the listen-failure path (same `HARD_EXIT_TIMEOUT_MS` default).

## Changes Applied (2026-08-07) — Code Review Round 107

### 🟡 `apps/api/src/bootstrap-config.ts` — whitespace-only `HARD_EXIT_TIMEOUT_MS` parsed as an explicit `0` → instant forced exit on shutdown

**Problem:** `resolveHardExitTimeoutMs` only skipped `undefined`/`""` values; `Number("  ")` is `0`, so a whitespace-only `HARD_EXIT_TIMEOUT_MS` (a config typo) resolved to `0`. `main.ts` then installed a 0ms hard-exit timer and the first shutdown signal fired `process.exit(1)` immediately — silently destroying graceful shutdown (in-flight requests killed). This is the exact damage class round 88 closed for negative values (Node clamps a negative `setTimeout` delay to 1ms), and contradicts round 106's "whitespace-only = unset" convention for numeric env knobs (`PRISMA_CLIENT_CACHE_SIZE`). A non-string falsy `raw` (`HARD_EXIT_TIMEOUT_MS=0` from Docker) also reached `raw.trim` and threw — a fatal boot crash.

**Fix:** `resolveHardExitTimeoutMs` trims the raw value first so a whitespace-only value is treated as unset → the 10s default; a `" 25000 "`-style padded value parses normally. `resolveTrustProxyHops` gets the same trim (its result is unchanged — `Number("  ")` was already 0 — but the intent is now explicit and identical to its sibling). `parsePositiveInteger` is deliberately left fail-loud on whitespace: a rate-limit/JSON-PARSE-INPUT knob is a security control where a set-but-invalid value must abort boot (round 88), whereas a whitespace `HARD_EXIT_TIMEOUT_MS` must not silently become the destructive 0. Added 3 regression tests.

### 🟢 `apps/api/src/mcp/tools/party-tools.ts` — `optionalFilteredString` length-checked the RAW untrimmed string, rejecting padded-but-valid values the rest of the stack accepts

**Problem:** `optionalFilteredString` ran `.max(max)` on the raw input BEFORE the trim+strip transform, so an optional field (`description`, `middleName`, `gender`, `taxId`, `addressLine2`, …) of exactly `max` chars plus trailing whitespace was rejected — while the required-field helper `sanitizedString` and the service layer (`PartyService.requireMaxLength`, which trims first) both accept it. A cross-surface inconsistency of the same class round 50 closed for email.

**Fix:** Removed the pre-transform `.max()`; the `.pipe(z.string().max(max).optional())` enforces the cap on the trimmed/stripped value, matching `sanitizedString` and the service layer. DoS resistance is unchanged — `stripHtmlTags` enforces its own 100 KB input cap before any length check runs. Added 2 regression tests (a 1000-char `description` + trailing space accepted and normalized to 1000 chars; a genuinely-over-max 1001-char value still rejected with `INVALID_INPUT`).

## Changes Applied (2026-08-04) — Code Review Round 89

### 🟡 `apps/api/src/main.ts` — `trust proxy` never configured; rate limiter keyed on the proxy IP and logged `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on every proxied request

**Problem:** The app never called `app.set("trust proxy", …)`, so behind any reverse proxy / load balancer (which always appends `X-Forwarded-For`) two things happened, verified by reproducing against the installed `express-rate-limit@8.5.1`:
1. The limiter's default `keyGenerator` validation (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`) **logged a full error with stack trace on every proxied request** — a log-flood/noise DoS that drowns out real errors.
2. `req.ip` resolved to the proxy/LB address, so **every client behind a given proxy shared one rate-limit bucket**: a single abusive caller throttled the whole proxy, and per-IP limits were effectively unenforced for everyone else.

**Fix:** Added a pure resolver `resolveTrustProxyHops` to `bootstrap-config.ts` reading `TRUST_PROXY_HOPS` (default `0` = current fail-closed behavior, max `10`, fails fast on a non-integer/negative/out-of-range value). When set, `main.ts` applies `app.set("trust proxy", N)` and warns at boot that every proxy in front MUST overwrite inbound `X-Forwarded-For` headers. Numeric hop counts are used (never `trust proxy: true`) so a directly-connected client cannot spoof the header — but the knob is opt-in and only correct when the deployment genuinely has N proxies in front. Documented in `.env.example`. Added 5 regression tests.

### 🟢 `apps/api/src/health.service.ts` — a typo'd `REDIS_PORT` surfaced as a misleading "Redis disconnected" state

**Problem:** `Number(process.env.REDIS_PORT || 6380)` with `REDIS_PORT=abc` → `NaN`, and `socket.connect(NaN, host)` throws `ERR_SOCKET_BAD_PORT`, which the catch swallowed as the generic "Redis health check failed" warning — hiding a config typo. QueueModule already fails fast on an invalid port; the health surface was the gap.
**Fix:** Extracted the probe into a private `probeRedis()` method (also keeping `getHealth` complexity within the lint budget). The port is validated before probing: an invalid value logs a clear once-per-process warning and reports `"disconnected"` (not `"not_configured"`) so the health payload's redis warning still surfaces. Regression test added (mocked `node:net`/`node:tls`).

### 🟢 `apps/api/src/auth/tenant.guard.ts` — `agentId` lacked a length cap at the auth boundary

**Problem:** `validateUserId` enforced `MAX_USER_ID_LENGTH` and `JwtStrategy` enforces `MAX_AGENT_ID_LENGTH`, but `TenantGuard.validateAgentId` only checked the charset. An over-length `agentId` that slipped past the strategy would reach `TenantContext` unchanged.
**Fix:** Added the `MAX_AGENT_ID_LENGTH` cap (201+ chars → 401), mirroring the strategy, so `TenantContext` is length-safe by construction. Regression test added.

## Changes Applied (2026-08-04) — Code Review Round 88

### 🟡 `apps/api/src/main.ts` — `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_PER_WINDOW` unvalidated (a typo silently disabled rate limiting)

**Problem:** The rate limiter read `Number(process.env.RATE_LIMIT_WINDOW_MS)` / `Number(process.env.RATE_LIMIT_MAX_PER_WINDOW)` with no validation. A misconfigured value like `RATE_LIMIT_MAX_PER_WINDOW=abc` parsed to `NaN`, which silently disabled the brute-force/MCP-exhaustion protection the limiter provides (the `count > max` comparison is always false against `NaN`). Every other env knob (`PORT`, `JWT_EXPIRES_IN`, `JWT_SECRET`) fails fast at boot with a clear message; these two did not.
**Fix:** Resolved the config up front in `bootstrap()` via a new pure helper module `apps/api/src/bootstrap-config.ts` (`resolveRateLimitConfig`). A set-but-invalid value (non-positive, non-integer, or `NaN`) now aborts boot with `Invalid RATE_LIMIT_WINDOW_MS/MAX_PER_WINDOW "…". Must be a positive integer.` Extracted to a side-effect-free module so the logic is unit-testable without executing `bootstrap()`. Added 6 regression tests.

### 🟡 `apps/api/src/main.ts` — negative `HARD_EXIT_TIMEOUT_MS` silently destroyed graceful shutdown

**Problem:** `Number.isFinite(rawTimeout)` accepts negative numbers, and Node clamps negative `setTimeout` delays to 1 ms — so a typo like `HARD_EXIT_TIMEOUT_MS=-30` made the hard-exit timer fire almost immediately on any shutdown, silently converting graceful shutdown into an instant forced exit (in-flight requests killed).
**Fix:** `resolveHardExitTimeoutMs` (same module) now accepts only a non-negative finite number of milliseconds (`0` remains a legitimate "force exit immediately" choice) and throws otherwise; `setupGracefulShutdown` warns and falls back to the 10 s default. Added 4 regression tests.

### 🟢 `apps/api/src/main.ts` — `normalizeEnvironment` now trims `NODE_ENV`

**Improvement:** `NODE_ENV` was lowercased but not trimmed, so a whitespace-padded `" production "` bypassed every `process.env.NODE_ENV === "production"` guard in `main.ts`, `QueueModule`, and `HealthService` — the same class of silent config drift the existing lowercase normalization was added to prevent. `normalizeEnvironmentValue` now trims + lowercases. Added 3 regression tests.

## Changes Applied (2026-08-04) — Code Review Round 87

### 🟡 `apps/api/src/mcp/mcp.service.ts` — valid idempotency keys mangled by `sanitizeForLogOutput(stripHtmlTags(...))`, breaking idempotent dedup

**Problem:** `validateIdempotencyKey` ran the validated key through `sanitizeForLogOutput(stripHtmlTags(raw))`. The idempotency key is the dedup identity for `idempotency_record` — the middleware persists `context.idempotencyKey` verbatim and replays are matched by exact key. `sanitizeForLogOutput` collapsed valid mixed-case alphanumeric keys (≥ ~20 chars) into `[REDACTED_TOKEN]`, so distinct operations collapsed onto the same record and a retry could be served another operation's cached result. `stripHtmlTags` additionally rewrote valid keys containing `<`, `>`, `/` (all permitted by `SAFE_IDEMPOTENCY_KEY = /^[!-~]+$/`). This also contradicted the round-84/85 design: identity fields are charset-validated at `buildContext`, sanitized only at the durable sinks.
**Fix:** Return the raw trimmed key verbatim — it is printable-ASCII-validated, hence log-safe by construction. Updated the `buildContext` doc comment to state the identity/content split explicitly. Added 2 regression tests: (1) token-shaped mixed-case key preserved verbatim (never `[REDACTED_TOKEN]`), (2) key with `SAFE_IDEMPOTENCY_KEY` punctuation (`invoice<42>/v1`) preserved verbatim.

### 🟢 `apps/api/src/queue/queue.module.ts` — `Number.parseInt(REDIS_PORT, 10)` silently truncated trailing garbage

**Improvement:** `REDIS_PORT=6380abc` parsed to `6380` via `parseInt`, contradicting the module's fail-closed posture (host/password guards reject any misconfiguration). Switched to strict `Number()` parsing so `6380abc` → `NaN` → "Invalid Redis port". Regression test added.

## Changes Applied (2026-08-04) — Code Review Round 84

### 🟡 `apps/api/src/mcp/mcp.service.ts` — userId pattern validation now runs BEFORE sanitization

**Problem:** `buildContext` ran `sanitizeForLogOutput(stripHtmlTags(…))` on `userId` first, then checked `TENANT_ID_PATTERN.test(userId)`. `sanitizeForLogOutput` replaces secret-shaped substrings (e.g. `sk_live_…`) with `[REDACTED_API_KEY]` placeholders that contain `[` and `]` — characters NOT in the allowed charset `/^[a-zA-Z0-9_-]+$/`. A structurally valid userId like `us-sk_live_abc123` would therefore pass the raw format check, get sanitized to `us-[REDACTED_API_KEY]`, and then fail the post-sanitization pattern check, producing a false rejection.
**Fix:** Moved the length and charset validation to run on the raw trimmed `userId` BEFORE sanitization. The sanitized value is still length-capped and persisted. Added 2 regression tests: (1) a secret-bearing valid-format userId passes validation and is correctly sanitized to `us-[REDACTED_API_KEY]`, and (2) an invalid-character userId (`user<42>api`) is rejected before sanitization even runs.

### 🟢 `apps/api/src/health.service.ts` — `_redisPortWarned` made static for consistency

**Improvement:** Changed the `REDIS_PORT`-once-per-process deduplication flag from an instance property to a `static` class property, matching the pattern already used in `QueueModule._redisPortWarned`. The behavior is identical for NestJS singletons, but the static declaration makes the "per-process" intent explicit at the point of declaration.

### 🟢 `apps/api/src/modules/core/party/party.service.ts` — retry loop explicit-bounded form

**Improvement:** Refactored the `addPartyRole` concurrency retry loop from `for (let attempt = 1; ; attempt += 1)` with inline `break`/`continue` to `for (let attempt = 1; attempt <= MAX_CONCURRENCY_RETRIES; attempt++)`. The iteration bound is now visible at the loop header. Added `!` non-null assertions on post-loop `role` accesses since TypeScript's control-flow analysis treats the bounded loop as potentially non-entering.

### 🟢 Trailing commas cleaned up in `tenant.guard.ts`, `queue.module.ts`

**Improvement:** Removed stray trailing commas in `throw` expressions that were inconsistent with the project's formatting conventions.

## Changes Applied (2026-08-01) — Code Review Round 74

### 🔴 `apps/api/src/modules/core/party/party.service.ts` — `addPartyRole` threw `ConcurrencyRetryError` without ever retrying; the promised "outer retry loop" did not exist

**Problem:** `addPartyRoleTransaction` handles concurrent duplicate `add_party_role` calls atomically via `INSERT … ON CONFLICT DO NOTHING` against the partial unique index `party_active_role_unique` (the DB-level guard that prevents two active roles of the same type). When two transactions race, the loser's `ON CONFLICT` returns 0 rows; after a re-check finds no active role, the code throws `ConcurrencyRetryError("Transaction conflict — retry the operation.")`. Comments at three sites (`createPartyTransaction`, `handleTransactionError`, `addPartyRoleTransaction`) claimed an "outer retry loop" / "the caller's retry loop" would handle it — but **no retry loop existed anywhere in the codebase**. The error escaped to the REST controller / MCP tool handler as a raw non-Domain `Error`, so the exact concurrency race the code was designed to survive produced a generic 500/UNKNOWN failure.
**Fix:** Added a bounded retry loop (max 3 attempts) in `addPartyRole` around the whole transaction. On retry exhaustion it now throws a `ConcurrencyConflictError` (a `DomainError`) with "please retry the operation" and the `add_party_role` suggestion, giving the caller an actionable error instead of an internal signal. Corrected the misleading "outer retry loop" comments in `createPartyTransaction`. Added 2 regression tests: retry-then-succeed, and `ConcurrencyConflictError` after exhaustion.

### 🟢 `apps/api/src/prisma/prisma.module.ts` — stale "Phase 0b" development notes replaced

**Problem:** The header comment described an unimplemented "Phase 0b" plan (Client Extension tenant context, request-scoped JWT resolution, connection pooling) superseded long ago — misleading future contributors about the module's design.
**Fix:** Replaced with a concise description of the actual three-client design (`admin`, `appClient`, `tenantScoped` with WeakRef cache + LRU replacement) matching the PrismaService implementation.

## Changes Applied (2026-07-31) — Code Review Round 73

### 🟢 `apps/api/src/main.ts` — `closeErr` log not sanitized

**Problem:** The graceful-shutdown debug log for `app.close()` rejections was the only error path not run through `sanitizeForLogOutput`; a connection string / hostname from the rejection could leak into operator logs.
**Fix:** Aligned the `closeErr` log to the same `sanitizeForLogOutput` pattern used by every other error path.

### 🟢 `packages/shared/src/sanitize.ts` — orphaned JSDoc removed

**Fix:** Removed a JSDoc block left behind after `sanitizeLogMessage` was refactored; it described a function that no longer exists.

## Changes Applied (2026-07-31) — Code Review Round 72

### 🟡 `resolveRedisTls` deduplicated to `@besterp/shared/constants.ts`

**Problem:** The Redis TLS decision was computed independently in `queue.module.ts` (`resolveTls`) and `health.service.ts` (private `resolveRedisTls`) — a TLS-policy change could drift between the BullMQ queue and the Redis health probe.
**Fix:** Extracted a single `resolveRedisTls()` source of truth in `@besterp/shared/constants.ts`; `QueueModule` and `HealthService` both delegate to it. Added unit tests covering every branch (explicit true/false, production/development/staging defaults, explicit override).

### 🟢 `packages/mcp-tools/src/middleware/error-handler.ts` — indentation drift corrected

**Fix:** A 6-space-indented line that had drifted from its surrounding block was normalized.

## Changes Applied (2026-07-31) — Code Review Round 71

### 🔴 `packages/database/prisma/create-roles.sql` — invalid `//` PL/pgSQL comment silently prevented `besterp_app` from ever being created

**Problem:** A `// ALTER ROLE before first use outside local development.` comment inside the `DO $$` block is not valid PL/pgSQL (only `--` and `/* */` are), so the block threw `syntax error at or near "/"`. Because CI/docker run psql without `ON_ERROR_STOP`, every subsequent `GRANT … TO besterp_app` failed with `role "besterp_app" does not exist` and psql still exited 0. The application role — the non-superuser role RLS depends on — was never provisioned, silently breaking CI's seed/database steps and the docker initdb flow. Verified against a live PostgreSQL 16 cluster.
**Fix:** Changed the comment to `--`. The role is now created and all grants succeed (verified: role exists, password auth works, script is idempotent across re-runs).

### 🔴 `packages/database/prisma/rls-setup.sql` — `CREATE POLICY IF NOT EXISTS` is unsupported in PostgreSQL; no tenant-isolation policy was ever created

**Problem:** PostgreSQL's `CREATE POLICY` does not support `IF NOT EXISTS` (unlike `CREATE TABLE`/`CREATE INDEX`). All 11 `CREATE POLICY IF NOT EXISTS` statements threw `syntax error at or near "NOT"` and were silently skipped (psql exit 0 without `ON_ERROR_STOP`). The ALTER TABLE ENABLE/FORCE ROW LEVEL SECURITY statements *did* run, so `verifyRlsEnabled()`'s boot check passed — while `pg_policy` contained **zero** rows. RLS was "enabled" but had no policies, so tenant isolation was never enforced. Verified on PostgreSQL 16: 11 errors, 0 policies.
**Fix:** Each policy now uses `DROP POLICY IF EXISTS <name> ON <table>; CREATE POLICY <name> ON <table> …`, which is supported and keeps the script idempotent. Verified: 11 policies created, re-run exits 0, and a tenant-scoped `set_tenant_context('tenant-acme')` transaction returns only that tenant's rows.

### 🟡 `packages/database/prisma/create-roles.sql` — app-role password drifted across three sources (single-source-of-truth fix)

**Problem:** The role password was hardcoded three ways: `'CHANGE_ME_USE_ALTER_ROLE'` in `create-roles.sql`, `besterp_app_dev` in CI connection strings, and `CHANGEME_APP_PASSWORD` in `.env.example`. Even after fixing the `//` bug, CI seed/tests and the documented local flow would fail with auth errors.
**Fix:** The password now comes from the psql variable `app_db_password` (default `CHANGEME_APP_PASSWORD`, matching `.env.example`/docker). CI passes `psql -v app_db_password=besterp_app_dev`. Uses `format('%L', :'app_db_password')` + `\gexec` with a `WHERE NOT EXISTS` guard (psql cannot interpolate variables inside dollar-quoted strings), and `\if :{?app_db_password}` so a supplied `-v` is never clobbered. Verified both paths produce distinct SCRAM hashes.

### 🟡 `docker/docker-compose.yml` — `rls-setup.sql` mounted into `initdb.d` ran before migrations and silently failed; README flow corrected

**Problem:** initdb executes before Prisma migrations create the tables, so every `ENABLE/FORCE ROW LEVEL SECURITY` failed silently and RLS was never applied for the documented docker flow — the app's `verifyRlsEnabled()` boot check then refused to start.
**Fix:** Removed `rls-setup.sql` from `initdb.d`; it is now mounted read-only at `/setup/rls-setup.sql` and README step 4 applies it after `npm run db:migrate` via `docker exec -i besterp-postgres psql -U besterp -d besterp -f /setup/rls-setup.sql`. `create-roles.sql` remains in `initdb.d` (role creation needs no tables).

### 🟡 `packages/database/prisma/rls-setup.sql` — `set_tenant_context` EXECUTE restrictions moved here from `create-roles.sql` (ordering bug)

**Problem:** `create-roles.sql` ran `REVOKE/GRANT EXECUTE ON FUNCTION set_tenant_context(TEXT)` before that function existed (it is created by `rls-setup.sql`), so the statements always failed and the "app-role-only" intent was never enforced.
**Fix:** The `REVOKE … FROM PUBLIC; GRANT … TO besterp_app` statements now live in `rls-setup.sql` immediately after the function is created. Verified: `has_function_privilege('besterp_app', …, 'EXECUTE')` = true, `public` = false.

### 🟢 `packages/shared/src/sanitize.ts` — generic long-token redactor destroyed legitimate ULID identity IDs

**Problem:** `replaceGenericLongToken` redacted any ≥20-char alphanumeric run containing both letters and digits to `"[REDACTED_TOKEN]"`. ULIDs — the dominant identity-ID shape in the MCP ecosystem (Anthropic/Claude user, conversation, thread IDs) — matched this and were destroyed. Impact was direct: `McpService.buildContext` runs `sanitizeForLogOutput` on `userId`/`agentId`/`conversationId`/`idempotencyKey`, so `usr_01H3X8Q5Y2GX4K1A2B3C4D5E6F` became `[REDACTED_TOKEN]` in the persisted audit log and every log/error surface that sanitizes those fields (`error-handler.ts`, `discovery-tools.ts`). Reproduced before the fix.
**Fix:** `replaceGenericLongToken` now whitelists the ULID shape (`/^[0-9][0-9A-HJKMNP-TV-Z]{25}$/`, Crockford base32 without I/L/O/U) and prefixed forms (`usr_…`, `agent_…`, `conv_…`). All existing secret shapes (base64, `ghp_…`, `sk_live_…`, mixed-case alnum runs, JWTs) are still redacted. Regression tests added in `sanitize.test.ts` and `mcp.module.spec.ts`.

### 🟢 `packages/shared/src/crypto.ts` — removed dead `kStr: ""` initializer in `sortMap`

**Improvement:** The `kStr` property was initialized to `""` and immediately overwritten in the following loop. Removed the dead initializer (typed the array so the property remains `string`).

### 🟢 `packages/shared/src/__tests__/sanitize.test.ts` — added unit coverage for `sanitizePostalAddress`/`sanitizeTelecomNumber`

**Improvement:** These exported helpers were only exercised indirectly. Added direct unit tests covering HTML stripping, trimming, country uppercasing, default country code, and null-collapsing of blank optional fields.

## Changes Applied (2026-07-30) — Code Review Round 70

### 🟢 `apps/api/src/queue/queue.module.ts` — Redis retry strategy added jitter to prevent thundering-herd reconnection

**Improvement:** The Redis retry strategy used purely deterministic backoff (`Math.min(times * 200, 5000)`), causing all connections to retry in lockstep after a cluster restart or network event. Added `Math.random() * 200` jitter to spread reconnection attempts across a 200ms window, reducing contention when multiple instances reconnect simultaneously.

### 🟢 `apps/api/src/mcp/tools/discovery-tools.ts` — Entity filter now trimmed before matching

**Improvement:** The `list_available_tools` entity filter applied `.toLowerCase()` but did not `.trim()`, so whitespace-padded input like `"  party  "` would match no tools. Added `.trim()` before the filter comparison for consistent behavior.

### 🟢 `apps/api/src/modules/core/party/party.module.ts`, `apps/api/src/health.module.ts` — Added explicit `PrismaModule` imports

**Improvement:** Both modules depended on `PrismaService` via the `@Global()` decorator on `PrismaModule`, creating implicit dependencies invisible to module-level analysis. Added explicit `imports: [PrismaModule]` so the dependency graph is self-documenting and each module can be tested in isolation without the `@Global()`.

### 🟢 `apps/api/src/auth/jwt-auth.guard.ts` — Removed verbose inline comments duplicated by the public-scope module

**Improvement:** The guard carried multi-line commentary about `@Public()` scope rules that is already documented in `public-scope.ts`. Removed the duplicate commentary since the guard delegates to `isPublicAllowedForHandler` which is the single source of truth for the scope restriction.
 
## Changes Applied (2026-07-29) — Code Review Round 69
 
### 🔵 Documentation improvement — added JSDoc comment to `McpService.buildContext` (`apps/api/src/mcp/mcp.service.ts`)
**Improvement:** Added comprehensive JSDoc documentation explaining that all string inputs undergo dual sanitization (HTML stripping + secret redaction) as defense-in-depth for audit log persistence and agent-facing output. Also added inline comments explaining the rationale for double-sanitizing `userId`. No functional changes; purely a maintainability improvement that clarifies the security intent for future contributors.
 
## Changes Applied (2026-07-20) — Code Review Round 68

### 🟡 `packages/shared/src/constants.ts` — `JWT_EXPIRES_IN_REGEX` accepted degenerate/non-expiring token lifetimes
**Problem:** The regex `^\d+[smhd]$` only checked format, with no lower or upper bound. `JWT_EXPIRES_IN=0s` passed `validateEnvironment` (main.ts) and would expire every token instantly, while `JWT_EXPIRES_IN=999999999999999999d` passed and produced an effectively non-expiring token — silently defeating short-lived JWTs in production. `JWT_SECRET` strength and other auth config are validated, but the lifetime knob was left unconstrained.
**Fix:** `JWT_EXPIRES_IN_REGEX` now requires a non-zero leading digit and caps the magnitude at 10 digits (`^[1-9]\d{0,9}[smhd]$`). `validateEnvironment` already fails closed on a non-matching value, so both degenerate cases are now rejected at boot. Added regression tests (rejects `0s`, `007d`, `999999999999999999d`, format-only mistakes; accepts `24h`/`60m`/`7d`/`1s`).

### 🟡 `apps/api/src/mcp/tools/party-tools.ts` — MCP `search_parties` `name`/`roleType` filters not HTML-stripped (asymmetric with REST path)
**Problem:** The REST `SearchPartiesDto` runs `name`/`roleType` through `@sanitizeTransform()` (stripHtmlTags + trim), but the MCP `searchPartiesSchema` used `optionalFilteredString`, whose transform only trimmed — it never called `stripHtmlTags`. A markup payload (`<script>…</script>Acme`) submitted via the MCP tool therefore reached the service/log path intact, diverging from the REST surface. Low runtime risk (search values are not persisted or echoed back), but an inconsistent sanitization boundary the prior rounds otherwise keep symmetric.
**Fix:** `optionalFilteredString` now runs `stripHtmlTags(s.trim())`, matching the REST `@sanitizeTransform()` behavior. Added a regression test asserting a markup `name` filter is stripped to its text before reaching the service.

### 🟢 `packages/shared/src/validation.ts` — `EMAIL_REGEX` accepted single-character TLDs
**Problem:** The label regex permitted a one-letter final label, so `user@b.c` / `a@x.y` validated as legal email addresses and could enter `email_address` storage despite not being valid public suffixes.
**Fix:** `EMAIL_REGEX` now requires the final TLD label to be at least 2 characters (`\.[a-zA-Z0-9]{2,}`), while still allowing single-label subdomains (e.g. `user@example.com`). Added regression tests (rejects `user@b.c`/`a@x.y`; accepts `user@example.com`/`user@example.io`). Also corrected the `COUNTRY_CODE_REGEX` doc comment to stop overclaiming it covers only real E.164 codes (values remain stored/formatted, not routed).

## Changes Applied (2026-07-20) — Code Review Round 67

### 🟡 `packages/shared/src/errors.ts` — `DomainError.toJSON` serialized `cause.message` without sanitization (asymmetric durable-sink leak)

**Problem:** `toJSON` scrubs `message` via `sanitizeForLogOutput` and `context` via `redactSensitiveFieldValues`, but `serializeCause` returned an attached `Error` cause's `message` verbatim. `cause` is frequently a Prisma/driver error (e.g. `prisma.service.ts` does `new Error(msg, { cause: roleErr })`) whose message embeds a DB hostname / connection string / SQL. Because `toJSON` is the canonical serializer for the durable `ai_action_log` and `idempotency_record` sinks, that infrastructure detail leaked into the durable row while `message` was scrubbed — the same asymmetric-leak class rounds 56/65 closed for `message`/`context`.
**Fix:** `serializeCause` now runs the `Error` cause's message through `sanitizeForLogOutput` (matching `message`); non-`Error` causes still return the safe `[Non-error cause]` placeholder. Regression tests added (secret-bearing cause redacted; non-error cause unchanged).

### 🟢 `apps/api/src/health.service.ts` — anonymous `/version` reflected an unsanitized init-error `warning`

**Problem:** `getVersion()` is `@Public()` (no JWT), so its non-production body is reachable by anyone. It surfaced `packageInfoError` verbatim in `warning`, which can contain the container's filesystem layout (e.g. `ENOENT … open '/srv/app/dist/package.json'`) — mild infrastructure fingerprinting inconsistent with the fail-closed hardening already applied to `name`/`version`/`build` on this endpoint (round 45).
**Fix:** `warning` is now scrubbed via `sanitizeForLogOutput`. Regression test added.

## Changes Applied (2026-07-20) — Code Review Round 66

### 🟡 `apps/api/src/mcp/mcp.module.ts` — `reasoning` not sanitized with `sanitizeForLogOutput` at the auth boundary
**Problem:** Round 65 added boundary sanitization to `userId`/`agentId`/`conversationId` via
`sanitizeForLogOutput(stripHtmlTags(...))` but left `reasoning` with only `stripHtmlTags(...)`.
A connection string / `?api_key=…` embedded in `reasoning` was scrubbed only by the downstream
`auditLogMiddleware.createBaseEntry` pass, so the documented "all four durable fields get the same
treatment" contract (and the defense-in-depth layering the sibling fields have) did not hold for
`reasoning`. The durable `ai_action_log.reasoning` sink was still covered downstream, so this was an
asymmetry / defense-in-depth gap rather than a live leak — but relying on a single downstream pass for
one of the four persisted fields is fragile.
**Fix:** `buildContext` now runs `reasoning` through `sanitizeForLogOutput(stripHtmlTags(...))` at the
boundary, matching `userId`/`agentId`/`conversationId` exactly. The downstream `createBaseEntry` pass
remains as defense-in-depth (idempotent). Regression test added (secret shapes in `reasoning` redacted
at the boundary, not solely downstream).

## Changes Applied (2026-07-20) — Code Review Round 65

### 🟡 `packages/shared/src/sanitize.ts` — round 64 removed `code`/`session` from the quoted-value secret rule, reopening an asymmetric leak
**Problem:** Round 64 removed `code|session` from the quoted-value boundary rule to fix benign
free-text like `status code=200 ok`. But the *quoted* JSON form (`{"session":"abc123xyz"}`,
`{"code":"XYZ789"}`) was also dropped. Those values are only re-caught by the generic high-entropy
rule when ≥20 chars; a short opaque token below that threshold leaked verbatim into agent-facing
error/output and the durable cross-tenant `ai_action_log`/`idempotency_record` rows — exactly the
asymmetric secret-leak class rounds 44/48/49/56 closed. The bare-form (free-text) rule was the one
that needed the `code`/`session` removal; the quoted form is structured, not prose, and should keep
redacting them.
**Fix:** Re-added `code|session` to the quoted-value rule only (line 218), leaving the bare-form rule
(round 64's prose fix) untouched. Regression test added (quoted `session`/`code` redacted even at
short lengths).

### 🟡 `apps/api/src/mcp/mcp.module.ts` — MCP identity/context fields persisted to cross-tenant durable sink without HTML/secret sanitization
**Problem:** `userId`/`agentId`/`conversationId`/`reasoning` flow into the cross-tenant `ai_action_log`
row via `auditLogMiddleware`. Only `reasoning` was sanitized downstream (round 49); `userId`/
`agentId`/`conversationId` were stored verbatim, so an attacker-influenced `<script>`/`<img onerror>`
(payload) or `?api_key=…` reached the durable row unstripped/unredacted.
**Fix:** `buildContext` now runs `userId`/`agentId`/`conversationId` through `sanitizeForLogOutput(
stripHtmlTags(...))` and `reasoning` through `stripHtmlTags(...)` at the boundary, mirroring the
downstream `reasoning` treatment. Regression test added.

### 🟡 `packages/shared/src/errors.ts` — `DomainError.toJSON` serialized `message` without sanitization
**Problem:** `toJSON` redacts `context` via `redactSensitiveFieldValues` but returned `message` raw.
`message` routinely echoes user-supplied input (connection strings, `?api_key=…`), so any caller
serializing the error via `JSON.stringify(error)` (the canonical durable-sink serializer) could leak
the secret verbatim, inconsistent with the REST `DomainExceptionFilter`/`error-handler` which
sanitize `error.message`.
**Fix:** `toJSON` now sanitizes `message` via `sanitizeForLogOutput` (defense-in-depth; `code` is a
short allowlisted constant, left as-is). Regression test added.

### 🟢 `packages/database/src/rls-extension.ts` — `$transaction` on a model delegate silently bypassed tenant context
**Problem:** `proxy.party.$transaction(...)` returned the underlying delegate's function (not in
`DATA_METHODS`), which runs without `set_tenant_context` and thus bypasses RLS. A latent footgun for
any future contributor expecting delegate-level transactions to be scoped.
**Fix:** The model-delegate proxy now rejects `$transaction` explicitly, directing callers to the
client-level `$transaction`. Regression test added.

## Changes Applied (2026-07-20) — Code Review Round 64

### 🟡 `packages/shared/src/tenant.ts` — `validateTenantIdEnhancedForAuth` omitted the `MAX_TENANT_ID_LENGTH` check present in `validateTenantId`
**Problem:** `validateTenantId` rejects IDs longer than `MAX_TENANT_ID_LENGTH` (100), but the
auth-boundary variant `validateTenantIdEnhancedForAuth` did not. A 200-char tenant ID passed the
auth boundary, then threw `InvalidTenantIdError` later inside `withTenant`→`validateTenantId`,
surfacing a confusing error and an asymmetric validation path (the two functions are documented as
needing to agree).
**Fix:** Added the same length guard to `validateTenantIdEnhancedForAuth`. Regression test added.

### 🟡 `packages/mcp-tools/src/registry/tool-registry.ts` — `agentId`/`conversationId` persisted to cross-tenant durable sinks without validation
**Problem:** `validateContextIdentity` validated only `tenantId`/`userId`. `agentId`/`conversationId`
flow straight from `context` into both the `ai_action_log` row and the `idempotency_record`, with no
length/character validation. Because they are attacker-influenceable and written to cross-tenant
durable tables, a malicious/oversized value was stored verbatim, bypassing the validation applied to
`tenantId`/`userId`.
**Fix:** Added `validateOptionalIdentityField` checking the same `/^[a-zA-Z0-9_-]+$/` pattern and
`MAX_AGENT_ID_LENGTH`/`MAX_CONVERSATION_ID_LENGTH` bounds (fail closed, no value reflected). Regression
tests added.

### 🟡 `packages/shared/src/sanitize.ts` — high-entropy redactor left mixed-case alphanumeric secrets unredacted
**Problem:** The generic high-entropy pass required uppercase **and** punctuation to redact a 20+ char
run, so a long mixed-case alphanumeric token with no punctuation (e.g. `AbCdEfGhIj…0123456789`) and a
longercase letter+digit token survived verbatim into agent-facing error/output and the durable audit
row. Separately, the bare-form boundary rule over-redacted benign `code=200` / `session=abc123`.
**Fix:** The letter+digit mix now also qualifies a run as secret-shaped; bare `code=`/`session=` were
removed from the free-text boundary rules (keeping `otp_code`/`session_id` via the quoted/key paths).
Regression tests added.

### 🟡 `packages/shared/src/crypto.ts` — `sortSet` threw on `BigInt`/`undefined` elements instead of normalizing them
**Problem:** `sortSet` ran `JSON.stringify()` on the *raw* element before the budget check, so a `Set`
containing a `BigInt` (or undefined-bearing structure) threw a raw `TypeError` ("Do not know how to
serialize a BigInt") rather than the structured `InvalidTypeValueError` every other container
guarantees.
**Fix:** `sortSet` now stringifies the already-normalized element (`sortKeysDeep` result, which maps
`BigInt`→`"BigInt:…"` and `undefined`→`null`) for both budgeting and sorting. Regression tests added.

### 🟡 `packages/database/spikes/spike-rls.ts` — spike cleanup silently fell back to the RLS-scoped app role
**Problem:** Cleanup used `process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL`. When
`DATABASE_ADMIN_URL` was unset, the app role (no tenant context set) saw 0 rows under RLS, so every
delete removed *nothing* and left `spike-*` data behind on every run, polluting the test database.
**Fix:** The admin datasource is now required and the spike fails fast if `DATABASE_ADMIN_URL` is
unset, mirroring the seed/cleanup scripts.

### 🟢 `packages/shared/src/errors.ts` — dead `try/catch` in `serializeCause`
**Problem:** `serializeCause` wrapped logic that cannot throw (`cause instanceof Error`,
`cause.message`) in a `try/catch` returning an unreachable `"[Error serializing cause]"` placeholder.
**Fix:** Removed the unreachable `try/catch` (behavior unchanged).

## Changes Applied (2026-07-18) — Code Review Round 50

### 🔴 `packages/mcp-tools/src/registry/tool-registry.ts` — Zod validation `message` returned to the AI agent was NOT secret-sanitized (asymmetric secret-leak)

**Problem:** On validation failure the pipeline joins each issue's `path: message`
into a single `detail` string, length-caps it, and embeds it verbatim in the
agent-facing top-level `error.message`. The parallel `context.issues` array is
scrubbed via `sanitizeIssues`, but `detail` was only `.slice()`-capped — so a
secret embedded in an issue `message` (a custom `errorMap`/`.refine()` that
echoes the received value, or a connection string) leaked verbatim in
`error.message` while `context.issues` redacted it. This is the asymmetric-leak
class rounds 42/44/48/49 closed on every other surface; `errorHandlerMiddleware`
only catches *thrown* errors and this soft-failure return is never thrown, so it
reached the agent unsanitized.

**Fix:** `detail` now runs through `sanitizeForLogOutput` before being embedded
(matching `context.issues`). The latent `leaky_tool` fixture already carried the
secret in the top-level message; the regression test now asserts
`error.message` does not contain it and contains `[HOST]/[PATH]`.

### 🔴 `packages/shared/src/sanitize.ts` — OAuth `#fragment` secrets (`#access_token=`, `#id_token=`) and `;`-separated params were not redacted

**Problem:** The query-string secret rule matched only a `(?<=[?&])` lookbehind,
so a secret delivered in a URL fragment (the OAuth implicit-flow mechanism,
`#access_token=`/`#id_token=`) survived verbatim — the subsequent
`(https?://)… → [HOST]/[PATH]` collapse requires a leading scheme+host and never
consumes a bare `#token=…`. Separately, `;` (a separator some query parsers
treat like `&`) and the `id_token` param name were missing, so `;token=…`
leaked when no `?`/`&`/`#` preceded it.

**Fix:** added `id_token` to the param-name alternation, added `#` to the lookbehind,
and added `;` to the lookbehind while excluding it from the value class (so a
`?a=1;token=…` immediately following another param is still caught). Regression
tests added (`#token=`, `#id_token=`, `;token=`, `?token=x;other=2`).

### 🔴 `packages/shared/src/crypto.ts` — `sortSet` never charged element bytes to the aggregate hash budget (bypassed the DoS guard)

**Problem:** `sortArray`/`sortPlainObject`/`sortMap` all charge string *values*
(and, for maps, keys) to `budget.bytes` via `checkStringBounds`/`chargeKeyBytes`,
but `sortSet` called `JSON.stringify(v)` only to sort and never charged the
elements. A `Set` of ~30 × 99 KB strings (≈3 MB) therefore hashed
successfully and emitted a ~3 MB `JSON.stringify` buffer, defeating the round-38
`MAX_HASH_TOTAL_BYTES` DoS guard that every other container honored.

**Fix:** `sortSet` now charges each element's serialized bytes to the budget (and the
`sortKeysDeep` value path already charges the string values). Regression test added
(a wide `Set` of distinct near-limit strings now throws the aggregate-size-limit
error; a modest `Set` stays within budget).

### 🟡 `apps/api/src/queue/queue.module.ts` — `REDIS_HOST` silently defaulted to `localhost` in production

**Problem:** Only the Redis *password* was enforced in non-development; an unset/
empty `REDIS_HOST` fell back to `localhost`, so a misconfigured production
instance would connect to an unintended (and unauthenticated) Redis rather than
failing closed.

**Fix:** `REDIS_HOST` is now required when `NODE_ENV !== "development"` (mirroring
the password guard); only development keeps the localhost fallback. Added a
production host-guard regression test.

### 🟡 `apps/api/src/modules/core/party/party.service.ts` — telecom duplicate check ignored `countryCode`

**Problem:** `checkTelecomDuplicate` matched only on `(areaCode, lineNumber)`, so
`+1 555 1234` and `+44 555 1234` collided as the same number — incorrect for
international subscribers.

**Fix:** the check (and the create path feeding it) now scope on `countryCode`
(defaulting to `+1` when omitted, matching the stored value). Added a regression
test asserting `countryCode` is in the duplicate-check `where`.

### 🟡 `apps/api/src/mcp/tools/party-tools.ts` — MCP email validation diverged from the REST/service layer

**Problem:** the MCP `emailAddressSchema` used Zod's built-in `.email()`, while
`party.service.ts` enforces the stricter `EMAIL_REGEX`. Zod accepts addresses
`EMAIL_REGEX` rejects (e.g. a double-dot local part `a..b@x.com`), so an
MCP-submitted address could pass validation and then be rejected by the service's
duplicate-check/re-validation.

**Fix:** the MCP path now runs through the same `EMAIL_REGEX` as the service
layer.

### 🟢 `packages/mcp-tools/src/middleware/audit-log.ts` — MCP `redactSensitiveFields` diverged from the canonical shared redactor (depth cap + non-string Map keys)

**Problem:** `MAX_REDACTION_DEPTH` was 10 on the MCP side vs 20 on the canonical
REST redactor, so a legitimately deep (11–20 level) payload was over-redacted
(`[Too deep]`) on the MCP/durable surface while preserved on REST — silent data
loss in `ai_action_log`/idempotency. And `redactMap` only redacted when
`typeof k === "string"`, so a `Map` keyed by an object whose `toString()` yields
a sensitive name was redacted on REST (`String(k)`) but not on MCP.

**Fix:** aligned `MAX_REDACTION_DEPTH` to 20 and switched `redactMap` to `String(k)`
for parity. Regression tests updated/added.

---

## Changes Applied (2026-07-18) — Code Review Round 49

### 🔴 `packages/shared/src/sanitize.ts` — query-string secret rule *annotated* the secret instead of *replacing* it (live secret-leak in the core redaction primitive)

**Problem:** The query-string secret rule matched the full `param=value` and
returned `m.replace(/^\[+|[\])}\s]+$/g, "") + "[REDACTED]"`, so
`api_key=sk_live_abc123` became `api_key=sk_live_abc123[REDACTED]` — the
**secret text survived verbatim** in the output. Every agent-facing surface
(REST `DomainExceptionFilter`, MCP `error-handler`/`audit-log`/`idempotency`/
`tool-registry`) and every durable sink composes `sanitizeLogOutput`, so this
bypassed redaction everywhere it was used. It stayed hidden through rounds 44–48
because every existing regression test fed an `https://…?param=secret` URL, and
the *subsequent* `(https?://)… → [HOST]/[PATH]` collapse folded the whole
URL (secret included) away — masking the defective query rule. The leak is real
whenever a secret-bearing query string appears **without** a leading `https://` URL
(a bare `?api_key=…`, a `reasoning`/log line, a curl arg).

**Fix:** The rule now captures the `param=` prefix and the bare value in separate
groups and returns `param=[REDACTED]` (`api_key=sk_live_abc123` →
`api_key=[REDACTED]`). Added a regression test that exercises the no-URL case
(previously uncovered).

### 🔴 `packages/mcp-tools/src/middleware/audit-log.ts` — `reasoning` persisted to the durable `ai_action_log` sink un-sanitized (asymmetric secret-leak)

**Problem:** `reasoning` originates from the AI agent / tool-call context
(attacker-influenceable via the MCP request body) and is written verbatim to
`ai_action_log.reasoning`, a cross-tenant audit table. Every *other* durable sink
(`toolInput`, `toolOutput` → both `redactSensitiveFields`) and every
agent-facing surface run through `sanitizeForLogOutput`, but `reasoning` was only
length-sliced to `MAX_REASONING_LENGTH` — so a connection string, JWT, or
`?api_key=…` embedded in it leaked into the durable row. This is the same class
of asymmetric-leak round 44/48 closed for the other sinks, now extended to
`reasoning`. It was also the *trigger* that exposed the `sanitize.ts` defect above:
a `reasoning` string carries no `https://` URL, so the masked query-rule defect
surfaced.

**Fix:** `reasoning` now runs through `sanitizeForLogOutput` before being
persisted (matching the `toolInput` handling). Added a regression test
(connection string + `?api_key=…` in `reasoning` redacted in the durable row).

## Changes Applied (2026-07-18) — Code Review Round 48

### 🔴 `packages/shared/src/sanitize.ts` — O(n²) ReDoS in the credential-URL catch-all (event-loop DoS)

**Problem:** `sanitizeLogOutput` / `sanitizeForLogOutput` had no input-length cap, and
the generic `scheme://user:pass@host` catch-all used an unbounded greedy scheme prefix
`[a-zA-Z][a-zA-Z0-9+.-]*`. On a long run of letters with no `://` the regex
backtracks char-by-char at every offset (catastrophic backtracking) — empirically ~6.9 s
for a 100k-char string. This is called on hot, synchronous, agent-facing **and**
durable-persist paths (MCP `error-handler`, `audit-log`, `idempotency`,
`tool-registry`; and `redactSensitiveFieldValues` runs it on every string leaf), so a
single crafted ~100k-char error/tool-output blocks the Node event loop for seconds. The
`.slice(...)` truncation applied by callers happens *after* this runs, so it could not
mitigate the cost.

**Fix:** Capped the scheme length at `{1,31}` (linear; ~13 ms at 100k, verified) and
added a defensive `MAX_LOG_OUTPUT_LENGTH = 100_000` UTF-8 byte cap at the top of
`sanitizeLogOutput` (mirroring the guard in `stripHtmlTags`). Added a regression test
(100k letter run returns in < 500 ms; credential URLs still redacted).

### 🟡 `packages/mcp-tools/src/middleware/audit-log.ts` — MCP redactor did not sanitize string leaves (asymmetric secret leak)

**Problem:** `redactSensitiveFields` returned terminal **string** values verbatim (its
`isTerminal` short-circuit), so a connection string / JWT / `?api_key=…` embedded in a
tool result *value* under a benign-named key (`url`, `note`) survived the MCP redactor —
even though the canonical shared `redactSensitiveFieldValues` (used by the REST
`DomainExceptionFilter`) scrubs every string leaf via `sanitizeForLogOutput`. The secret
therefore leaked to the agent (live path), the `ai_action_log` durable row, and any
idempotency replay.

**Fix:** String leaves now pass through `sanitizeForLogOutput` before being returned,
matching the REST surface. Added a regression test (connection string under `url`/`note`
scrubbed on both the live result and the persisted `toolOutput`).

### 🟡 `apps/api/src/prisma/prisma.service.ts` — `verifyRlsEnabled` "unexpected table" guard was unreachable dead code

**Problem:** The verification query filtered `WHERE relname = ANY(tenantTables)`, so
`forceRlsCount` was derived only from the enumerated rows and could never exceed
`tenantTables.length`. The `unexpected` branch (round 44 #6's intended protection
against a new tenant table added to `rls-setup.sql` but omitted from the list) could
never fire — the gap stayed open and boot passed vacuously.

**Fix:** The query now selects **all** `relkind='r'` tables in `public` and diffs the
actual force-RLS set against the enumeration; a force-RLS table not in the list now
refuses to boot. No false-positive on global (non-tenant) tables (they never get FORCE
RLS).

### 🟡 `packages/database/prisma/migrations/20260718000000_ai_action_log_tenant_id_not_null` — closed the `ai_action_log.tenant_id` nullable drift

**Problem:** The init migration declared `ai_action_log.tenant_id` as `TEXT` (nullable)
while `schema.prisma` mandates `NOT NULL` and every other tenant table uses `TEXT NOT
NULL`. Because the migrations are shipped/squashed, a fresh `migrate deploy` produced a
genuinely nullable column — a direct/raw insert could write a NULL `tenant_id` row
(invisible to all tenants under RLS, but a stranded-audit / data-integrity gap and a
false assumption for any consumer trusting `tenant_id` is always present).

**Fix:** New migration backfills any NULL to `''` and sets `NOT NULL`, aligning the DB
with the schema.

### 🟢 `packages/mcp-tools/src/registry/tool-registry.ts` — `UNKNOWN_TOOL` reflected the raw requested tool name

**Problem:** The requested tool `name` is attacker-controlled and the `UNKNOWN_TOOL`
result bypasses `errorHandlerMiddleware`, so a crafted name embedding a secret-bearing
URL (`foo?api_key=…`) reached the agent unsanitized.

**Fix:** `name` (and similar-name suggestions) now run through `sanitizeForLogOutput`
before being reflected. Added a regression test.

## Changes Applied (2026-07-18) — Code Review Round 47

### 🟢 `crypto.ts` — `sortKeysDeep` exceeded the lint complexity cap (the last outstanding lint warning)

**Problem:** `sortKeysDeep` inlined every type-dispatch branch (null/undefined, number,
string, array/Map/Set/object, primitive) plus the depth guard, pushing its cyclomatic
complexity to 17 against the configured `max-complexity` of 15 — the single remaining
`npm run lint` warning carried over from round 46.

**Fix:** Extracted the non-null/non-primitive dispatch into a new `dispatchContainer()`
helper. It preserves the exact budget/ancestors threading (the `budget ?? { bytes: 0 }`
defaulting for the string/number short-circuits stays local to `sortKeysDeep`) and the
single recursive call site per container type. `sortKeysDeep` drops to complexity 14 and
`dispatchContainer` is 6. `npm run lint` is now 0 errors / 0 warnings across all
workspaces; no behavior change (shared suite 164 still passes).

## Changes Applied (2026-07-18) — Code Review Round 46

### 🟡 `auth/public-scope.ts` / `main.ts` / `public-scope.spec.ts` — build-breaking type import + lint regressions in the round-45 `@Public()` scope scan

**Problem:** The boot-time `verifyPublicEndpointsScope` scan (added round 45) imported `InstanceWrapper` via the deep path `@nestjs/core/injector/instance-wrapper`, which is not a package-exported subpath in NestJS 11 — `npm run typecheck` failed for the whole `apps/api` workspace (`TS2307: Cannot find module '@nestjs/core/injector/instance-wrapper'`). The scan wiring in `main.ts` also imported `DiscoveryService` from a second `@nestjs/core` statement (duplicate-import lint error) and contained a dead `app.get(Reflector)` call whose comment implied it initialised something the `DiscoveryService` dependency graph already resolves. The same broken deep import in the new spec broke typecheck there too, and left two unused `eslint-disable` directives.

**Fix:** Dropped the explicit `InstanceWrapper` import and let `getControllers()`'s return type be inferred, deriving the element type in the spec from `ReturnType<DiscoveryService["getControllers"]>[number]`. Merged the duplicate `@nestjs/core` import in `main.ts` and removed the no-op `Reflector` fetch. Removed the stale `eslint-disable` comments. `typecheck`, `lint`, and `test` are all clean again (api 322 passing; the only remaining lint warning is the pre-existing `crypto.ts:sortKeysDeep` complexity note).

## Changes Applied (2026-07-17) — Code Review Round 45

### 🟡 `health.service.ts` — anonymous `/version` fingerprints the build in production

**Problem:** `HealthController.getVersion()` is `@Public()` (no JWT), so it is reachable by anyone. It returned the package `name` + `version` (and build number/date) verbatim in **every** environment, including production. An exact name + semantic version fingerprints the deployed release, letting an attacker target known CVEs for that specific build — the same infrastructure-fingerprinting class the anonymous `/health` body was already minimised against (round 33/34). The `build`/warning suppression already keyed on `NODE_ENV === "production"`, but `name`/`version` were never gated.

**Fix:** `getVersion()` now returns generic `"redacted"` markers for `name`/`version` (and omits `build`/`warning`) when `NODE_ENV === "production"`, matching the fail-closed hardening of the `/health` body. Non-production keeps the full triplet for operator debugging. Added regression tests (production redaction; non-production disclosure).

### 🟡 `jwt-auth.guard.ts` / `tenant.guard.ts` — `@Public()` was an unscoped global auth opt-out

**Problem:** `@Public()` is a boolean decorator honoured by both `JwtAuthGuard` and `TenantGuard` for *any* controller or method. For a multi-tenant system that is a standing footgun: a single misplaced `@Public()` silently unauthenticates a tenant-scoped route, exposing data to anonymous callers — with no warning at boot or runtime. Only `HealthController` is legitimately public today, so the broad opt-out was pure latent risk.

**Fix:** Added `auth/public-scope.ts` with `isPublicAllowedForHandler()`, which fails closed (`ForbiddenException`) unless the handler's controller is `HealthController`. Both guards now call it before honoring `@Public()`. A future attempt to opt any other controller out of authentication is rejected at request time rather than silently bypassed. Added a regression test (non-health `@Public()` throws `ForbiddenException`; health stays allowed).

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
