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
import { DiscoveryService } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
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

/**
 * Boot-time route-scan assertion (complement to the per-request check in
 * {@link isPublicAllowedForHandler}).
 *
 * The per-request check only fails when an attacker *happens* to hit a
 * mis-scoped route, so a `@Public()` placed on a dormant or newly-added
 * non-Health controller would pass `build`/`typecheck`/tests and ship
 * silently. This scan runs once at startup and inspects every registered
 * controller + handler: any handler carrying `IS_PUBLIC_KEY` metadata whose
 * controller is not `HealthController` aborts boot with a clear error, turning
 * the silent footgun into a deploy-time failure.
 *
 * Note: `JwtAuthGuard`/`TenantGuard` are applied as global APP_GUARDs, so
 * `IS_PUBLIC_KEY` is honoured on every controller — there is no per-guard
 * metadata scoping to worry about here.
 */
export function verifyPublicEndpointsScope(discovery: DiscoveryService): void {
  const controllers = discovery.getControllers();
  const offenders: string[] = [];
  for (const wrapper of controllers) {
    const controllerClass = wrapper.metatype;
    if (!controllerClass) continue;
    if (controllerClass === HealthController) continue;

    const isPublicOnController = Reflect.getMetadata(IS_PUBLIC_KEY, controllerClass) === true;
    if (isPublicOnController) {
      offenders.push(`${controllerClass.name} (controller-level @Public())`);
      continue;
    }

    // Walk the FULL prototype chain, not just own properties. A @Public()
    // handler defined on a shared base controller and inherited by a
    // non-Health subclass would otherwise slip past this scan (the base class
    // is not itself a registered controller, so it is never inspected). The
    // per-request check still throws at runtime (the strict `!==
    // HealthController` comparison also rejects subclasses), but the deploy-
    // time abort guarantee — the stated purpose of this scan — would be
    // silently weakened. Walk base classes so inherited handlers are flagged
    // too; stop at Object.prototype (no controller behavior there).
    let prototype = (controllerClass as { prototype?: object }).prototype ?? null;
    const seen = new Set<object>();
    while (prototype && prototype !== Object.prototype && !seen.has(prototype)) {
      seen.add(prototype);
      const methodNames = Object.getOwnPropertyNames(prototype);
      for (const methodName of methodNames) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
        if (!descriptor || typeof descriptor.value !== "function") continue;
        if (Reflect.getMetadata(IS_PUBLIC_KEY, descriptor.value) === true) {
          offenders.push(`${controllerClass.name}.${methodName}()`);
        }
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `@Public() is only permitted on HealthController (liveness probe). ` +
        `Boot aborted — the following endpoint(s) opt out of authentication and must be removed: ` +
        offenders.join(", ")
    );
  }
}
