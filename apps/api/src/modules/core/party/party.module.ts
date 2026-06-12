// Party Module — NestJS module for the Party domain.
//
// Provides PartyService and PartyController to the application.
// Imports PrismaModule (global) for database access.

import { Module } from "@nestjs/common";
import { PrismaModule } from "../../../prisma/prisma.module.js";
import { PartyService } from "./party.service.js";
import { PartyController } from "./party.controller.js";

@Module({
  imports: [PrismaModule],
  controllers: [PartyController],
  providers: [PartyService],
  exports: [PartyService],
})
export class PartyModule {}
