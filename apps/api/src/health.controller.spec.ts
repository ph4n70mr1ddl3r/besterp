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
    it("should return a minimal, non-fingerprintable health status to anonymous callers", async () => {
      const expectedResponse: HealthStatus = {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: 1000,
        environment: "test",
        database: "connected",
        redis: "not_configured",
        memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
      };

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue(expectedResponse),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.getHealth();

      // The anonymous /health endpoint must NOT disclose environment/memory/
      // uptime (infrastructure fingerprinting). Only status/timestamp/database
      // are returned.
      expect(result).toEqual({
        status: "ok",
        timestamp: expectedResponse.timestamp,
        database: "connected",
      });
      expect(result).not.toHaveProperty("environment");
      expect(result).not.toHaveProperty("memory");
      expect(result).not.toHaveProperty("uptime");
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
        redis: "not_configured",
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
          redis: "not_configured",
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
          redis: "not_configured",
          memory: { heapUsed: 100, heapTotal: 200, rss: 150, heapPercentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);

      await expect(controller.ready()).rejects.toThrow("not ready");
    });

    it("should throw ServiceUnavailableException when health check times out", async () => {
      // Use a real timer — the ready() handler now uses a setTimeout-based
      // AbortController, not fake-timer machinery.
      const mockHealthService = {
        getHealth: vi.fn().mockReturnValue(new Promise(() => {})),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const readyPromise = controller.ready();
      void readyPromise.catch(() => {});

      await new Promise((r) => setTimeout(r, 50));
      vi.useRealTimers();

      await expect(readyPromise).rejects.toThrow("health check timed out");
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
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(global, "clearTimeout");

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "ok",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "connected",
          redis: "not_configured",
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
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(global, "clearTimeout");

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "error",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "disconnected",
          redis: "not_configured",
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
