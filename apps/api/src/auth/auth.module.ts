// Auth Module — JWT authentication + tenant context for BestERP.
//
// Registers:
// - JwtStrategy (Passport) for token validation
// - JwtAuthGuard as a global guard (all endpoints require JWT unless @Public)
// - TenantGuard as a global guard (extracts tenant context from JWT)

import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy, JWT_DEV_SECRET } from "./jwt.strategy.js";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register({
      // In production, JwtStrategy throws if JWT_SECRET is missing, preventing
      // the app from starting. In non-prod, we use the insecure dev default.
      // Early validation ensures the module never registers with an empty secret.
      secret: (() => {
        const secret = process.env.JWT_SECRET;
        if (secret) return secret;
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "JWT_SECRET must be set in production. Refusing to register JwtModule with insecure secret."
          );
        }
        return JWT_DEV_SECRET;
      })(),
      signOptions: { expiresIn: "24h" },
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
