// Tenant context — Request-scoped tenant/user identity.
//
// Populated by the TenantGuard from JWT claims or API key.
// Injected into services that need tenant-scoped database access.
//
// This is the source of truth for "who is making this request" at the
// application layer. The RLS layer provides database-level enforcement.

export interface TenantContext {
  /** The tenant (organization) ID. */
  tenantId: string;
  /** The user ID on whose behalf the request is made. */
  userId: string;
  /** Optional AI agent ID (for MCP tool calls). */
  agentId?: string;
}

/** Extend Express Request with tenant context and request ID for type safety. */
declare module "express" {
  interface Request {
    tenantContext?: TenantContext;
    requestId?: string;
  }
}
