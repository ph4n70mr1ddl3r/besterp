// Unit tests for HealthService
// Tests health status computation, version info, and package.json loading

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthService } from "./health.service.js";
import { DEFAULT_REDIS_PORT } from "@besterp/shared";

const { redisConnectMock, socketMocks } = vi.hoisted(() => ({
  redisConnectMock: vi.fn(),
  socketMocks: [] as Array<{
    writes: string[];
    handlers: Record<string, (data?: unknown) => void>;
    destroyed: boolean;
    emit: (event: string, data?: unknown) => void;
  }>,
}));

vi.mock("node:net", () => {
  class MockSocket {
    writes: string[];
    handlers: Record<string, (data?: unknown) => void>;
    destroyed: boolean;
    constructor() {
      this.writes = [];
      this.handlers = {};
      this.destroyed = false;
      socketMocks.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
    on(event: string, handler: (data?: unknown) => void) {
      this.handlers[event] = handler;
      return this;
    }
    write(chunk: string) {
      this.writes.push(chunk);
    }
    connect(...args: unknown[]) {
      redisConnectMock(...args);
    }
    emit(event: string, data?: unknown) {
      this.handlers[event]?.(data);
    }
  }
  return { Socket: MockSocket };
});
vi.mock("node:tls", () => ({
  connect: vi.fn(),
}));

/** Emit the connect + data sequence a real probe would receive to reach a result. */
async function runProbe(frames: string[]): Promise<void> {
  await vi.waitFor(() => expect(socketMocks.length).toBeGreaterThan(0));
  const sock = socketMocks[socketMocks.length - 1]!;
  sock.emit("connect");
  for (const frame of frames) sock.emit("data", frame);
}

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
  beforeEach(() => {
    // Reset per-process static warning flags so each test starts with a clean
    // slate — otherwise a prior test that triggered the REDIS_PORT or
    // connection-failure warning would suppress the same warning in later tests.
    (HealthService as unknown as { _redisPortWarned: boolean; _redisConnectionWarned: boolean })._redisPortWarned = false;
    (HealthService as unknown as { _redisPortWarned: boolean; _redisConnectionWarned: boolean })._redisConnectionWarned = false;
    socketMocks.length = 0;
    redisConnectMock.mockClear();
  });

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

  describe("probeRedis", () => {
    beforeEach(() => {
      // Force the plaintext (net.Socket) path: with NODE_ENV unset,
      // resolveRedisTls() returns true and the probe would use tls.connect
      // (a bare vi.fn() in tests) instead of the socket we assert on.
      vi.stubEnv("REDIS_TLS", "0");
    });

    it("frames AUTH as a RESP array so a space-bearing password survives transport", async () => {
      // Regression (round 115): the probe wrote an inline command
      // (`AUTH my redis pass\r\n`), which Redis splits on whitespace — a
      // passphrase with a space produced WRONGPASS and a permanent false
      // "disconnected" while the real queue (ioredis, RESP bulk strings)
      // connected fine. The probe must emit `*2\r\n$4\r\nAUTH\r\n$13\r\n…`.
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "6379");
      vi.stubEnv("REDIS_PASSWORD", "my redis pass");
      const service = new HealthService(createMockPrisma());

      const resultPromise = service.getHealth();
      await runProbe(["+OK\r\n", "+PONG\r\n"]);
      const result = await resultPromise;

      expect(result.redis).toBe("connected");
      const writes = socketMocks[0]!.writes.join("");
      expect(writes).toContain("*2\r\n$4\r\nAUTH\r\n$13\r\nmy redis pass\r\n");
      expect(writes).not.toContain("AUTH my redis pass");
      expect(writes).toContain("*1\r\n$4\r\nPING\r\n");
    });

    it("does NOT resolve as connected on AUTH +OK alone — only +PONG proves command execution", async () => {
      // Regression (round 115): the previous probe resolved on any +OK, so a
      // degraded Redis that accepted AUTH but could not run PING reported
      // "connected" and hid the outage. The result must only settle on the
      // PING round-trip (+PONG).
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "6379");
      const service = new HealthService(createMockPrisma());

      let settled = false;
      const resultPromise = service.getHealth().finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(socketMocks.length).toBeGreaterThan(0));
      const sock = socketMocks[0]!;
      sock.emit("connect");
      sock.emit("data", "+OK\r\n");
      // Give any (incorrect) early resolve a chance to fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);

      sock.emit("data", "+PONG\r\n");
      const result = await resultPromise;
      expect(result.redis).toBe("connected");
    });

    it("reports disconnected on -WRONGPASS from AUTH", async () => {
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "6379");
      const service = new HealthService(createMockPrisma());

      const resultPromise = service.getHealth();
      await runProbe(["-WRONGPASS invalid username-password pair or user is disabled.\r\n"]);
      const result = await resultPromise;

      expect(result.redis).toBe("disconnected");
      expect(result.warning).toContain("Redis");
    });

    it("serves a cached result so a second poll opens no new socket (DoS bound)", async () => {
      // Regression (round 115): the anonymous /health endpoint opened a fresh
      // outbound socket per request, so an unauthenticated attacker hammering
      // it could exhaust FDs / Redis maxclients. The short-TTL cache must
      // collapse concurrent/frequent polls to one socket per TTL.
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "6379");
      const service = new HealthService(createMockPrisma());

      const p1 = service.getHealth();
      await runProbe(["+PONG\r\n"]);
      await p1;
      const p2 = service.getHealth();
      await p2;

      expect(socketMocks.length).toBe(1);
      expect(redisConnectMock).toHaveBeenCalledTimes(1);
      expect((await p2).redis).toBe("connected");
    });

    it("treats an empty/whitespace REDIS_PORT as unset and falls back to the default port", async () => {
      // Regression (round 115): `REDIS_PORT=` / `REDIS_PORT="   "` previously
      // Number()'d to 0 and reported "disconnected" while the queue connected
      // on the dev default — a monitoring blind spot.
      vi.stubEnv("REDIS_HOST", "localhost");
      vi.stubEnv("REDIS_PORT", "   ");
      const service = new HealthService(createMockPrisma());

      const resultPromise = service.getHealth();
      await runProbe(["+PONG\r\n"]);
      const result = await resultPromise;

      expect(result.redis).toBe("connected");
      expect(redisConnectMock).toHaveBeenCalledWith(DEFAULT_REDIS_PORT, "localhost");
    });
  });
});
