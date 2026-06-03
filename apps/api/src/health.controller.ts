// Health check endpoint for load balancers and monitoring.
//
// Marked @Public() so it doesn't require JWT authentication.
// Delegates to HealthService for actual health checks.

import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./auth/public.decorator.js";
import { HealthService } from "./health.service.js";

@Public()
@Controller("health")
export class HealthController {
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let healthError: unknown;
    const healthPromise = this.healthService.getHealth().catch((err) => {
      healthError = err;
      throw err;
    });
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), 5000);
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
      clearTimeout(timeoutId);
    }
  }
}
