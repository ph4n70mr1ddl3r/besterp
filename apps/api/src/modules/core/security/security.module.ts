import { Module } from "@nestjs/common";
import { SecurityService } from "./security.service.js";
import { PrismaModule } from "../../../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
