// Tenant context — Request-scoped tenant/user identity.
//
// Populated by the TenantGuard from validated JWT claims.
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
  /**
   * Optional role from the verified JWT claims.
   *
   * The JWT payload contract has always carried a `role` claim
   * (`{ sub, tenantId, role }`), and JwtStrategy has always parsed and
   * length-checked it — but the value was DROPPED before it reached the
   * request context, so no downstream code could authorize by role and
   * future authors had no way of knowing RBAC existed. It is propagated
   * here so the claim is at least available to consumers; NOTE that no
   * authorization check consumes it yet (role-based enforcement is a
   * separate, larger change).
   */
  role?: string;
}

/** Extend Express Request with tenant context and request ID for type safety. */
declare module "express" {
  interface Request {
    tenantContext?: TenantContext;
    requestId?: string;
  }
}
