// Health check endpoint for load balancers and monitoring

import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  health() {
    return {
      status: "ok",
      service: "besterp-api",
      version: "0.0.1",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  ready() {
    // TODO: Check database connectivity, Redis, etc.
    return { status: "ready" };
  }
}
