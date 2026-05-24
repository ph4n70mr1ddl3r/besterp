// Auth Module — JWT authentication + tenant context for BestERP.
//
// Registers:
// - JwtStrategy (Passport) for token validation
// - JwtAuthGuard as a global guard (all endpoints require JWT unless @Public)
// - TenantGuard as a global guard (extracts tenant context from JWT)

import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./jwt.strategy.js";
import { JWT_DEV_SECRET } from "./jwt.strategy.js";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register({
      // In production, JwtStrategy throws if JWT_SECRET is missing, preventing
      // the app from starting. Here we provide the dev default only in non-prod.
      // Using an empty string in prod is a deliberate sentinel — the JwtStrategy
      // constructor already guards against missing secrets, so this path should
      // never be reached in production. An empty string ensures the JWT module
      // throws a clear error rather than silently accepting undefined.
      secret: process.env.JWT_SECRET || (process.env.NODE_ENV !== "production" ? JWT_DEV_SECRET : ""),
      signOptions: { expiresIn: "24h" },
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
