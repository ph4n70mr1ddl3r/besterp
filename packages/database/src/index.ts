// @besterp/database — Public API
//
// Exposes RLS-aware client construction and validation for application code.

import type { PrismaClient } from "@prisma/client";

export { createTenantClient } from "./rls-extension.js";
export { validateTenantIdEnhanced } from "./rls-extension.js";
export type { CreateTenantClientOptions } from "./rls-extension.js";

/** A PrismaClient with automatic RLS tenant context injection.
 *  All model operations are wrapped in transactions that call `set_tenant_context()`.
 *  Raw SQL and lifecycle methods ($connect, $disconnect, $queryRaw, etc.) are blocked.
 */
export type TenantScopedClient = PrismaClient;
