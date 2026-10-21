// Auth Module — JWT authentication + tenant context for BestERP.
//
// Registers:
// - JwtStrategy (Passport) for token validation
// - JwtAuthGuard as a global guard (all endpoints require JWT unless @Public)
// - TenantGuard as a global guard (extracts tenant context from JWT)
//
// JWT_EXPIRES_IN validation is performed strictly at startup in main.ts's
// validateEnvironment() which exits the process on invalid values. This module
// trusts that validation and uses the value directly — no duplicate guard
// needed here, and doing so avoids the inconsistency where dev would silently
// fall back to "24h" while production crashes.

import { Module } from "@nestjs/common";
import { JwtModule, type JwtSignOptions } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy, resolveJwtSecret } from "./jwt.strategy.js";

// `||` (not `??`): an EMPTY JWT_EXPIRES_IN is a falsy-but-present value that
// `??` passes through unchanged, and jsonwebtoken REJECTS `expiresIn: ""`
// ("expiresIn should be a number of seconds or string representing a
// timespan") — so every token-signing call threw at runtime. main.ts now also
// rejects an empty JWT_EXPIRES_IN at boot, but this module must not depend on
// the boot path having run.
const configuredExpiresIn = process.env.JWT_EXPIRES_IN?.trim();
const jwtExpiresIn: JwtSignOptions["expiresIn"] = (configuredExpiresIn && configuredExpiresIn.length > 0 ? configuredExpiresIn : "24h") as JwtSignOptions["expiresIn"];

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register({
      // JwtStrategy validates JWT_SECRET on construction — it throws in
      // production if the env var is missing, preventing the app from starting.
      // We read the resolved secret here so both JwtModule and JwtStrategy
      // use the same value without duplicating the validation logic.
      secret: resolveJwtSecret(),
      signOptions: { expiresIn: jwtExpiresIn },
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
