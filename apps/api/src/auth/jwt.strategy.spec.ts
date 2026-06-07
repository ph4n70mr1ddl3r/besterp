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
    // if not caught here. The strategy re-throws as UnauthorizedException
    // so the response is 401 ("bad token"), not 422 ("bad request").
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "'; DROP TABLE party;--",
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects tenantId that is too long", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "a".repeat(101),
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects tenantId containing whitespace", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "tenant with spaces",
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects non-string sub (forged token with numeric sub claim)", async () => {
    // The JWT spec says sub is a StringOrURI, but a forged token could
    // carry a number. Without the typeof guard, payload.sub (42) would
    // pass the truthy check and propagate to req.user.userId = 42, then
    // crash the MCP layer with a TypeError on userId.trim().
    await expect(
      strategy.validate({ sub: 42 as any, tenantId: "tenant-1" })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects sub exceeding the length cap", async () => {
    // Defense against multi-megabyte identifiers in forged tokens.
    await expect(
      strategy.validate({ sub: "x".repeat(201), tenantId: "tenant-1" })
    ).rejects.toThrow(/user ID \(sub\) is too long/);
  });

  it("accepts sub at the length cap", async () => {
    const user = await strategy.validate({
      sub: "x".repeat(200),
      tenantId: "tenant-1",
    });
    expect(user.userId).toBe("x".repeat(200));
  });

  it("rejects non-string agentId", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "tenant-1",
        agentId: 42 as any,
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects agentId exceeding the length cap", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "tenant-1",
        agentId: "x".repeat(201),
      })
    ).rejects.toThrow(/agentId is too long/);
  });

  it("accepts agentId at the length cap", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
      agentId: "x".repeat(200),
    });
    expect(user.agentId).toBe("x".repeat(200));
  });

  it("omits agentId when not in the payload", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
    });
    expect(user.agentId).toBeUndefined();
  });

  it("trims sub (leading/trailing whitespace) before returning the user", async () => {
    // Defense-in-depth: a forged-but-signed token with "  user-1  " would
    // otherwise carry that padded string into req.user.userId and into
    // audit logs, breaking equality checks like "user-1" vs " user-1 ".
    // The MCP layer already trims userId; doing it here keeps the REST
    // path consistent.
    const user = await strategy.validate({
      sub: "  user-1  ",
      tenantId: "tenant-1",
    });
    expect(user.userId).toBe("user-1");
  });

  it("rejects whitespace-only sub", async () => {
    // After trim, "   " is empty — same failure mode as a missing sub.
    await expect(
      strategy.validate({ sub: "   ", tenantId: "tenant-1" })
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      strategy.validate({ sub: "   ", tenantId: "tenant-1" })
    ).rejects.toThrow(/whitespace-only/);
  });

  it("trims agentId before returning", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
      agentId: "  agent-007  ",
    });
    expect(user.agentId).toBe("agent-007");
  });

  it("normalises empty-string agentId to undefined", async () => {
    // Inconsistency guard: without normalisation, agentId: "" propagates
    // to req.user.agentId = "" and bypasses the MCP buildContext's
    // "empty-string → undefined" rule. Downstream code then has to
    // distinguish "no agent" from "empty-string agent".
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
      agentId: "",
    });
    expect(user.agentId).toBeUndefined();
  });

  it("normalises whitespace-only agentId to undefined", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
      agentId: "   ",
    });
    expect(user.agentId).toBeUndefined();
  });

  it("rejects non-string role (forged token with numeric role claim)", async () => {
    // Defense-in-depth: role is currently unused downstream, but a forged
    // token could carry role: 42 (number) and the value would propagate
    // to req.user.role. Reject at the auth boundary for consistency with
    // the sub / agentId checks.
    await expect(
      strategy.validate({ sub: "user-1", tenantId: "tenant-1", role: 42 as any })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects role exceeding the length cap", async () => {
    await expect(
      strategy.validate({
        sub: "user-1",
        tenantId: "tenant-1",
        role: "x".repeat(101),
      })
    ).rejects.toThrow(/role is too long/);
  });

  it("trims and stores a valid role", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
      role: "  admin  ",
    });
    expect(user.role).toBe("admin");
  });

  it("normalises whitespace-only role to undefined", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
      role: "   ",
    });
    expect(user.role).toBeUndefined();
  });

  it("omits role when not in the payload", async () => {
    const user = await strategy.validate({
      sub: "user-1",
      tenantId: "tenant-1",
    });
    expect(user.role).toBeUndefined();
  });
});
