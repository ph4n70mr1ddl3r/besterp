// Unit tests for HealthController
// Tests the health check endpoints that delegate to HealthService

import { describe, it, expect, vi, afterEach } from "vitest";
import { HealthController } from "./health.controller.js";
import { HealthStatus, VersionInfo } from "./health.service.js";

describe("HealthController", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  describe("getHealth", () => {
    it("should return health status", async () => {
      const expectedResponse: HealthStatus = {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: 1000,
        environment: "test",
        database: "connected",
        memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
      };

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue(expectedResponse),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.getHealth();

      expect(result).toEqual(expectedResponse);
      expect(mockHealthService.getHealth).toHaveBeenCalled();
    });

    it("should throw ServiceUnavailableException when database is disconnected (fail-closed)", async () => {
      // The basic /health endpoint now returns 503 when the database is
      // unreachable so load balancers and orchestrators can route traffic
      // away. /ready is still available for explicit readiness probes.
      const errorResponse: HealthStatus = {
        status: "error",
        timestamp: new Date().toISOString(),
        uptime: 500,
        environment: "test",
        database: "disconnected",
        memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
      };

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue(errorResponse),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);

      await expect(controller.getHealth()).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe("getVersion", () => {
    it("should return version information", async () => {
      const expectedResponse: VersionInfo = {
        version: "0.0.1",
        name: "@besterp/api",
        nodeVersion: process.version,
        environment: "test",
      };

      const mockHealthService = {
        getHealth: vi.fn(),
        getVersion: vi.fn().mockResolvedValue(expectedResponse),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.getVersion();

      expect(result).toEqual(expectedResponse);
      expect(mockHealthService.getVersion).toHaveBeenCalled();
    });

    it("should include build information when available", async () => {
      vi.stubEnv("BUILD_NUMBER", "123");
      vi.stubEnv("BUILD_DATE", "2024-01-01");

      const expectedResponse: VersionInfo = {
        version: "0.0.1",
        name: "@besterp/api",
        nodeVersion: process.version,
        environment: "test",
        build: {
          number: "123",
          date: "2024-01-01",
        },
      };

      const mockHealthService = {
        getHealth: vi.fn(),
        getVersion: vi.fn().mockResolvedValue(expectedResponse),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.getVersion();

      expect(result.build).toEqual(expectedResponse.build);
    });
  });

  describe("ready", () => {
    it("should return ready when database is connected", async () => {
      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "ok",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "connected",
          memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.ready();

      expect(result).toEqual({ status: "ready" });
    });

    it("should throw ServiceUnavailableException when database is disconnected", async () => {
      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "error",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "disconnected",
          memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);

      await expect(controller.ready()).rejects.toThrow("not ready");
    });

    it("should throw ServiceUnavailableException when health check times out", async () => {
      vi.useFakeTimers();

      // Simulate a database that never responds
      const mockHealthService = {
        getHealth: vi.fn().mockReturnValue(new Promise(() => {})),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const readyPromise = controller.ready();
      // Prevent vitest's unhandled rejection detector from flagging the
      // pending promise before vi.runAllTimersAsync triggers the timeout.
      readyPromise.catch(() => {});

      // Fire the 5-second timeout and flush all resulting microtasks
      await vi.runAllTimersAsync();

      await expect(readyPromise).rejects.toThrow("health check timed out");

      vi.useRealTimers();
    });

    it("should wrap unexpected errors in ServiceUnavailableException", async () => {
      const mockHealthService = {
        getHealth: vi.fn().mockRejectedValue(new Error("connection refused")),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);

      await expect(controller.ready()).rejects.toThrow("connection refused");
    });

    it("should clear the timeout on the success path (no leaked timer)", async () => {
      // Regression guard: the old code only cleared the timer in the success
      // branch and the throw path left a 5s timer pending (it was .unref()'d
      // so it didn't keep the process alive, but the callback still ran).
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(global, "clearTimeout");

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "ok",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "connected",
          memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      await controller.ready();

      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should clear the timeout on the failure path (finally block)", async () => {
      // Regression guard: the finally block must run on the failure path too,
      // so the 5s timer doesn't fire uselessly after a failed health check.
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(global, "clearTimeout");

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "error",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "disconnected",
          memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      await expect(controller.ready()).rejects.toThrow();

      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});
