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
import { validateTenantIdEnhancedForAuth, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, TENANT_ID_PATTERN } from "@besterp/shared";

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

    const tenantId = this.validateTenantId(user);
    const userId = this.validateUserId(user);
    const agentId = this.validateAgentId(user);

    request.tenantContext = { tenantId, userId, agentId };
    return true;
  }

  private validateTenantId(user: JwtValidatedUser): string {
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

  private validateUserId(user: JwtValidatedUser): string {
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
    // userId/agentId use TENANT_ID_PATTERN (alphanumeric + hyphens + underscores)
    // because all identifiers in BestERP are generated as ULID-style strings
    // (26-char sortable IDs using [0-9A-HJKMNP-TV-Z] plus optional hyphens).
    // The pattern is deliberately permissive enough to accept any valid ULID
    // while rejecting control characters and whitespace that could be used
    // for log injection. UUIDs (with hyphens) also match this pattern.
    if (!TENANT_ID_PATTERN.test(userId)) {
      throw new UnauthorizedException(
        "TenantGuard: userId contains invalid characters. " +
          "User IDs may only contain alphanumeric characters, hyphens, and underscores."
      );
    }
    return userId;
  }

  private validateAgentId(user: JwtValidatedUser): string | undefined {
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
    if (rawAgentId.length > 0 && !TENANT_ID_PATTERN.test(rawAgentId)) {
      throw new UnauthorizedException(
        "TenantGuard: agentId contains invalid characters. " +
          "Agent IDs may only contain alphanumeric characters, hyphens, and underscores."
      );
    }
    return rawAgentId === "" ? undefined : rawAgentId;
  }
}
