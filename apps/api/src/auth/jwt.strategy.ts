// JWT Strategy — Passport strategy for validating JWT tokens.
//
// Tokens are signed with a shared secret (JWT_SECRET env var).
// Expected payload:
//   { sub: "<userId>", tenantId: "<tenantId>", role: "<role>" }
//
// The `validate()` method returns the value that gets attached to
// `req.user`, which the TenantGuard then uses to build TenantContext.

import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { validateTenantIdEnhanced } from "@besterp/database";
import { InvalidTypeValueError } from "@besterp/shared";

export interface JwtPayload {
  sub: string;      // user ID
  tenantId: string; // tenant ID
  role?: string;    // user role (optional)
  agentId?: string; // AI agent ID (for machine-to-machine)
}

export interface JwtValidatedUser {
  userId: string;
  tenantId: string;
  role?: string;
  agentId?: string;
}

export const JWT_DEV_SECRET = "besterp-dev-secret-change-me";
// Length cap for user/agent identifiers in the JWT. Matches the limit
// enforced later in McpModule.buildContext so a forged token carrying a
// 10MB identifier is rejected at the auth boundary rather than propagated
// into req.user / req.tenantContext / audit logs.
const MAX_USER_ID_LENGTH = 200;
const MAX_AGENT_ID_LENGTH = 200;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("JWT_SECRET must be set in production. Refusing to start with insecure default.");
      }
      console.warn(
        "⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in production!"
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret || JWT_DEV_SECRET,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtValidatedUser> {
    // `sub` MUST be a non-empty string. A forged token with `sub: 42`
    // (number) would otherwise propagate `userId: 42` to req.user and
    // later crash the MCP layer with a TypeError when the code calls
    // `userId.trim()`. Reject early with 401 ("bad token") so the failure
    // mode is consistent regardless of where the token is consumed.
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new UnauthorizedException("Invalid token: missing user ID (sub).");
    }
    if (payload.sub.length > MAX_USER_ID_LENGTH) {
      throw new UnauthorizedException(
        `Invalid token: user ID (sub) is too long (${payload.sub.length} chars, max ${MAX_USER_ID_LENGTH}).`
      );
    }
    if (typeof payload.tenantId !== "string" || payload.tenantId.length === 0) {
      throw new UnauthorizedException("Invalid token: missing tenantId.");
    }
    // Defense-in-depth: validate tenantId format at the auth boundary so a
    // forged-but-signed token carrying a malicious tenantId never reaches
    // tenant-scoped database operations.
    //
    // We catch InvalidTypeValueError and re-throw as UnauthorizedException so
    // the response status code is 401 ("your token is bad") rather than 422
    // ("your request was syntactically wrong"). Both reject the request, but
    // 401 is the canonical status for bad credentials and matches the
    // behavior of the other failure modes in this method.
    try {
      validateTenantIdEnhanced(payload.tenantId);
    } catch (e) {
      if (e instanceof InvalidTypeValueError) {
        throw new UnauthorizedException(
          "Invalid token: tenantId failed format validation."
        );
      }
      throw e;
    }

    // Optional agentId — if present, must be a string within the length
    // cap. Same rationale as `sub` above: prevent a multi-megabyte value
    // from reaching req.user / req.tenantContext / MCP buildContext.
    let agentId: string | undefined;
    if (payload.agentId !== undefined) {
      if (typeof payload.agentId !== "string") {
        throw new UnauthorizedException("Invalid token: agentId must be a string.");
      }
      if (payload.agentId.length > MAX_AGENT_ID_LENGTH) {
        throw new UnauthorizedException(
          `Invalid token: agentId is too long (${payload.agentId.length} chars, max ${MAX_AGENT_ID_LENGTH}).`
        );
      }
      agentId = payload.agentId;
    }

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      agentId,
    };
  }
}
