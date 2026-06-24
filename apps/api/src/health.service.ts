// Health Service - Provides health check and monitoring functionality
//
// This service provides health status information for monitoring and
// diagnostic purposes. It checks database connectivity, system resources,
// and application status.

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";
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
  nodeVersion: string;
  environment: string;
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

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.packageInfoReady = this.initPackageInfo().catch((err) => {
      this.logger.warn(
        `Could not read package.json: ${err instanceof Error ? err.message : err}`
      );
    });
  }

  private async initPackageInfo(): Promise<void> {
    const serviceDir = dirname(fileURLToPath(import.meta.url));
    // In development: dist/ is at the same level as src/ so ../package.json works.
    // In production (compiled): serviceDir IS dist/ and package.json is a sibling.
    // Try both paths to handle both layouts.
    const candidates = [
      join(serviceDir, "../package.json"),  // dev: src/../package.json or dist/../package.json
      join(serviceDir, "package.json"),       // flat dist layout
      join(serviceDir, "../../package.json"), // monorepo: dist/ inside package
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
    
    // Check database connectivity — use the admin client (bypasses RLS) for
    // health checks. The app client requires a tenant context via set_tenant_context(),
    // which is not set during health checks. The admin client verifies the database
    // connection is alive without depending on RLS configuration.
    let databaseStatus: "connected" | "disconnected";
    try {
      await this.prisma.admin.$queryRaw`SELECT 1`;
      databaseStatus = "connected";
    } catch (error) {
      this.logger.error(
        `Database health check failed: ${error instanceof Error ? error.message : String(error)}`
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
    return {
      version: this.packageInfo.version,
      name: this.packageInfo.name,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development",
      build: {
        number: process.env.BUILD_NUMBER,
        date: process.env.BUILD_DATE,
      },
    };
  }
}