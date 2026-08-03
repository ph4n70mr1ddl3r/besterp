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
import { validateTenantIdEnhancedForAuth, MAX_USER_ID_LENGTH, TENANT_ID_PATTERN } from "@besterp/shared";

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // @Public() is only permitted on HealthController (see jwt-auth.guard).
      // Fail closed if any other controller opts out of authentication.
      isPublicAllowedForHandler(context);
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as JwtValidatedUser;

    if (!user) {
      // JwtAuthGuard should always run before TenantGuard and populate
      // req.user. If we reach this branch, the JWT was invalid or missing —
      // return false so NestJS returns 401 Unauthorized (not 500), preserving
      // the correct semantic for an authentication failure.
      return false;
    }

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
    } catch {
      throw new UnauthorizedException(
        "TenantGuard: tenantId failed format validation."
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
    if (rawAgentId.length > 0 && !TENANT_ID_PATTERN.test(rawAgentId)) {
      throw new UnauthorizedException(
        "TenantGuard: agentId contains invalid characters. " +
          "Agent IDs may only contain alphanumeric characters, hyphens, and underscores."
      );
    }
    return rawAgentId || undefined;
  }
}
