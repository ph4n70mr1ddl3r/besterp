// Tenant Guard — Extracts tenant context from the authenticated user.
//
// Runs AFTER JwtAuthGuard. Reads the validated user from `req.user`
// and attaches a TenantContext to the request for downstream services.
//
// Services inject REQUEST and read the TenantContext to get the
// tenant-scoped PrismaClient with RLS enforcement.

import {
  Injectable,
  ExecutionContext,
  CanActivate,
  Inject,
  Scope,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import { Request } from "express";
import { JwtValidatedUser } from "./jwt.strategy";
import { TenantContext } from "../common/tenant-context";

@Injectable({ scope: Scope.REQUEST })
export class TenantGuard implements CanActivate {
  constructor(@Inject(REQUEST) private readonly request: Request) {}

  canActivate(context: ExecutionContext): boolean {
    const user = this.request.user as JwtValidatedUser | undefined;

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

    (this.request as any).tenantContext = tenantContext;
    return true;
  }
}
