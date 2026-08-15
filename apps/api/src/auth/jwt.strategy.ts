// JWT Strategy — Passport strategy for validating JWT tokens.
//
// Tokens are signed with a shared secret (JWT_SECRET env var).
// Expected payload:
//   { sub: "<userId>", tenantId: "<tenantId>", role: "<role>" }
//
// The `validate()` method returns the value that gets attached to
// `req.user`, which the TenantGuard then uses to build TenantContext.
//
// Optional: JWT_ISSUER env var enforces the token issuer claim. Tokens
// from an unexpected issuer are rejected. JWT_AUDIENCE similarly
// validates the `aud` claim. Both are off by default to avoid breaking
// existing deployments.

import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { randomBytes } from "node:crypto";
import { MAX_USER_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_ROLE_LENGTH, MAX_TENANT_ID_LENGTH, isProd, validateTenantIdEnhancedForAuth, sanitizeForLogOutput } from "@besterp/shared";

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

/** Internal cache for the resolved JWT secret — initialized once per process. */
const _jwtSecretCache = { value: undefined as string | undefined };
const _logger = new Logger("JwtSecret");

/**
 * Resolve the JWT secret from the environment. In production, JWT_SECRET is
 * required. In development, a random secret is generated so there is no
 * hardcoded value that could leak via stack traces or source control.
 *
 * The result is cached so both AuthModule (signing) and JwtStrategy
 * (verification) share the same secret. Thread-safe: concurrent callers
 * may compute the same value, but the result is idempotent (env var or
 * random bytes) so there is no correctness issue.
 */
export function resolveJwtSecret(): string {
  if (_jwtSecretCache.value !== undefined) return _jwtSecretCache.value;

  const secret = process.env.JWT_SECRET;
  if (secret) {
    _jwtSecretCache.value = secret;
    return secret;
  }
  if (isProd()) {
    throw new Error("JWT_SECRET must be set in production. Refusing to start with insecure default.");
  }
  _logger.warn(
    "JWT_SECRET not set — generating ephemeral secret for this session. Set JWT_SECRET in production!"
  );
  _jwtSecretCache.value = randomBytes(32).toString("hex");
  return _jwtSecretCache.value;
}

/**
 * Reset the cached JWT secret. Intended for use in tests between suites
 * to prevent cross-contamination from module-level state.
 */
export function resetJwtSecretCache(): void {
  _jwtSecretCache.value = undefined;
}

// Length caps for user/agent/role identifiers in the JWT. Imported from
// @besterp/shared/constants to avoid duplication and ensure the same limits
// are enforced at the auth boundary and in McpModule.buildContext.

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const issuer = process.env.JWT_ISSUER;
    const audience = process.env.JWT_AUDIENCE;
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSecret(),
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtValidatedUser> {
    const userId = this.validateRequiredField(payload.sub, "user ID (sub)", MAX_USER_ID_LENGTH);
    const tenantId = this.validateRequiredField(payload.tenantId, "tenantId", MAX_TENANT_ID_LENGTH);

    // Defense-in-depth: validate tenantId format at the auth boundary so a
    // forged-but-signed token carrying a malicious tenantId never reaches
    // tenant-scoped database operations.
    //
    // We catch InvalidTypeValueError and re-throw as UnauthorizedException so
    // the response status code is 401 ("your token is bad") rather than 422
    // ("your request was syntactically wrong"). Both reject the request, but
    // 401 is the canonical status for bad credentials and matches the
    // behavior of the other failure modes in this method.
    let validatedTenantId: string;
    try {
      validatedTenantId = validateTenantIdEnhancedForAuth(tenantId);
    } catch (e) {
      // Preserve the original error message for operator logs while still
      // returning 401 to the client. A bare "tenantId failed format validation"
      // loses the specific cause (e.g. INVALID_TENANT_ID vs a validation error),
      // making debugging harder.
      const msg = e instanceof Error ? e.message : String(e);
      _logger.warn(`Tenant validation failed for token: ${sanitizeForLogOutput(msg)}`);
      throw new UnauthorizedException(
        `Invalid token: tenantId failed format validation. ${msg}`,
      );
    }

    const agentId = this.validateOptionalField(payload.agentId, "agentId", MAX_AGENT_ID_LENGTH);
    const role = this.validateOptionalField(payload.role, "role", MAX_ROLE_LENGTH);

    return {
      userId,
      tenantId: validatedTenantId,
      role,
      agentId,
    };
  }

  private validateRequiredField(value: unknown, fieldName: string, maxLength: number): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new UnauthorizedException(`Invalid token: missing ${fieldName}.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new UnauthorizedException(`Invalid token: ${fieldName} is whitespace-only.`);
    }
    if (trimmed.length > maxLength) {
      throw new UnauthorizedException(
        `Invalid token: ${fieldName} is too long (${trimmed.length} chars, max ${maxLength}).`
      );
    }
    return trimmed;
  }

  private validateOptionalField(value: unknown, fieldName: string, maxLength: number): string | undefined {
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
}
