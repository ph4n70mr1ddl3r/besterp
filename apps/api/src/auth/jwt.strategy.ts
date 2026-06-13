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
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_ROLE_LENGTH, MAX_TENANT_ID_LENGTH } from "@besterp/shared";

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
 * Validate and trim a required string field from JWT payload.
 * Throws UnauthorizedException if invalid.
 */
function validateAndTrimRequired(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnauthorizedException(`Invalid token: missing ${fieldName}.`);
  }
  if (value.length > maxLength) {
    throw new UnauthorizedException(
      `Invalid token: ${fieldName} is too long (${value.length} chars, max ${maxLength}).`
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new UnauthorizedException(`Invalid token: ${fieldName} is whitespace-only.`);
  }
  if (trimmed.length > maxLength) {
    throw new UnauthorizedException(
      `Invalid token: ${fieldName} is too long after trim (${trimmed.length} chars, max ${maxLength}).`
    );
  }
  return trimmed;
}

/**
 * Validate and trim an optional string field from JWT payload.
 * Returns undefined if not provided or whitespace-only.
 * Throws UnauthorizedException if invalid type or too long.
 */
function validateAndTrimOptional(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new UnauthorizedException(`Invalid token: ${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new UnauthorizedException(
      `Invalid token: ${fieldName} is too long (${trimmed.length} chars, max ${maxLength}).`
    );
  }
  return trimmed;
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
    const userId = validateAndTrimRequired(payload.sub, "user ID (sub)", MAX_USER_ID_LENGTH);
    const tenantId = validateAndTrimRequired(payload.tenantId, "tenantId", MAX_TENANT_ID_LENGTH);

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
      validateTenantIdEnhanced(tenantId);
    } catch (e) {
      if (e instanceof InvalidTypeValueError) {
        throw new UnauthorizedException(
          "Invalid token: tenantId failed format validation."
        );
      }
      throw e;
    }

    const agentId = validateAndTrimOptional(payload.agentId, "agentId", MAX_AGENT_ID_LENGTH);
    const role = validateAndTrimOptional(payload.role, "role", MAX_ROLE_LENGTH);

    return {
      userId,
      tenantId,
      role,
      agentId,
    };
  }
}
