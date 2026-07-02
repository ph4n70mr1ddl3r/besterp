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

const jwtExpiresIn: SignOptions["expiresIn"] =
  (process.env.JWT_EXPIRES_IN || "24h") as SignOptions["expiresIn"];

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
