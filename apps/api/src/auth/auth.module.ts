// Auth Module — JWT authentication + tenant context for BestERP.
//
// Registers:
// - JwtStrategy (Passport) for token validation
// - JwtAuthGuard as a global guard (all endpoints require JWT unless @Public)
// - TenantGuard as a global guard (extracts tenant context from JWT)

import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import type { SignOptions } from "jsonwebtoken";
import { JwtStrategy, resolveJwtSecret } from "./jwt.strategy.js";

// JWT_EXPIRES_IN is validated strictly at startup in main.ts's validateEnvironment()
// (which exits the process on invalid values). Module-level validation is intentionally
// limited to a warning: ESM static imports are evaluated before main.ts runs, so a
// throw here would crash with an uncaught generic Error instead of the clean log +
// process.exit(1). jsonwebtoken silently falls back to its own default on invalid
// values rather than throwing, so we warn here to surface misconfigurations early.
const rawJwtExpiresIn = process.env.JWT_EXPIRES_IN || "24h";
if (process.env.JWT_EXPIRES_IN && !/^\d+[smhd]$/.test(process.env.JWT_EXPIRES_IN)) {
  console.warn(
    `[AuthModule] JWT_EXPIRES_IN "${process.env.JWT_EXPIRES_IN}" is invalid. ` +
    "Must be a duration string like '24h', '60m', '7d'. Falling back to '24h'."
  );
}
const jwtExpiresIn: SignOptions["expiresIn"] = rawJwtExpiresIn as SignOptions["expiresIn"];

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
