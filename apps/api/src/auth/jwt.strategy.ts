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
import { randomBytes } from "node:crypto";
import { validateTenantIdEnhanced } from "@besterp/database";
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_ROLE_LENGTH } from "@besterp/shared";

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

/**
 * Resolve the JWT secret from the environment. In production, JWT_SECRET is
 * required. In development, a random secret is generated at startup so there
 * is no hardcoded value that could leak via stack traces or source control.
 *
 * The result is cached so both AuthModule (signing) and JwtStrategy
 * (verification) share the same secret.
 */
let _cachedSecret: string | undefined;
export function resolveJwtSecret(): string {
  if (_cachedSecret !== undefined) return _cachedSecret;
  const secret = process.env.JWT_SECRET;
  if (secret) {
    _cachedSecret = secret;
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production. Refusing to start with insecure default.");
  }
  console.warn(
    "⚠️  JWT_SECRET not set — generating ephemeral secret for this session. Set JWT_SECRET in production!"
  );
  _cachedSecret = randomBytes(32).toString("hex");
  return _cachedSecret;
}

/**
 * Reset the cached JWT secret. Intended for use in tests between suites
 * to prevent cross-contamination from module-level state.
 */
export function resetJwtSecretCache(): void {
  _cachedSecret = undefined;
}

// Length caps for user/agent/role identifiers in the JWT. Imported from
// @besterp/shared/constants to avoid duplication and ensure the same limits
// are enforced at the auth boundary and in McpModule.buildContext.

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSecret(),
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
    // Trim sub so a forged-but-signed token carrying "  user-1  " can't
    // bypass equality checks (e.g., "user-1" vs " user-1 ") in
    // tenant-scoped audit logs and idempotency records. The MCP layer
    // already trims userId; doing it here keeps the REST path consistent.
    const userId = payload.sub.trim();
    if (userId.length === 0) {
      throw new UnauthorizedException("Invalid token: user ID (sub) is whitespace-only.");
    }
    if (userId.length > MAX_USER_ID_LENGTH) {
      throw new UnauthorizedException(
        `Invalid token: user ID (sub) is too long after trim (${userId.length} chars, max ${MAX_USER_ID_LENGTH}).`
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
    //
    // Empty strings are normalised to undefined so the rest of the codebase
    // (audit logs, MCP buildContext, tenant context) never has to
    // distinguish between "no agent" and "empty-string agent". This matches
    // the behaviour of McpModule.validateOptionalField for idempotencyKey /
    // agentId / conversationId.
    let agentId: string | undefined;
    if (payload.agentId !== undefined && payload.agentId !== null) {
      if (typeof payload.agentId !== "string") {
        throw new UnauthorizedException("Invalid token: agentId must be a string.");
      }
      const trimmedAgentId = payload.agentId.trim();
      if (trimmedAgentId.length > 0) {
        if (trimmedAgentId.length > MAX_AGENT_ID_LENGTH) {
          throw new UnauthorizedException(
            `Invalid token: agentId is too long (${trimmedAgentId.length} chars, max ${MAX_AGENT_ID_LENGTH}).`
          );
        }
        agentId = trimmedAgentId;
      }
    }

    // Optional role — must be a string within the length cap if present.
    // Without this, a forged token could carry role: <10MB string> or
    // role: 42 (number), and the value would propagate to req.user.role.
    // role is currently unused downstream, but the same defense-in-depth
    // rationale as sub/agentId applies: reject malformed claims at the
    // auth boundary rather than carrying them through the system.
    let role: string | undefined;
    if (payload.role !== undefined && payload.role !== null) {
      if (typeof payload.role !== "string") {
        throw new UnauthorizedException("Invalid token: role must be a string.");
      }
      const trimmedRole = payload.role.trim();
      if (trimmedRole.length === 0) {
        // Whitespace-only role: treat as not provided, consistent with agentId.
        role = undefined;
      } else if (trimmedRole.length > MAX_ROLE_LENGTH) {
        throw new UnauthorizedException(
          `Invalid token: role is too long (${trimmedRole.length} chars, max ${MAX_ROLE_LENGTH}).`
        );
      } else {
        role = trimmedRole;
      }
    }

    return {
      userId,
      tenantId: payload.tenantId.trim(),
      role,
      agentId,
    };
  }
}
