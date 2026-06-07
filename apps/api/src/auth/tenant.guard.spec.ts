// Unit tests for TenantGuard.
//
// The guard runs after JwtAuthGuard and expects req.user to be populated.
// Missing req.user indicates a guard-ordering misconfiguration and must
// surface as a 500 with a clear message rather than a silent 403.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExecutionContext, InternalServerErrorException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { TenantGuard } from "./tenant.guard.js";

function makeContext(opts: { user?: unknown; isPublic?: boolean }): ExecutionContext {
  const req: Record<string, unknown> = {};
  if ("user" in opts) req.user = opts.user;
  return {
    getHandler: () => ({} as any),
    getClass: () => ({} as any),
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

  it("allows public routes through without req.user", () => {
    (reflector.getAllAndOverride as any).mockReturnValue(true);
    const ctx = makeContext({}); // no user, but @Public()

    expect(guard.canActivate(ctx)).toBe(true);
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
});
