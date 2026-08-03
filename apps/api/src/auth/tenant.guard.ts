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
import { TenantContext } from "../common/tenant-context.js";
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

    // Defense-in-depth: validate tenant ID format at the auth boundary.
    // JwtStrategy already validates format, but we re-check here so any
    // future code path that bypasses the strategy (e.g., test doubles)
    // cannot produce a malformed tenant context. The enhanced validator
    // trims and checks the format in one call.
    if (user.tenantId === undefined || user.tenantId === null) {
      throw new UnauthorizedException(
        "TenantGuard: tenantId is missing from JWT payload."
      );
    }
    let tenantId: string;
    try {
      tenantId = validateTenantIdEnhancedForAuth(user.tenantId);
    } catch {
      throw new UnauthorizedException(
        "TenantGuard: tenantId failed format validation.",
      );
    }
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
    // Enforce max length for defense-in-depth — the JWT strategy validates
    // this, but if that guard is ever bypassed the tenant context must not
    // accept an unbounded userId (could cause DB column overflow).
    if (userId.length > MAX_USER_ID_LENGTH) {
      throw new UnauthorizedException(
        "TenantGuard: userId exceeds maximum allowed length.",
      );
    }
    if (!TENANT_ID_PATTERN.test(userId)) {
      throw new UnauthorizedException(
        "TenantGuard: userId contains invalid characters. " +
          "User IDs may only contain alphanumeric characters, hyphens, and underscores.",
      );
    }
    if (user.agentId != null && typeof user.agentId !== "string") {
      throw new UnauthorizedException(
        "TenantGuard: agentId is not a string. JWT payload is malformed."
      );
    }
    const agentId = user.agentId?.trim() || undefined;

    const tenantContext: TenantContext = {
      tenantId,
      userId,
      agentId,
    };

    request.tenantContext = tenantContext;
    return true;
  }
}
