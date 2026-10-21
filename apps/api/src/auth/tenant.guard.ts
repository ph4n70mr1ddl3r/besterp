// Tenant Guard — Extracts tenant context from the authenticated user.
//
// Runs AFTER JwtAuthGuard. Reads the validated user from `req.user`
// and attaches a TenantContext to the request for downstream services.
//
// Note: This guard is registered as a SINGLETON (default scope), not
// request-scoped. It accesses the request via the ExecutionContext,
// which is safe because NestJS provides a fresh ExecutionContext per request.

import { Injectable, ExecutionContext, CanActivate, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import type { JwtValidatedUser } from "./jwt.strategy.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { isPublicAllowedForHandler } from "./public-scope.js";
import { validateTenantIdEnhancedForAuth, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, isValidOptionalId } from "@besterp/shared";

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // @Public() is only permitted on HealthController (see public-scope.ts).
      // Fail closed if any other controller opts out of authentication.
      isPublicAllowedForHandler(context);
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // Runtime shape guard: `request.user` could be undefined or a partial
    // object if JwtAuthGuard failed silently (misconfigured strategy, etc.).
    // An unsafe `as` cast alone gives TypeScript a false sense of safety;
    // the check below ensures the expected fields exist before proceeding.
    // Throw UnauthorizedException (401) like every other auth failure in
    // this guard — a bare `return false` yielded a generic 403 "Forbidden
    // resource" with no diagnostic message, inconsistent with the
    // tenantId/userId/agentId branches below.
    const rawUser = request.user;
    if (rawUser == null || typeof rawUser !== "object" || !("tenantId" in rawUser)) {
      throw new UnauthorizedException(
        "TenantGuard: authenticated user is missing or malformed (request.user)."
      );
    }
    const user = rawUser as JwtValidatedUser;

    const tenantId = TenantGuard.validateTenantId(user);
    const userId = TenantGuard.validateUserId(user);
    const agentId = TenantGuard.validateAgentId(user);
    // Propagate the (already validated) role claim. It used to be parsed by
    // JwtStrategy and then dropped here, so the documented JWT contract
    // (`{ sub, tenantId, role }`) was only half implemented and no consumer
    // could tell that RBAC existed at all.
    const role = TenantGuard.validateRole(user);

    request.tenantContext = { tenantId, userId, agentId, role };
    return true;
  }

  /**
   * Validate and return the optional `role` claim.
   *
   * JwtStrategy already validated the type and length of the claim, so this
   * is a cheap shape check — it exists so a hand-constructed `req.user`
   * (which bypasses the strategy) cannot inject a non-string role into the
   * request context.
   */
  private static validateRole(user: JwtValidatedUser): string | undefined {
    if (user.role == null) return undefined;
    if (typeof user.role !== "string") {
      throw new UnauthorizedException(
        "TenantGuard: role is not a string. JWT payload is malformed."
      );
    }
    const trimmed = user.role.trim();
    if (trimmed.length === 0) return undefined;
    // The same pattern validation JwtStrategy applies to `userId` and
    // `agentId` — the `role` claim used to be only type/length-checked, so a
    // hand-constructed `req.user` (which bypasses the strategy) could inject
    // a role containing control characters, zero-width/bidi sequences or HTML
    // into `request.tenantContext`, from where it reaches logs, audit rows
    // and RBAC checks.
    if (!isValidOptionalId(trimmed)) {
      throw new UnauthorizedException(
        "TenantGuard: role contains invalid characters. " +
          "Roles may only contain printable non-whitespace characters."
      );
    }
    return trimmed;
  }

  private static validateTenantId(user: JwtValidatedUser): string {
    if (user.tenantId === undefined || user.tenantId === null) {
      throw new UnauthorizedException(
        "TenantGuard: tenantId is missing from JWT payload."
      );
    }
    try {
      return validateTenantIdEnhancedForAuth(user.tenantId);
    } catch (e) {
      // Preserve the original error message for operator logs while still
      // returning 401 to the client. A bare "tenantId failed format validation"
      // loses the specific cause (e.g. INVALID_TENANT_ID vs a validation error),
      // making debugging harder.
      const msg = e instanceof Error ? e.message : String(e);
      throw new UnauthorizedException(
        `TenantGuard: tenantId failed format validation. ${msg}`,
      );
    }
  }

  private static validateUserId(user: JwtValidatedUser): string {
    if (typeof user.userId !== "string") {
      throw new UnauthorizedException(
        "TenantGuard: userId is not a string. JWT payload is malformed."
      );
    }
    const userId = user.userId.trim();
    if (!userId) {
      throw new UnauthorizedException(
        "TenantGuard: userId is empty after trimming. JWT payload is malformed."
      );
    }
    if (userId.length > MAX_USER_ID_LENGTH) {
      throw new UnauthorizedException(
        "TenantGuard: userId exceeds maximum allowed length."
      );
    }
    // userId uses OPTIONAL_ID_PATTERN (alphanumeric + dots/plus/etc.) to match
    // JwtStrategy.validate() which accepts the same permissive pattern (round 207).
    // A stricter TENANT_ID_PATTERN here would reject valid tokens carrying real-world
    // identifiers like "john.doe" or "user+admin". agentId continues to use
    // TENANT_ID_PATTERN because it is generated as a ULID-style string.
    if (!isValidOptionalId(userId)) {
      throw new UnauthorizedException(
        "TenantGuard: userId contains invalid characters. " +
          "User IDs may only contain printable non-whitespace characters."
      );
    }
    return userId;
  }

  private static validateAgentId(user: JwtValidatedUser): string | undefined {
    if (user.agentId != null && typeof user.agentId !== "string") {
      throw new UnauthorizedException(
        "TenantGuard: agentId is not a string. JWT payload is malformed."
      );
    }
    const rawAgentId = user.agentId?.trim() ?? "";
    if (rawAgentId.length > MAX_AGENT_ID_LENGTH) {
      // Mirrors the JwtStrategy length cap so TenantContext is safe even if a
      // token somehow carries an over-length agentId past the strategy.
      throw new UnauthorizedException(
        "TenantGuard: agentId exceeds maximum allowed length."
      );
    }
    // agentId uses OPTIONAL_ID_PATTERN — the same pattern JwtStrategy and the
    // MCP layer use — so an agent ID that the tooling can mint ("sales.v2") is
    // also one that can authenticate. The stricter TENANT_ID_PATTERN used
    // here made the auth boundary reject IDs the MCP layer accepted.
    if (rawAgentId.length > 0 && !isValidOptionalId(rawAgentId)) {
      throw new UnauthorizedException(
        "TenantGuard: agentId contains invalid characters. " +
          "Agent IDs may only contain printable non-whitespace characters."
      );
    }
    return rawAgentId === "" ? undefined : rawAgentId;
  }
}
