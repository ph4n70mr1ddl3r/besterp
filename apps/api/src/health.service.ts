// Health Service - Provides health check and monitoring functionality
//
// This service provides health status information for monitoring and
// diagnostic purposes. It checks database connectivity, system resources,
// and application status.

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";
import { sanitizeForLogOutput, sanitizeLogMessage } from "@besterp/shared";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
  /** Process uptime in milliseconds since start. */
  uptime: number;
  environment: string;
  database: "connected" | "disconnected";
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    heapPercentage: number;
  };
}

export interface VersionInfo {
  version: string;
  name: string;
  environment: string;
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

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.packageInfoReady = this.initPackageInfo().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.packageInfoError = msg;
      this.logger.warn(`Could not read package.json: ${msg}`);
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
        this.logger.debug(`package.json not found at: ${p}`);
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
        `package.json found but could not be parsed: ${parseErr instanceof Error ? parseErr.message : parseErr}`
      );
    }
  }

  /**
   * Get overall health status of the application
   */
  async getHealth(): Promise<HealthStatus> {
    const timestamp = new Date().toISOString();
    const uptime = Math.round(process.uptime() * 1000); // ms since process started
    const environment = process.env.NODE_ENV || "development";
    
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

    // Get memory usage — track heap metrics consistently
    const memoryUsage = process.memoryUsage();
    const heapUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);      // MB
    const heapTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);    // MB
    const rss = Math.round(memoryUsage.rss / 1024 / 1024);                // MB (total OS memory)
    const heapPercentage = heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100) : 0;

    const overallStatus: "ok" | "error" = databaseStatus === "connected" ? "ok" : "error";

    return {
      status: overallStatus,
      timestamp,
      uptime,
      environment,
      database: databaseStatus,
      memory: {
        heapUsed,
        heapTotal,
        rss,
        heapPercentage,
      },
    };
  }

  /**
   * Get version information.
   * Awaits async package.json init on first call so callers never see
   * stale defaults due to a race with constructor-side initialization.
   */
  async getVersion(): Promise<VersionInfo> {
    await this.packageInfoReady;
    const isProd = process.env.NODE_ENV === "production";
    // The /version endpoint is anonymous (@Public()), so it is reachable by
    // anyone — including unauthenticated attackers. Returning the exact
    // package name + semantic version in production fingerprints the build,
    // letting an attacker target known CVEs for that exact release. Mirror the
    // fail-closed hardening already applied to the anonymous /health body: in
    // production return only a generic, non-fingerprintable marker. Operators
    // still get the full triplet in non-production (dev/staging/preview), where
    // the build is not a deployed attack surface.
    if (isProd) {
      return {
        version: "redacted",
        name: "redacted",
        environment: process.env.NODE_ENV || "development",
        warning: undefined,
        build: undefined,
      };
    }
    return {
      version: this.packageInfo.version,
      name: this.packageInfo.name,
      environment: process.env.NODE_ENV || "development",
      // Suppress filesystem-path errors in production to avoid information
      // disclosure about the container/server layout.
      warning: this.packageInfoError ?? undefined,
      build: {
        number: process.env.BUILD_NUMBER ? sanitizeLogMessage(process.env.BUILD_NUMBER).slice(0, 50) : undefined,
        date: process.env.BUILD_DATE ? sanitizeLogMessage(process.env.BUILD_DATE).slice(0, 30) : undefined,
      },
    };
  }
}