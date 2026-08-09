// Unit tests for the @Public() scope restriction (public-scope.ts).
//
// Covers both the per-request guard helper (isPublicAllowedForHandler) and the
// boot-time route-scan assertion (verifyPublicEndpointsScope) added to close
// the silent-bypass footgun: a @Public() on a dormant/non-Health controller
// must abort boot rather than only failing when an attacker hits the route.

import { describe, it, expect } from "vitest";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { isPublicAllowedForHandler, verifyPublicEndpointsScope } from "./public-scope.js";
import { HealthController } from "../health.controller.js";

class OtherController {}

function publicHandlerContext(controllerClass: unknown): ExecutionContext {
  return {
    getClass: () => controllerClass as object,
  } as unknown as ExecutionContext;
}

describe("isPublicAllowedForHandler", () => {
  it("allows @Public() on HealthController", () => {
    expect(() =>
      isPublicAllowedForHandler(publicHandlerContext(HealthController))
    ).not.toThrow();
  });

  it("throws ForbiddenException for @Public() on a non-health controller", () => {
    expect(() =>
      isPublicAllowedForHandler(publicHandlerContext(OtherController))
    ).toThrow(ForbiddenException);
  });
});

// Build a fake DiscoveryService whose getControllers() returns the supplied
// controller classes, each carrying the metadata that a real booted Nest app
// would have registered for @Public()-decorated handlers.
function fakeDiscovery(controllers: Array<{
  clazz: object;
  publicMethods?: string[];
  publicController?: boolean;
}>) {
  const wrappers = controllers.map((c) => {
    if (c.publicController) Reflect.defineMetadata(IS_PUBLIC_KEY, true, c.clazz);
    const prototype = (c.clazz as { prototype?: object }).prototype;
    if (prototype && c.publicMethods) {
      for (const m of c.publicMethods) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, m);
        if (descriptor?.value) Reflect.defineMetadata(IS_PUBLIC_KEY, true, descriptor.value);
      }
    }
    return {
      metatype: c.clazz,
      getPrototypeOf: () => prototype,
    } as unknown as ReturnType<import("@nestjs/core").DiscoveryService["getControllers"]>[number];
  });
  return {
    getControllers: () => wrappers,
    applicationRef: { get: () => ({}) },
  } as unknown as import("@nestjs/core").DiscoveryService;
}

describe("verifyPublicEndpointsScope", () => {
  it("passes when only HealthController is public", () => {
    expect(() =>
      verifyPublicEndpointsScope(fakeDiscovery([
        { clazz: HealthController },
        { clazz: OtherController },
      ]))
    ).not.toThrow();
  });

  it("throws when a non-health controller method is @Public()", () => {
    class PublicMethodController {
      exposed() {}
      safe() {}
    }
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, PublicMethodController.prototype.exposed);
    expect(() =>
      verifyPublicEndpointsScope(fakeDiscovery([
        { clazz: HealthController },
        { clazz: PublicMethodController },
      ]))
    ).toThrowError(/PublicMethodController\.exposed\(\)/);
  });

  it("throws when a non-health controller is @Public() at class level", () => {
    expect(() =>
      verifyPublicEndpointsScope(fakeDiscovery([
        { clazz: HealthController },
        { clazz: OtherController, publicController: true },
      ]))
    ).toThrowError(/OtherController \(controller-level @Public\(\)\)/);
  });

  it("throws when a @Public() handler is inherited from a shared base controller", () => {
    // Regression (round 115): the scan only inspected own properties, so a
    // @Public() handler defined on a non-registered base class and inherited by
    // a registered subclass slipped past the deploy-time abort (the per-request
    // check still threw, but only once an attacker actually hit the route).
    // The scan must walk the full prototype chain to catch inherited handlers.
    class SharedBase {
      healthCheck() {}
    }
    class DerivedController extends SharedBase {}
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, SharedBase.prototype.healthCheck);
    expect(() =>
      verifyPublicEndpointsScope(fakeDiscovery([
        { clazz: HealthController },
        { clazz: DerivedController },
      ]))
    ).toThrowError(/DerivedController\.healthCheck\(\)/);
  });

  it("lists every offending endpoint", () => {
    class BadA {
      leak() {}
    }
    class BadB {
      hole() {}
    }
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, BadA.prototype.leak);
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, BadB.prototype.hole);
    try {
      verifyPublicEndpointsScope(fakeDiscovery([
        { clazz: BadA },
        { clazz: BadB },
      ]));
      throw new Error("expected verifyPublicEndpointsScope to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("BadA.leak()");
      expect(message).toContain("BadB.hole()");
    }
  });
});
