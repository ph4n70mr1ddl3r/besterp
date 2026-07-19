// Tenant Guard — Extracts tenant context from the authenticated user.
//
// Runs AFTER JwtAuthGuard. Reads the validated user from `req.user`
// and attaches a TenantContext to the request for downstream services.
//
// Note: This guard is registered as a SINGLETON (default scope), not
// request-scoped. It accesses the request via the ExecutionContext,
// which is safe because NestJS provides a fresh ExecutionContext per request.

import { Injectable, ExecutionContext, CanActivate, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import type { JwtValidatedUser } from "./jwt.strategy.js";
import { TenantContext } from "../common/tenant-context.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { isPublicAllowedForHandler } from "./public-scope.js";
import { validateTenantIdEnhancedForAuth } from "@besterp/shared";

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
      // req.user. If we reach this branch, the guards are misconfigured.
      // Throw a 500 with a clear message rather than silently returning false
      // (which NestJS would convert to a bare 403 with no diagnostic context).
      throw new InternalServerErrorException(
        "TenantGuard: req.user is missing. JwtAuthGuard must run before TenantGuard."
      );
    }

    // Defense-in-depth: validate tenant ID format at the auth boundary.
    // JwtStrategy already validates format, but we re-check here so any
    // future code path that bypasses the strategy (e.g., test doubles)
    // cannot produce a malformed tenant context. The enhanced validator
    // trims and checks the format in one call.
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
    if (user.agentId != null && typeof user.agentId !== "string") {
      throw new UnauthorizedException(
        "TenantGuard: agentId is not a string. JWT payload is malformed."
      );
    }
    const agentId =
      user.agentId == null
        ? undefined
        : user.agentId.trim() || undefined;

    const tenantContext: TenantContext = {
      tenantId,
      userId,
      agentId,
    };

    request.tenantContext = tenantContext;
    return true;
  }
}
