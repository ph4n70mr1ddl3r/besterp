// Health check endpoint for load balancers and monitoring

import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";

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
