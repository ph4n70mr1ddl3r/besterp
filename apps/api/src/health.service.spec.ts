// Unit tests for HealthService
// Tests health status computation, version info, and package.json loading

import { describe, it, expect, vi, afterEach } from "vitest";
import { HealthService } from "./health.service.js";

function createMockPrisma(queryResult: any = [{ result: 1 }]) {
  return {
    appClient: {
      $queryRaw: vi.fn().mockResolvedValue(queryResult),
    },
    admin: {
      $queryRaw: vi.fn().mockResolvedValue(queryResult),
    },
    tenantScoped: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    onModuleInit: vi.fn(),
    onModuleDestroy: vi.fn(),
  } as any;
}

describe("HealthService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getHealth", () => {
    it("should return ok status when database is connected", async () => {
      const service = new HealthService(createMockPrisma());
      const result = await service.getHealth();

      expect(result.status).toBe("ok");
      expect(result.database).toBe("connected");
      expect(result.timestamp).toBeTruthy();
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.environment).toBeTruthy();
      expect(result.memory.heapUsed).toBeGreaterThanOrEqual(0);
      expect(result.memory.heapTotal).toBeGreaterThanOrEqual(0);
      expect(result.memory.rss).toBeGreaterThanOrEqual(0);
      expect(result.memory.heapPercentage).toBeGreaterThanOrEqual(0);
      expect(result.memory.heapPercentage).toBeLessThanOrEqual(100);
    });

    it("should return error status when database query fails", async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.admin.$queryRaw.mockRejectedValue(new Error("Connection refused"));
      const service = new HealthService(mockPrisma);
      const result = await service.getHealth();

      expect(result.status).toBe("error");
      expect(result.database).toBe("disconnected");
    });

    it("should report NODE_ENV as environment", async () => {
      vi.stubEnv("NODE_ENV", "staging");
      const service = new HealthService(createMockPrisma());
      const result = await service.getHealth();

      expect(result.environment).toBe("staging");
    });

    it("should default environment to 'development' when NODE_ENV is unset", async () => {
      vi.stubEnv("NODE_ENV", undefined);
      const service = new HealthService(createMockPrisma());
      const result = await service.getHealth();

      expect(result.environment).toBe("development");
    });

    it("should report uptime in milliseconds", async () => {
      const service = new HealthService(createMockPrisma());
      const result = await service.getHealth();

      // Uptime should be roughly process.uptime() * 1000 (rounded)
      const expectedUptime = Math.round(process.uptime() * 1000);
      expect(Math.abs(result.uptime - expectedUptime)).toBeLessThan(500);
    });
  });

  describe("getVersion", () => {
    it("should return version info with defaults before init completes", async () => {
      const service = new HealthService(createMockPrisma());
      const result = await service.getVersion();

      expect(result.nodeVersion).toBe(process.version);
      expect(result.environment).toBeTruthy();
      // Package info may or may not be loaded depending on timing,
      // but the shape should be correct
      expect(result).toHaveProperty("version");
      expect(result).toHaveProperty("name");
    });

    it("should include BUILD_NUMBER and BUILD_DATE from env when available", async () => {
      vi.stubEnv("BUILD_NUMBER", "42");
      vi.stubEnv("BUILD_DATE", "2026-06-05");

      const service = new HealthService(createMockPrisma());
      const result = await service.getVersion();

      expect(result.build?.number).toBe("42");
      expect(result.build?.date).toBe("2026-06-05");
    });

    it("should omit build info when env vars are not set", async () => {
      vi.stubEnv("BUILD_NUMBER", undefined);
      vi.stubEnv("BUILD_DATE", undefined);

      const service = new HealthService(createMockPrisma());
      const result = await service.getVersion();

      expect(result.build?.number).toBeUndefined();
      expect(result.build?.date).toBeUndefined();
    });
  });
});
