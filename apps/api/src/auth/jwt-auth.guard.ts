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

  canActivate(context: ExecutionContext) {
    // Check if the endpoint is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // @Public() is a global opt-out of authentication. For a multi-tenant
      // system it is a standing footgun: a single misplaced decorator silently
      // unauthenticates a route. Fail closed — only HealthController is
      // permitted to be public. Any other controller using @Public() throws at
      // request time (and is caught by the route-scan assertion in
      // main.ts), forcing an explicit decision instead of an implicit bypass.
      isPublicAllowedForHandler(context);
      return true;
    }
    return super.canActivate(context);
  }
}
