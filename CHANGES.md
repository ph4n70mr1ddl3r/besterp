# BestERP — Security & Architecture Fixes

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
