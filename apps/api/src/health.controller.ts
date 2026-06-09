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
    // Run the health check and surface a 503 when the database is unreachable.
    // Load balancers and orchestrators (k8s readiness, AWS ELB, etc.) typically
    // only inspect the HTTP status code — if we return 200 with a body that
    // says "database: disconnected", the service is treated as healthy and
    // traffic keeps flowing to a broken instance. Returning 503 here makes
    // the failure mode visible to infrastructure.
    // NOTE: The /ready endpoint is still the recommended readiness probe (it
    // has a 5s timeout). This endpoint is a fail-closed alternative for
    // operators who only configure one health check.
    const status = await this.healthService.getHealth();
    if (status.database !== "connected") {
      // Return generic error without database details to avoid information
      // disclosure that could help an attacker understand infrastructure state.
      throw new ServiceUnavailableException({
        status: "error",
        message: "Service is not ready",
      });
    }
    return status;
  }

  @Get("version")
  getVersion() {
    return this.healthService.getVersion();
  }

  @Get("ready")
  async ready() {
    // Verify database connectivity with a 5-second timeout to prevent
    // the endpoint from hanging when the database is unreachable.
    // The timeout only aborts the HTTP response — the underlying DB
    // query continues running until it completes or the connection pool
    // is torn down. This is acceptable because:
    // 1. The query is a trivial `SELECT 1` that should resolve in milliseconds.
    // 2. If it doesn't, the DB is catastrophically slow and the connection
    //    will eventually time out per the driver's socket timeout.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const healthPromise = this.healthService.getHealth();
    // Suppress eventual rejection if timeout wins the race — without this,
    // a slow-failing DB health check becomes an unhandled promise rejection.
    healthPromise.catch((err) => this.logger.warn(`Health check failed (suppressed): ${err instanceof Error ? err.message : err}`));

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
      return { status: "ready" };
    } catch (error) {
      // Re-throw ServiceUnavailableException as-is
      if (error instanceof ServiceUnavailableException) throw error;
      // Wrap unexpected errors (e.g., health check threw)
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : "not ready"
      );
    } finally {
      // Always clear the timer, regardless of which path we took. Without this,
      // the timer fires uselessly 5s after a throw. .unref() on line 65 keeps
      // it from holding the process open, but the callback still allocates.
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
