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
    if (!payload.sub) {
      throw new UnauthorizedException("Invalid token: missing user ID (sub).");
    }
    if (!payload.tenantId) {
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

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      agentId: payload.agentId,
    };
  }
}
