// Health check endpoint for load balancers and monitoring.
//
// Marked @Public() so it doesn't require JWT authentication.
// Delegates to HealthService for actual health checks.

import { Controller, Get, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./auth/public.decorator.js";
import { HealthService } from "./health.service.js";

@Public()
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth() {
    return this.healthService.getHealth();
  }

  @Get("version")
  getVersion() {
    return this.healthService.getVersion();
  }

  @Get("ready")
  async ready() {
    // Verify database connectivity with a 5-second timeout to prevent
    // the endpoint from hanging when the database is unreachable.
    // NOTE: The timeout only aborts the HTTP response — the underlying DB
    // query continues running until it completes or the connection pool
    // is torn down. This is acceptable because:
    // 1. The query is a trivial `SELECT 1` that should resolve in milliseconds.
    // 2. If it doesn't, the DB is catastrophically slow and the connection
    //    will eventually time out per the driver's socket timeout.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const healthPromise = this.healthService.getHealth();
    // Suppress eventual rejection if timeout wins the race — without this,
    // a slow-failing DB health check becomes an unhandled promise rejection.
    healthPromise.catch(() => {});

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), 5000);
      // Prevent the timer from keeping the process alive during shutdown.
      if (timeoutId.unref) timeoutId.unref();
    });

    try {
      const result = await Promise.race([healthPromise, timeoutPromise]);
      if (result === "timeout") {
        throw new ServiceUnavailableException("health check timed out");
      }
      if (result.database !== "connected") {
        throw new ServiceUnavailableException("not ready");
      }
      // Health check succeeded before timeout — clear the timer to avoid
      // unnecessary event-loop work.
      if (timeoutId) clearTimeout(timeoutId);
      return { status: "ready" };
    } catch (error) {
      // Re-throw ServiceUnavailableException as-is
      if (error instanceof ServiceUnavailableException) throw error;
      // Wrap unexpected errors (e.g., health check threw)
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : "not ready"
      );
    }
  }
}
