import { Module } from "@nestjs/common";
import { PartyService } from "./party.service.js";
import { PartyController } from "./party.controller.js";
import { PrismaModule } from "../../../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  controllers: [PartyController],
  providers: [PartyService],
  exports: [PartyService],
})
export class PartyModule {}
