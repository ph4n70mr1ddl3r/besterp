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

/**
 * Encode a Redis RESP (REdis Serialization Protocol) array of bulk strings.
 *
 * `*N\r\n$len\r\nvalue\r\n...` — the length-prefixed framing means values are
 * parsed by byte count, NOT split on whitespace, so a password containing
 * spaces (accepted by the real queue via ioredis) survives transport. The
 * probe previously used inline-command framing (`AUTH ${password}\r\n`), which
 * Redis splits on whitespace — a passphrase with a space produced WRONGPASS
 * and a permanent false "disconnected".
 */
function encodeRespArray(parts: string[]): string {
  const chunks = [`*${parts.length}\r\n`];
  for (const part of parts) {
    chunks.push(`$${Buffer.byteLength(part, "utf8")}\r\n${part}\r\n`);
  }
  return chunks.join("");
}

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
  /**
   * Per-process flag so the DB health-check failure logs exactly once per
   * process. Redis failures dedupe via {@link warnConnectionFailed}; the DB
   * catch block below logged at `error` on EVERY poll, so a permanently-down
   * database flooded operator logs at the same cadence the load balancer polls
   * `/api/health`. Note: like the Redis flag this never resets on recovery —
   * recovery is visible via the status flipping back to "connected", and
   * production alerts should watch the status, not the log line.
   */
  private static _dbConnectionLogged = false;

  /**
   * Short-TTL cache for the Redis probe. `/api/health` is @Public() and
   * deliberately bypasses the general rate limiter (load balancers poll it
   * frequently), and each probe opens a fresh TCP/TLS socket to Redis held for
   * up to 2s. Without a cache, an unauthenticated attacker hammering the
   * endpoint opens a new outbound socket per request and can exhaust the
   * process's file descriptors (EMFILE) or Redis `maxclients` — taking down
   * the whole API from a public endpoint. Caching the result for a few seconds
   * bounds socket churn to one per TTL regardless of request rate. Load
   * balancers poll at 5–10s intervals, so the staleness window is invisible in
   * practice. The result cache collapses SEQUENTIAL polls; the in-flight
   * Promise dedup (see {@link #redisProbeInflight}) collapses CONCURRENT
   * bursts so the "one per TTL" bound holds even under a request flood.
   */
  private static readonly REDIS_PROBE_CACHE_TTL_MS = 5_000;
  private redisProbeCache: { timestamp: number; status: "connected" | "disconnected" | "not_configured" } | undefined;
  /**
   * The currently-running Redis probe (if any). A result cache alone does
   * NOT bound socket churn under a concurrent burst: N requests that all
   * arrive before the first probe resolves each miss the empty cache and
   * each open their own socket — the exact socket-exhaustion DoS the cache
   * was added to prevent on the anonymous /health endpoint. Tracking the
   * in-flight Promise lets every concurrent caller await the SAME probe, so
   * only ONE socket is opened per probe window regardless of burst size.
   * Cleared in the `finally` of the originating probeRedis call.
   */
  private redisProbeInflight: Promise<"connected" | "disconnected" | "not_configured"> | undefined;

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
    // Try multiple candidate paths to handle different build layouts:
    // standard dist/../, flat dist/, and deeply nested monorepo output.
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
      // Dedupe like the Redis probes: load balancers poll /api/health every
      // few seconds, and without this an outage floods `error` logs on every
      // poll for the duration. The first failure carries the full sanitized
      // message for diagnosis; subsequent polls stay silent (status flips to
      // "disconnected" in the response body, which is what monitors consume).
      this.logDbHealthCheckFailed(error);
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
    // Serve a short-lived cached result (see REDIS_PROBE_CACHE_TTL_MS) so the
    // socket-per-request DoS surface on the anonymous /health endpoint stays
    // bounded. "not_configured" results open no socket, but caching them too
    // keeps the control flow uniform.
    const now = Date.now();
    if (this.redisProbeCache && now - this.redisProbeCache.timestamp < HealthService.REDIS_PROBE_CACHE_TTL_MS) {
      return this.redisProbeCache.status;
    }
    // Dedupe CONCURRENT probes: a result cache alone collapses polls that
    // arrive after the first resolves, but a burst of N requests arriving
    // before the first probe resolves all miss the empty cache and each open
    // their own socket. Awaiting the same in-flight Promise guarantees only
    // ONE socket per probe window regardless of burst size — the "regardless
    // of request rate" bound the cache's doc comment states. The probe never
    // rejects (it maps every failure to "disconnected"), so the `finally` is
    // guaranteed to run and clear the slot.
    if (this.redisProbeInflight) {
      return this.redisProbeInflight;
    }
    const probe = this.runRedisProbe();
    this.redisProbeInflight = probe;
    try {
      const status = await probe;
      this.redisProbeCache = { timestamp: Date.now(), status };
      return status;
    } finally {
      this.redisProbeInflight = undefined;
    }
  }

  /**
   * Execute one Redis probe and return its status WITHOUT touching the cache
   * or in-flight tracking — {@link probeRedis} owns those. Extracted so the
   * cache/dedup wrapper stays small and the probe body (env validation +
   * socket I/O) is independently readable. Never throws: every failure path
   * (no host, bad port, socket error) maps to a status string.
   */
  private async runRedisProbe(): Promise<"connected" | "disconnected" | "not_configured"> {
    if (!process.env.REDIS_HOST) {
      return "not_configured";
    }

    // Mirror QueueModule's fail-closed posture: silently defaulting to
    // DEFAULT_REDIS_PORT when REDIS_HOST is set but REDIS_PORT is absent could
    // connect to an unintended Redis instance (the same footgun QueueModule
    // refuses in production). Warn once and SKIP the probe, reported as
    // "disconnected" (not "not_configured") so the health payload still
    // signals the misconfiguration. Previously this path THREW in non-dev,
    // contradicting the "never throws" contract documented below (and on
    // probeRedis) — when it fired, getHealth() rejected and /api/health and
    // /api/health/ready returned a bare 500 instead of the documented status
    // body. QueueModule's own boot-time port validation is the real fail-
    // closed gate that stops a misconfigured deploy from starting, so
    // reporting an accurate "disconnected" here cannot mask startup failure
    // and keeps the anonymous health endpoints resilient.
    if (!process.env.REDIS_PORT && !isDev()) {
      this.warnOnce(
        `REDIS_PORT is required in non-development environments when REDIS_HOST is set. ` +
        `Skipping the Redis health check and reporting disconnected — set REDIS_PORT explicitly ` +
        `to avoid connecting to the wrong Redis instance.`
      );
      return "disconnected";
    }

    // Treat unset AND empty/whitespace-only REDIS_PORT as "not configured",
    // mirroring QueueModule.resolvePort (which falls back to the dev default
    // for falsy values). The previous `!== undefined` check made an empty
    // `.env` value (`REDIS_PORT=`) Number() to 0 and report the probe as
    // "disconnected" while the real queue connected fine — a monitoring blind
    // spot. The `?.trim()` also keeps a `" 6380 "`-padded value parseable.
    const rawPort = process.env.REDIS_PORT?.trim();
    const redisPort = rawPort ? Number(rawPort) : DEFAULT_REDIS_PORT;
    if (!Number.isInteger(redisPort) || redisPort < 1 || redisPort > 65535) {
      this.warnOnce(
        `REDIS_PORT "${process.env.REDIS_PORT}" is invalid — skipping the Redis health check. ` +
        "Set REDIS_PORT to a valid port between 1 and 65535."
      );
      return "disconnected";
    }

    try {
      // Trim the host so a whitespace-padded REDIS_HOST matches how the queue
      // resolves it — the previous untrimmed value would probe a different
      // host than the one BullMQ/ioredis actually connected to, causing a
      // false "disconnected" while the queue worked fine.
      const redisHost = String(process.env.REDIS_HOST).trim();
      return await this.probeRedisConnection(redisHost, redisPort);
    } catch {
      this.warnConnectionFailed();
      return "disconnected";
    }
  }

  /**
   * Open a single TCP/TLS socket to Redis and run an AUTH (when a password is
   * configured) followed by PING, resolving "connected" only once the PING
   * round-trip returns +PONG.
   */
  private async probeRedisConnection(redisHost: string, redisPort: number): Promise<"connected" | "disconnected"> {
    return new Promise<"connected" | "disconnected">((resolve, reject) => {
      const useTls = resolveRedisTls();
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
          // NUL bytes are the only value RESP bulk strings cannot transport
          // safely through Node's socket.write (they are legal in Redis auth
          // passwords but would be truncated by the C++ write layer). Spaces
          // and other whitespace ARE valid and are handled correctly by the
          // RESP framing below — the previous inline-command form
          // (`AUTH ${password}\r\n`) split on whitespace, so a passphrase
          // like "my redis pass" (which the real queue accepts via ioredis's
          // RESP bulk-string AUTH) was parsed as `AUTH user pass` and failed
          // with WRONGPASS — a permanent false "disconnected" on an otherwise
          // healthy queue.
          if (redisPassword.includes("\0")) {
            socket.destroy();
            reject(new Error("Redis password contains a NUL byte"));
            return;
          }
          socket.write(encodeRespArray(["AUTH", redisPassword]));
        }
        socket.write(encodeRespArray(["PING"]));
      });
      socket.on("data", (data) => {
        const chunk = data.toString();
        // Check BEFORE appending: a single TCP packet > MAX_RESPONSE_BUFFER
        // would otherwise briefly exceed the cap, defeating the DoS guard
        // that bounds memory used by the buffer on an unauthenticated probe.
        if (responseBuffer.length + chunk.length > MAX_RESPONSE_BUFFER) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error("Redis response exceeded maximum buffer size"));
          return;
        }
        responseBuffer += chunk;
        // Only a +PONG (the PING round-trip) proves the connection can execute
        // commands. The previous code also resolved on +OK — an AUTH success
        // frame — which settled the promise before PING had been validated, so
        // a degraded Redis that accepted AUTH but failed command execution
        // reported "connected" and hid the outage the probe exists to detect.
        // AUTH +OK is never a terminal success here because PING is always
        // sent after it.
        if (responseBuffer.includes("+PONG\r\n")) {
          clearTimeout(timeout);
          socket.destroy();
          resolve("connected");
          return;
        }
        // Errors can arrive before +PONG (e.g. -WRONGPASS from AUTH, or
        // -NOAUTH when no password was sent but Redis requires one). The
        // buffer may already contain a leading +OK from AUTH, so match any
        // line that starts with `-` rather than only the whole buffer.
        if (/(^|\r\n)-/.test(responseBuffer)) {
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
   * Log a DB health-check failure at `error` exactly once per process,
   * mirroring the static-flag dedup of {@link warnConnectionFailed}. The
   * first poll logs the sanitized message (diagnosis); later polls are
   * suppressed so a sustained outage cannot spam operator logs.
   */
  private logDbHealthCheckFailed(error: unknown): void {
    if (HealthService._dbConnectionLogged) return;
    HealthService._dbConnectionLogged = true;
    this.logger.error(
      `Database health check failed: ${sanitizeForLogOutput(error instanceof Error ? error.message : String(error))}`
    );
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
