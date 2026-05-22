// Health check endpoint for load balancers and monitoring.
//
// Marked @Public() so it doesn't require JWT authentication.

import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/public.decorator";
import { PrismaService } from "./prisma/prisma.service";

@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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
  async ready() {
    // Verify database connectivity
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ready" };
  }
}
