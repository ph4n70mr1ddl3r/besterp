// JWT Auth Guard — Enforces JWT authentication on REST endpoints.
//
// Applied globally via APP_GUARD. All endpoints require a valid JWT
// unless decorated with @Public(). Health endpoints are public.

import { Injectable, ExecutionContext } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { isPublicAllowedForHandler } from "./public-scope.js";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      isPublicAllowedForHandler(context);
      return true;
    }
    return super.canActivate(context);
  }
}
