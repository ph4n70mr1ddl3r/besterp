# BestERP — Security & Architecture Fixes

## Changes Applied (2026-06-29) — Review Recommendations

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
