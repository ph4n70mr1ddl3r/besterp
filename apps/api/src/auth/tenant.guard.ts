// Tenant Guard — Extracts tenant context from the authenticated user.
//
// Runs AFTER JwtAuthGuard. Reads the validated user from `req.user`
// and attaches a TenantContext to the request for downstream services.
//
// Note: This guard is registered as a SINGLETON (default scope), not
// request-scoped. It accesses the request via the ExecutionContext,
// which is safe because NestJS provides a fresh ExecutionContext per request.

import { Injectable, ExecutionContext, CanActivate, InternalServerErrorException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { JwtValidatedUser } from "./jwt.strategy.js";
import { TenantContext } from "../common/tenant-context.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

// Extend Express Request to include tenant context set by guards.
// This avoids `any` casts and provides type safety for downstream consumers.
declare module "express" {
  interface Request {
    user?: JwtValidatedUser;
    tenantContext?: TenantContext;
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      // JwtAuthGuard should always run before TenantGuard and populate
      // req.user. If we reach this branch, the guards are misconfigured.
      // Throw a 500 with a clear message rather than silently returning false
      // (which NestJS would convert to a bare 403 with no diagnostic context).
      throw new InternalServerErrorException(
        "TenantGuard: req.user is missing. JwtAuthGuard must run before TenantGuard."
      );
    }

    // Defense-in-depth trim. JwtStrategy already trims sub and agentId
    // for well-formed payloads, but if a future code path bypasses the
    // strategy (e.g., a test double or a custom AuthGuard) the values
    // here could carry whitespace from a misconfigured token issuer.
    // Trimming here keeps the contract honest: tenantContext fields are
    // always canonical (no leading/trailing whitespace), so downstream
    // equality checks (audit logs, idempotency keys, RLS) never see
    // " user-1" and "user-1" as distinct.
    if (typeof user.tenantId !== "string") {
      throw new InternalServerErrorException(
        "TenantGuard: tenantId is not a string. JWT payload is malformed."
      );
    }
    if (typeof user.userId !== "string") {
      throw new InternalServerErrorException(
        "TenantGuard: userId is not a string. JWT payload is malformed."
      );
    }
    const tenantId = user.tenantId.trim();
    const userId = user.userId.trim();
    if (!tenantId) {
      throw new InternalServerErrorException(
        "TenantGuard: tenantId is empty after trimming. JWT payload is malformed."
      );
    }
    if (!userId) {
      throw new InternalServerErrorException(
        "TenantGuard: userId is empty after trimming. JWT payload is malformed."
      );
    }
    const agentId =
      user.agentId === undefined || user.agentId === null
        ? undefined
        : (typeof user.agentId === "string" ? user.agentId.trim() : undefined);

    const tenantContext: TenantContext = {
      tenantId,
      userId,
      agentId: agentId === "" ? undefined : agentId,
    };

    request.tenantContext = tenantContext;
    return true;
  }
}
