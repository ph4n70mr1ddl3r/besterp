// Health Service - Provides health check and monitoring functionality
//
// This service provides health status information for monitoring and
// diagnostic purposes. It checks database connectivity, system resources,
// and application status.

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";
import * as fs from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
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
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  private packageInfo: { version: string; name: string } = { version: "0.0.0", name: "unknown" };
  private initialized = false;

  constructor(private readonly prisma: PrismaService) {
    // Kick off async initialization — package.json is read once and cached.
    // Using async readFile avoids blocking the event loop during startup.
    this.initPackageInfo().catch((err) => {
      this.logger.warn(
        `Could not read package.json: ${err instanceof Error ? err.message : err}`
      );
    });
  }

  private async initPackageInfo(): Promise<void> {
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      // In development: dist/ is at the same level as src/ so ../package.json works.
      // In production (compiled): __dirname IS dist/ and package.json is a sibling.
      // Try both paths to handle both layouts.
      const candidates = [
        join(__dirname, "../package.json"),  // dev: src/../package.json or dist/../package.json
        join(__dirname, "package.json"),       // flat dist layout
        join(__dirname, "../../package.json"), // monorepo: dist/ inside package
      ];
      let raw: string | undefined;
      for (const p of candidates) {
        try {
          raw = await fs.readFile(p, "utf-8");
          break;
        } catch {
          // try next
        }
      }
      if (!raw) {
        this.logger.warn("Could not find package.json in any expected location");
        return;
      }
      try {
        const pkg = JSON.parse(raw);
        this.packageInfo = {
          version: pkg.version || "0.0.0",
          name: pkg.name || "unknown",
        };
        this.initialized = true;
      } catch (parseErr) {
        this.logger.warn(
          `package.json found but could not be parsed: ${parseErr instanceof Error ? parseErr.message : parseErr}`
        );
      }
    } catch (err) {
      this.logger.warn(
        `Could not read package.json: ${err instanceof Error ? err.message : err}`
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
    
    // Check database connectivity — use the app client (RLS-enforced path)
    // rather than the admin client to verify the actual runtime connection.
    let databaseStatus: "connected" | "disconnected";
    try {
      await this.prisma.appClient.$queryRaw`SELECT 1`;
      databaseStatus = "connected";
    } catch (error) {
      this.logger.error(`Database health check failed: ${(error as Error).message}`);
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
   * Returns default values if package.json hasn't been read yet
   * (e.g., if called before async init completes).
   */
  getVersion(): VersionInfo {
    if (!this.initialized) {
      this.logger.debug(
        "getVersion() called before package.json was loaded — returning defaults."
      );
    }
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