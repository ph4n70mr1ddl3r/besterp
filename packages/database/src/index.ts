// @besterp/database — Public API
//
// Exposes RLS-aware client construction and validation for application code.

export { createTenantClient } from "./rls-extension.js";
export { validateTenantIdEnhanced } from "./rls-extension.js";
export type { CreateTenantClientOptions, TenantScopedClient } from "./rls-extension.js";
