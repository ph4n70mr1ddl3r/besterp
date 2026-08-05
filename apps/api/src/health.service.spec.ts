// Unit tests for HealthService
// Tests health status computation, version info, and package.json loading

import { describe, it, expect, vi, afterEach } from "vitest";
import { HealthService } from "./health.service.js";

const { redisConnectMock } = vi.hoisted(() => ({ redisConnectMock: vi.fn() }));

vi.mock("node:net", () => {
  class MockSocket {
    destroy() {}
    on() {
      return this;
    }
    write() {}
    connect(...args: unknown[]) {
      redisConnectMock(...args);
    }
  }
  return { Socket: MockSocket };
});
vi.mock("node:tls", () => ({
  connect: vi.fn(),
}));

function createMockPrisma(queryResult: any = [{ result: 1 }]) {
  return {
    appClient: {
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
      mockPrisma.appClient.$queryRaw.mockRejectedValue(new Error("Connection refused"));
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

    it("should skip the Redis probe and report disconnected for an invalid REDIS_PORT", async () => {
      // A typo'd REDIS_PORT (e.g. "abc") would otherwise feed NaN into
      // socket.connect() and surface as a misleading "disconnected" state. The
      // health check must skip the probe entirely (no connect attempt) and
      // report the misconfiguration as a configured-but-disconnected Redis so
      // the operator warning surfaces in the health payload.
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "not-a-port");
      redisConnectMock.mockClear();

      const service = new HealthService(createMockPrisma());
      const result = await service.getHealth();

      expect(redisConnectMock).not.toHaveBeenCalled();
      expect(result.redis).toBe("disconnected");
      expect(result.warning).toContain("Redis");
    });

    it("should skip the Redis probe and report disconnected when REDIS_PORT is explicitly '0'", async () => {
      // REDIS_PORT="0" must NOT silently fall back to DEFAULT_REDIS_PORT (6380).
      // The || operator treats "0" as falsy, so the explicit undefined check
      // in probeRedis() ensures an operator who sets port=0 gets a validation
      // error and a clear warning rather than connecting to the wrong port.
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "0");
      redisConnectMock.mockClear();

      const service = new HealthService(createMockPrisma());
      const result = await service.getHealth();

      expect(redisConnectMock).not.toHaveBeenCalled();
      expect(result.redis).toBe("disconnected");
      // The REDIS_PORT-specific validation warning goes to the logger; the
      // health body uses the generic disconnected warning regardless of cause.
      expect(result.warning).toContain("Redis");
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

    it("should redact name and version for anonymous /version callers in production", async () => {
      // The /version endpoint is anonymous (@Public()), so returning the exact
      // package name + semantic version in production fingerprints the build
      // and lets an attacker target known CVEs for that release. In production
      // the endpoint must return a generic, non-fingerprintable marker.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BUILD_NUMBER", undefined);
      vi.stubEnv("BUILD_DATE", undefined);

      const service = new HealthService(createMockPrisma());
      const result = await service.getVersion();

      expect(result.version).toBe("redacted");
      expect(result.name).toBe("redacted");
      expect(result.build).toBeUndefined();
      expect(result.warning).toBeUndefined();
    });

    it("should still disclose name and version outside production", async () => {
      // Non-production builds are not a deployed attack surface, so operators
      // still get the full triplet for debugging.
      vi.stubEnv("NODE_ENV", "staging");

      const service = new HealthService(createMockPrisma());
      const result = await service.getVersion();

      expect(result.version).not.toBe("redacted");
      expect(result.name).not.toBe("redacted");
    });

    it("should sanitize filesystem paths in the warning for anonymous /version callers", async () => {
      // The /version endpoint is anonymous (@Public()), so an init error
      // message (which can leak the container's filesystem layout, e.g.
      // "/app/dist/package.json not found") must not be reflected verbatim to
      // unauthenticated callers. It is scrubbed via sanitizeForLogOutput.
      vi.stubEnv("NODE_ENV", "staging");
      const service = new HealthService(createMockPrisma());
      // Force the init error path with a bad package.json location set.
      Object.defineProperty(service, "packageInfoError", {
        value: "ENOENT: no such file or directory, open '/srv/app/dist/package.json'",
        configurable: true,
      });
      const result = await service.getVersion();
      expect(JSON.stringify(result.warning)).not.toContain("/srv/app/dist");
    });
  });
});
