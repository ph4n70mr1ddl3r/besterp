// @besterp/database — Public API
//
// Exposes RLS-aware client construction and validation for application code.

import type { PrismaClient } from "@prisma/client";

export { createTenantClient } from "./rls-extension.js";
export { validateTenantIdEnhanced } from "./rls-extension.js";
export type { CreateTenantClientOptions } from "./rls-extension.js";

/** A PrismaClient-like interface with automatic RLS tenant context injection.
 *  All model operations are wrapped in transactions that call `set_tenant_context()`.
 *  Raw SQL and lifecycle methods ($connect, $disconnect, $queryRaw, etc.) are blocked
 *  at runtime. This type preserves Prisma model typing while marking blocked methods
 *  as unavailable at compile time.
 *
 *  NOTE: This is a best-effort type. The runtime proxy also blocks `$`-prefixed
 *  properties beyond those listed here and all `_`-prefixed internal properties.
 */
export type TenantScopedClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$extends" | "$queryRaw" | "$queryRawTyped" | "$executeRaw" | "$executeRawTyped" | "$queryRawUnsafe" | "$executeRawUnsafe">;
