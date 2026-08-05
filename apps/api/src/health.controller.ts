// Health check endpoint for load balancers and monitoring.
//
// Marked @Public() so it doesn't require JWT authentication.
// Delegates to HealthService for actual health checks.

import { Controller, Get, Logger, ServiceUnavailableException } from "@nestjs/common";
import { sanitizeForLogOutput, isProd } from "@besterp/shared";
import { Public } from "./auth/public.decorator.js";
import { HealthService } from "./health.service.js";

@Public()
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth() {
    // Return 503 when the database is unreachable so load balancers and
    // orchestrators (k8s readiness, AWS ELB, etc.) can route traffic away.
    // Returning 200 with "database: disconnected" would be treated as healthy.
    // The /ready endpoint (with its 5s timeout) remains the preferred probe.
    const status = await this.healthService.getHealth();
    if (status.database !== "connected") {
      // Return generic error without database details to avoid information
      // disclosure about infrastructure state to unauthenticated callers.
      throw new ServiceUnavailableException({
        status: "error",
        message: "Service is not ready",
      });
    }
    // Anonymous health endpoint returns only a minimal, non-fingerprintable
    // body. The full HealthStatus is still available to authenticated monitoring.
    return { status: status.status, timestamp: status.timestamp, database: status.database };
  }

  @Get("version")
  async getVersion() {
    return this.healthService.getVersion();
  }

  @Get("ready")
  async ready() {
    // 5-second timeout prevents hanging when the database is unreachable.
    // The underlying DB query continues until it completes or the connection
    // pool is torn down; the timeout only aborts the HTTP response.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    timeoutId.unref();

    try {
      const healthPromise = this.healthService.getHealth();
      const result = await Promise.race([
        healthPromise,
        new Promise<"timeout">((resolve) => controller.signal.addEventListener("abort", () => resolve("timeout"), { once: true })),
      ]);
      if (result === "timeout") {
        void healthPromise.catch((err) => {
          this.logger.debug(`Health check query failed after timeout: ${sanitizeForLogOutput(err instanceof Error ? err.message : String(err))}`);
        });
        throw new ServiceUnavailableException("health check timed out");
      }
      if (result.database !== "connected") {
        throw new ServiceUnavailableException("not ready");
      }
      return { status: "ready" };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        isProd() ? "not ready" : sanitizeForLogOutput(error instanceof Error ? error.message : "not ready")
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
