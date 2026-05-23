// Health check endpoint for load balancers and monitoring.
//
// Marked @Public() so it doesn't require JWT authentication.
// Delegates to HealthService for actual health checks.

import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
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
  @HttpCode(HttpStatus.OK)
  async ready() {
    // Verify database connectivity (delegates to service)
    const status = await this.healthService.getHealth();
    if (status.database !== "connected") {
      throw new ServiceUnavailableException("not ready");
    }
    return { status: "ready" };
  }
}
