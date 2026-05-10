# BestERP — Security & Architecture Fixes

## Changes Applied (2026-05-11)

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
