// Health Module - Provides health check functionality
//
// This module provides the health check endpoints and services
// for monitoring the application status.

import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}