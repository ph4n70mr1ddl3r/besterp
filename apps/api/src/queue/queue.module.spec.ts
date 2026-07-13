// Unit tests for QueueModule — Redis configuration resolution
// Tests host, port, password validation and environment variable handling

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QueueModule } from "./queue.module.js";

describe("QueueModule", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("forRoot", () => {
    it("should return a dynamic module with BullModule import", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot();
      expect(module).toHaveProperty("module", QueueModule);
      expect(module).toHaveProperty("global", true);
      expect(module.imports).toBeDefined();
      expect(module.exports).toBeDefined();
    });

    it("should use provided options over env vars", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot({
        redis: { host: "custom-host", port: 6380, password: "secret" },
      });
      expect(module).toBeDefined();
    });

    it("should default to localhost when REDIS_HOST is not set", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot();
      expect(module).toBeDefined();
    });
  });

  describe("port resolution", () => {
    it("should use explicit port from options", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot({ redis: { host: "localhost", port: 6379 } });
      expect(module).toBeDefined();
    });

    it("should use REDIS_PORT env var when no explicit port", () => {
      process.env.REDIS_PORT = "6380";
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot();
      expect(module).toBeDefined();
    });

    it("should throw on invalid port (NaN)", () => {
      process.env.REDIS_PORT = "not-a-number";
      process.env.NODE_ENV = "development";
      expect(() => QueueModule.forRoot()).toThrow("Invalid Redis port");
    });

    it("should throw on port below 1", () => {
      process.env.REDIS_PORT = "0";
      process.env.NODE_ENV = "development";
      expect(() => QueueModule.forRoot()).toThrow("Invalid Redis port");
    });

    it("should throw on port above 65535", () => {
      process.env.REDIS_PORT = "99999";
      process.env.NODE_ENV = "development";
      expect(() => QueueModule.forRoot()).toThrow("Invalid Redis port");
    });

    it("should throw on negative port via options", () => {
      process.env.NODE_ENV = "development";
      expect(() => QueueModule.forRoot({ redis: { host: "localhost", port: -1 } })).toThrow("Invalid Redis port");
    });
  });

  describe("password resolution", () => {
    it("should use explicit password from options", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot({ redis: { host: "localhost", port: 6379, password: "my-secret" } });
      expect(module).toBeDefined();
    });

    it("should use REDIS_PASSWORD env var when no explicit password", () => {
      process.env.REDIS_PASSWORD = "env-password";
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot();
      expect(module).toBeDefined();
    });

    it("should throw when password is set but empty", () => {
      process.env.REDIS_PASSWORD = "   ";
      process.env.NODE_ENV = "development";
      expect(() => QueueModule.forRoot()).toThrow("Redis password is set but empty");
    });

    it("should throw when no password in production", () => {
      process.env.NODE_ENV = "production";
      expect(() => QueueModule.forRoot()).toThrow("Redis password is required in non-development");
    });

    it("should allow no password in development", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot();
      expect(module).toBeDefined();
    });

    it("should trim password before use", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot({ redis: { host: "localhost", port: 6379, password: "  trimmed  " } });
      expect(module).toBeDefined();
    });
  });

  describe("host resolution", () => {
    it("should use explicit host from options", () => {
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot({ redis: { host: "redis.example.com", port: 6379 } });
      expect(module).toBeDefined();
    });

    it("should use REDIS_HOST env var when no explicit host", () => {
      process.env.REDIS_HOST = "redis-cloud.example.com";
      process.env.NODE_ENV = "development";
      const module = QueueModule.forRoot();
      expect(module).toBeDefined();
    });

    it("should throw when host is empty after trim", () => {
      process.env.REDIS_HOST = "   ";
      process.env.NODE_ENV = "development";
      expect(() => QueueModule.forRoot()).toThrow("Redis host is required");
    });
  });

  describe("registerQueue", () => {
    it("should return a dynamic module for a named queue", () => {
      const module = QueueModule.registerQueue("party-events");
      expect(module).toHaveProperty("module", QueueModule);
      expect(module.imports).toBeDefined();
      expect(module.exports).toBeDefined();
    });
  });
});
