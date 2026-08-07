// Health Service - Provides health check and monitoring functionality
//
// This service provides health status information for monitoring and
// diagnostic purposes. It checks database connectivity, system resources,
// and application status.

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";
import { sanitizeForLogOutput, sanitizeLogMessage, resolveRedisTls, isDev, isProd, DEFAULT_REDIS_PORT } from "@besterp/shared";
import { normalizeEnvironmentValue } from "./bootstrap-config.js";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as tls from "node:tls";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
  /** Process uptime in milliseconds since start. */
  uptime: number;
  environment: string;
  database: "connected" | "disconnected";
  redis: "connected" | "disconnected" | "not_configured";
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    heapPercentage: number;
  };
  warning?: string;
}

export interface VersionInfo {
  version: string;
  name: string;
  environment?: string;
  warning?: string;
  build?: {
    number?: string;
    date?: string;
  };
}

@Injectable()
export class HealthService implements OnModuleInit {
  private readonly logger = new Logger(HealthService.name);

  private packageInfo: { version: string; name: string } = { version: "0.0.0", name: "unknown" };
  private packageInfoReady: Promise<void> = Promise.resolve();
  private packageInfoError: string | undefined;
  /**
   * Per-process flag so the REDIS_PORT warning fires exactly once instead of
   * flooding operator logs on every load-balancer health-check poll.
   * Mirrors the same deduplication pattern used by QueueModule (static flag).
   */
  private static _redisPortWarned = false;
  /**
   * Per-process flag so the generic connection-failure warning fires exactly
   * once per process. Without this, a permanently-down Redis floods logs on
   * every health-check poll (e.g. every 5s from a load balancer).
   */
  private static _redisConnectionWarned = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.packageInfoReady = this.initPackageInfo().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.packageInfoError = msg;
      this.logger.warn(`Could not read package.json: ${sanitizeForLogOutput(msg)}`);
    });
  }

  private async initPackageInfo(): Promise<void> {
    const serviceDir = dirname(fileURLToPath(import.meta.url));
    // After compilation, serviceDir IS the dist/ directory. package.json
    // lives in the package root (one level up from dist/). Try multiple
    // candidate paths to handle different build layouts and monorepo
    // structures (e.g., hoisted node_modules).
    const candidates = [
      join(serviceDir, "../package.json"),   // standard: dist/../package.json
      join(serviceDir, "package.json"),       // flat dist layout
      join(serviceDir, "../../package.json"), // deeply nested build output
    ];
    let raw: string | undefined;
    for (const p of candidates) {
      try {
        raw = await fs.readFile(p, "utf-8");
        break;
      } catch {
        this.logger.debug(`package.json not found at: ${sanitizeLogMessage(p)}`);
      }
    }
    if (!raw) {
      this.logger.warn("Could not find package.json in any expected location");
      return;
    }
    try {
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      this.packageInfo = {
        version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
        name: typeof pkg.name === "string" ? pkg.name : "unknown",
      };
    } catch (parseErr) {
      this.logger.warn(
        `package.json found but could not be parsed: ${sanitizeForLogOutput(parseErr instanceof Error ? parseErr.message : String(parseErr))}`
      );
    }
  }

  /**
   * Get overall health status of the application
   */
  async getHealth(): Promise<HealthStatus> {
    const timestamp = new Date().toISOString();
    const uptime = Math.round(process.uptime() * 1000); // ms since process started
    const environment = normalizeEnvironmentValue(process.env.NODE_ENV) || "development";

    // Check database connectivity — use the app client (RLS-enforced path).
    // `SELECT 1` does not access any tenant-scoped table, so RLS policies
    // do not interfere. Using the app client avoids exercising the admin
    // (superuser) connection for a non-admin purpose.
    let databaseStatus: "connected" | "disconnected";
    try {
      await this.prisma.appClient.$queryRaw`SELECT 1`;
      databaseStatus = "connected";
    } catch (error) {
      this.logger.error(
        `Database health check failed: ${sanitizeForLogOutput(error instanceof Error ? error.message : String(error))}`
      );
      databaseStatus = "disconnected";
    }

    // Check Redis connectivity if configured
    const redisStatus = await this.probeRedis();

    // Get memory usage — track heap metrics consistently
    const memoryUsage = process.memoryUsage();
    const heapUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);      // MB
    const heapTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);    // MB
    const rss = Math.round(memoryUsage.rss / 1024 / 1024);                // MB (total OS memory)
    const heapPercentage = heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100) : 0;

    // Redis is optional (background jobs); when configured but disconnected,
    // the system is still healthy for core operations. Only mark error if
    // Redis IS configured AND actually disconnected (not "not_configured").
    const overallStatus: "ok" | "error" = databaseStatus === "connected" ? "ok" : "error";
    const redisWarning = redisStatus === "disconnected" ? "Redis is configured but disconnected — background jobs may not work" : undefined;

    return {
      status: overallStatus,
      timestamp,
      uptime,
      environment,
      database: databaseStatus,
      redis: redisStatus,
      memory: {
        heapUsed,
        heapTotal,
        rss,
        heapPercentage,
      },
      ...(redisWarning ? { warning: redisWarning } : {}),
    };
  }

  /**
   * Probe Redis connectivity and return a status.
   *
   * Returns "not_configured" when REDIS_HOST is unset. Warns (once per
   * process) and skips the probe on a missing or invalid REDIS_PORT — mirroring
   * QueueModule's fail-closed port validation so a config typo surfaces as a
   * clear log warning rather than a misleading "disconnected" state
   * (Number("abc") → NaN → connect() throws ERR_SOCKET_BAD_PORT). An invalid
   * port is reported as "disconnected" (not "not_configured") so the health
   * payload's redis warning still surfaces to operators.
   */
  private async probeRedis(): Promise<"connected" | "disconnected" | "not_configured"> {
    if (!process.env.REDIS_HOST) {
      return "not_configured";
    }

    // Mirror QueueModule's production guard: if REDIS_HOST is set but
    // REDIS_PORT is absent, defaulting to DEFAULT_REDIS_PORT silently could connect to an
    // unintended Redis instance (the same footgun QueueModule refuses in
    // production). Log a warning in non-production so operators notice the
    // misconfiguration rather than probing the wrong service. In production
    // QueueModule throws before this code is reachable, so the warning only
    // fires in staging/dev where both surfaces default to DEFAULT_REDIS_PORT.
    if (!process.env.REDIS_PORT && !isDev()) {
      this.warnOnce(
        "REDIS_HOST is set but REDIS_PORT is missing — " +
        `defaulting to ${DEFAULT_REDIS_PORT}. Set REDIS_PORT explicitly to avoid connecting ` +
        "to an unintended Redis instance."
      );
    }

    const redisPort = process.env.REDIS_PORT !== undefined ? Number(process.env.REDIS_PORT) : DEFAULT_REDIS_PORT;
    if (!Number.isInteger(redisPort) || redisPort < 1 || redisPort > 65535) {
      this.warnOnce(
        `REDIS_PORT "${process.env.REDIS_PORT}" is invalid — skipping the Redis health check. ` +
        "Set REDIS_PORT to a valid port between 1 and 65535."
      );
      return "disconnected";
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const useTls = resolveRedisTls();
        const redisHost = String(process.env.REDIS_HOST);
        const socket = useTls
          ? tls.connect({ host: redisHost, port: redisPort, rejectUnauthorized: true })
          : new net.Socket();
        let responseBuffer = "";
        const MAX_RESPONSE_BUFFER = 1024;
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Redis connection timed out"));
        }, 2000);
        socket.on("connect", () => {
          const redisPassword = process.env.REDIS_PASSWORD;
          if (redisPassword) {
            if (/[\r\n]/.test(redisPassword)) {
              socket.destroy();
              reject(new Error("Redis password contains invalid characters (newlines)"));
              return;
            }
            socket.write(`AUTH ${redisPassword}\r\n`);
          }
          socket.write("*1\r\n$4\r\nPING\r\n");
        });
        socket.on("data", (data) => {
          responseBuffer += data.toString();
          if (responseBuffer.length > MAX_RESPONSE_BUFFER) {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error("Redis response exceeded maximum buffer size"));
            return;
          }
          if (responseBuffer.includes("+PONG\r\n") || responseBuffer.includes("+OK\r\n")) {
            clearTimeout(timeout);
            socket.destroy();
            resolve();
          }
          if (responseBuffer.startsWith("-")) {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error(`Redis error: ${sanitizeForLogOutput(responseBuffer.trim())}`));
          }
        });
        socket.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        if (!useTls) {
          socket.connect(redisPort, redisHost);
        }
      });
      return "connected";
    } catch {
      this.warnConnectionFailed();
      return "disconnected";
    }
  }

  /**
   * Emit a Redis-configuration warning exactly once per process, mirroring the
   * deduplication used by QueueModule so load-balancer health-check polls do
   * not flood operator logs.
   */
  private warnOnce(message: string): void {
    if (HealthService._redisPortWarned) return;
    HealthService._redisPortWarned = true;
    this.logger.warn(message);
  }

  /**
   * Emit a generic Redis-connection-failure warning exactly once per process,
   * mirroring the same deduplication pattern. The connection-failure path
   * (catch block in probeRedis) was previously unconditional and would
   * flood logs on every health-check poll when Redis is permanently down.
   */
  private warnConnectionFailed(): void {
    if (HealthService._redisConnectionWarned) return;
    HealthService._redisConnectionWarned = true;
    this.logger.warn("Redis health check failed — background jobs may not work");
  }

  /**
   * Get version information.
   * Awaits async package.json init on first call so callers never see
   * stale defaults due to a race with constructor-side initialization.
   */
  async getVersion(): Promise<VersionInfo> {
    await this.packageInfoReady;
    // The /version endpoint is anonymous (@Public()), so it is reachable by
    // anyone — including unauthenticated attackers. Returning the exact
    // package name + semantic version in production fingerprints the build,
    // letting an attacker target known CVEs for that exact release. Mirror the
    // fail-closed hardening already applied to the anonymous /health body: in
    // production return only a generic, non-fingerprintable marker. Operators
    // still get the full triplet in non-production (dev/staging/preview), where
    // the build is not a deployed attack surface.
    if (isProd()) {
      return {
        version: "redacted",
        name: "redacted",
        environment: undefined,
        warning: undefined,
        build: undefined,
      };
    }
    return {
      version: this.packageInfo.version,
      name: this.packageInfo.name,
      environment: normalizeEnvironmentValue(process.env.NODE_ENV) || "development",
      // Suppress filesystem-path errors in production to avoid information
      // disclosure about the container/server layout. Even in non-production,
      // scrub file paths / connection strings from the message so an
      // anonymous /version caller cannot learn infrastructure details.
      warning: this.packageInfoError ? sanitizeForLogOutput(this.packageInfoError) : undefined,
      build: {
        number: process.env.BUILD_NUMBER ? sanitizeForLogOutput(process.env.BUILD_NUMBER).slice(0, 50) : undefined,
        date: process.env.BUILD_DATE ? sanitizeForLogOutput(process.env.BUILD_DATE).slice(0, 30) : undefined,
      },
    };
  }
}
