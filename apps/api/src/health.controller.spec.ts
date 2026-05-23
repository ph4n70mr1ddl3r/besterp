// Unit tests for HealthController
// Tests the health check endpoints that delegate to HealthService

import { describe, it, expect, vi, afterEach } from "vitest";
import { HealthController } from "./health.controller.js";
import { HealthStatus, VersionInfo } from "./health.service.js";

describe("HealthController", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  describe("getHealth", () => {
    it("should return health status", async () => {
      const expectedResponse: HealthStatus = {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: 1000,
        environment: "test",
        database: "connected",
        memory: { used: 100, total: 200, percentage: 50 },
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

    it("should handle database connection errors", async () => {
      const errorResponse: HealthStatus = {
        status: "error",
        timestamp: new Date().toISOString(),
        uptime: 500,
        environment: "test",
        database: "disconnected",
        memory: { used: 100, total: 200, percentage: 50 },
      };

      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue(errorResponse),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.getHealth();

      expect(result.status).toBe("error");
      expect(result.database).toBe("disconnected");
    });
  });

  describe("getVersion", () => {
    it("should return version information", () => {
      const expectedResponse: VersionInfo = {
        version: "0.0.1",
        name: "@besterp/api",
        nodeVersion: process.version,
        environment: "test",
      };

      const mockHealthService = {
        getHealth: vi.fn(),
        getVersion: vi.fn().mockReturnValue(expectedResponse),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = controller.getVersion();

      expect(result).toEqual(expectedResponse);
      expect(mockHealthService.getVersion).toHaveBeenCalled();
    });

    it("should include build information when available", () => {
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
        getVersion: vi.fn().mockReturnValue(expectedResponse),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = controller.getVersion();

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
          memory: { used: 100, total: 200, percentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.ready();

      expect(result).toEqual({ status: "ready" });
    });

    it("should return not ready when database is disconnected", async () => {
      const mockHealthService = {
        getHealth: vi.fn().mockResolvedValue({
          status: "error",
          timestamp: new Date().toISOString(),
          uptime: 1000,
          environment: "test",
          database: "disconnected",
          memory: { used: 100, total: 200, percentage: 50 },
        }),
        getVersion: vi.fn(),
      };

      const controller = new HealthController(mockHealthService as any);
      const result = await controller.ready();

      expect(result).toEqual({ status: "not ready" });
    });
  });
});
