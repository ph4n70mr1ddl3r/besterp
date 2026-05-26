// Health Service - Provides health check and monitoring functionality
//
// This service provides health status information for monitoring and
// diagnostic purposes. It checks database connectivity, system resources,
// and application status.

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";
import { readFileSync } from "fs";
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

  private readonly packageInfo: { version: string; name: string };

  constructor(private readonly prisma: PrismaService) {
    try {
      // Read package.json at construction time — avoids I/O on every request
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const pkgPath = join(__dirname, "../../package.json");
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      this.packageInfo = { version: pkg.version || "0.0.0", name: pkg.name || "unknown" };
    } catch (err) {
      this.logger.warn(
        `Could not read package.json: ${err instanceof Error ? err.message : err}`
      );
      this.packageInfo = { version: "0.0.0", name: "unknown" };
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
   * Get version information
   */
  getVersion(): VersionInfo {
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