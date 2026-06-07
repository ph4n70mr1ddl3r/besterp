// Unit tests for JwtStrategy — token validation and tenantId format checks.
//
// JwtStrategy extends PassportStrategy, which wires in JWT extraction +
// signature verification. We can't easily instantiate the real class in a
// unit test (it calls passport-jwt internals on construction), so we test
// the `validate()` method in isolation by stubbing the super constructor.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";

// Stub PassportStrategy so the constructor doesn't try to register with the
// global Passport instance. This isolates the `validate()` method for testing.
vi.mock("@nestjs/passport", () => ({
  PassportStrategy: (strategy: any) => {
    return class {
      constructor(_opts: unknown) {
        // No-op — bypass real passport registration.
      }
    };
  },
}));

vi.mock("passport-jwt", () => ({
  ExtractJwt: { fromAuthHeaderAsBearerToken: () => "extractor" },
  Strategy: class {},
}));

// Re-import after mocks are in place.
const { JwtStrategy } = await import("./jwt.strategy.js");

function makeStrategy() {
  // The constructor reads JWT_SECRET / NODE_ENV from process.env. The
  // production-secret check only triggers if NODE_ENV === "production" AND
  // JWT_SECRET is missing — neither of which is our test default.
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  return new JwtStrategy();
}

describe("JwtStrategy.validate", () => {
  let strategy: InstanceType<typeof JwtStrategy>;

  beforeEach(() => {
    strategy = makeStrategy();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  it("returns the validated user for a well-formed payload", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-acme",
      role: "admin",
    });
    expect(user).toEqual({
      userId: "user-1",
      tenantId: "tenant-acme",
      role: "admin",
      agentId: undefined,
    });
  });

  it("preserves agentId when present", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-acme",
      agentId: "agent-007",
    });
    expect(user.agentId).toBe("agent-007");
  });

  it("throws UnauthorizedException when sub is missing", async () => {
    await expect(
      strategy.validate({ sub: "" as any, tenantId: "tenant-1" })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when tenantId is missing", async () => {
    await expect(
      strategy.validate({ sub: "user-1", tenantId: "" as any })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects tenantId with disallowed characters (SQL-injection guard)", async () => {
    // The signed JWT may be valid, but the payload is user-controlled.
    // A tenantId containing ';' or ' ' would propagate into RLS context
    // if not caught here.
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "'; DROP TABLE party;--",
      })
    ).rejects.toThrow(); // InvalidTypeValueError from validateTenantIdEnhanced
  });

  it("rejects tenantId that is too long", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "a".repeat(101),
      })
    ).rejects.toThrow();
  });

  it("rejects tenantId containing whitespace", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "tenant with spaces",
      })
    ).rejects.toThrow();
  });
});
