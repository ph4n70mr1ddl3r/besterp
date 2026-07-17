// Scope restriction for the @Public() decorator.
//
// @Public() is a global opt-out of JWT authentication. For a multi-tenant
// system that is a standing footgun: a single misplaced decorator silently
// unauthenticates a route, exposing tenant data to anonymous callers. To keep
// the convenience of an opt-out while closing the silent-bypass path, @Public()
// is only permitted on HealthController (the load-balancer liveness/version
// probe). Any other controller that uses it fails closed at request time and
// is also caught by the boot-time route-scan assertion in main.ts.

import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { HealthController } from "../health.controller.js";

/**
 * Throw ForbiddenException if the handler marked @Public() is not on
 * HealthController. Called from both JwtAuthGuard and TenantGuard so the
 * scope rule cannot be bypassed by a guard ordering trick.
 */
export function isPublicAllowedForHandler(context: ExecutionContext): void {
  const controllerClass = context.getClass();
  if (controllerClass && controllerClass !== HealthController) {
    throw new ForbiddenException(
      `@Public() is only permitted on HealthController (liveness probe). ` +
        `Refusing to authenticate. '${controllerClass.name}' must not opt out of authentication.`
    );
  }
}
