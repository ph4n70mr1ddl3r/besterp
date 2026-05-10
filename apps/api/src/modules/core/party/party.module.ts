// Party Module — NestJS module for the Party domain.
//
// Provides PartyService and PartyController to the application.
// Imports PrismaModule (global) for database access.

import { Module } from "@nestjs/common";
import { PartyService } from "./party.service";
import { PartyController } from "./party.controller";

@Module({
  controllers: [PartyController],
  providers: [PartyService],
  exports: [PartyService],
})
export class PartyModule {}
