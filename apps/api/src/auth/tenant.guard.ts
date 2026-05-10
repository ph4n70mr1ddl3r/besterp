// Tenant Guard — Extracts tenant context from the authenticated user.
//
// Runs AFTER JwtAuthGuard. Reads the validated user from `req.user`
// and attaches a TenantContext to the request for downstream services.
//
// Note: This guard is registered as a SINGLETON (default scope), not
// request-scoped. It accesses the request via the ExecutionContext,
// which is safe because NestJS provides a fresh ExecutionContext per request.

import { Injectable, ExecutionContext, CanActivate } from "@nestjs/common";
import { Request } from "express";
import { JwtValidatedUser } from "./jwt.strategy";
import { TenantContext } from "../common/tenant-context";

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as JwtValidatedUser | undefined;

    if (!user) {
      // This shouldn't happen if JwtAuthGuard ran first, but defense-in-depth
      return false;
    }

    // Attach TenantContext to the request for service-layer consumption
    const tenantContext: TenantContext = {
      tenantId: user.tenantId,
      userId: user.userId,
      agentId: user.agentId,
    };

    (request as any).tenantContext = tenantContext;
    return true;
  }
}
