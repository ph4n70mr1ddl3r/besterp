// Unit tests for TenantGuard.
//
// The guard runs after JwtAuthGuard and expects req.user to be populated.
// Missing req.user indicates a guard-ordering misconfiguration and must
// surface as a 500 with a clear message rather than a silent 403.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExecutionContext, ForbiddenException, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { TenantGuard } from "./tenant.guard.js";
import { HealthController } from "../health.controller.js";

function makeContext(opts: { user?: unknown; isPublic?: boolean; controllerClass?: unknown }): ExecutionContext {
  const req: Record<string, unknown> = {};
  if ("user" in opts) req.user = opts.user;
  return {
    getHandler: () => ({} as any),
    getClass: () => (opts.controllerClass ?? {}) as any,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({} as any),
      getNext: () => (() => {}) as any,
    }),
  } as unknown as ExecutionContext;
}

describe("TenantGuard", () => {
  let guard: TenantGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() } as unknown as Reflector;
    guard = new TenantGuard(reflector);
  });

  it("throws InternalServerErrorException when req.user is missing", () => {
    // @Public() metadata not set
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({}); // no user

    expect(() => guard.canActivate(ctx)).toThrow(InternalServerErrorException);
  });

  it("the thrown error mentions guard ordering for diagnostics", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({});

    try {
      guard.canActivate(ctx);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/TenantGuard/);
      expect((err as Error).message).toMatch(/JwtAuthGuard/);
    }
  });

  it("allows public routes through without req.user when on HealthController", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(true);
    const ctx = makeContext({ controllerClass: HealthController }); // no user, but @Public()

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("refuses @Public() on a non-health controller (fail-closed scope)", () => {
    // @Public() is a global authentication opt-out. A misplaced decorator on a
    // tenant-scoped controller would silently expose data to anonymous callers,
    // so the guard must fail closed and refuse the request.
    (reflector.getAllAndOverride as any).mockReturnValue(true);
    const ctx = makeContext({ controllerClass: class OtherController {} });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("attaches TenantContext from req.user on non-public routes", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "u1", tenantId: "t1", agentId: "a1" },
    });

    const ok = guard.canActivate(ctx);
    expect(ok).toBe(true);

    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.tenantContext).toEqual({
      tenantId: "t1",
      userId: "u1",
      agentId: "a1",
    });
  });

  it("trims userId, tenantId, and agentId when building tenantContext", () => {
    // Defense-in-depth: if a future code path bypasses JwtStrategy's
    // trimming, the guard still canonicalises the values so audit logs
    // and idempotency records never see padded strings.
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "  u1  ", tenantId: "  t1  ", agentId: "  a1  " },
    });

    guard.canActivate(ctx);

    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.tenantContext).toEqual({
      tenantId: "t1",
      userId: "u1",
      agentId: "a1",
    });
  });

  it("normalises empty-string agentId to undefined in tenantContext", async () => {
    // Consistency with JwtStrategy: an empty-string agentId from any
    // source is treated as "no agent" downstream.
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "u1", tenantId: "t1", agentId: "" },
    });

    guard.canActivate(ctx);

    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.tenantContext.agentId).toBeUndefined();
  });

  it("throws UnauthorizedException when tenantId is not a string", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "u1", tenantId: 42 },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when userId is not a string", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: 42, tenantId: "t1" },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when agentId is not a string", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "u1", tenantId: "t1", agentId: 42 },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when tenantId is empty after trimming", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "u1", tenantId: "   " },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when userId is empty after trimming", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(false);
    const ctx = makeContext({
      user: { userId: "   ", tenantId: "t1" },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
