// Prisma Service — NestJS-compatible PrismaClient wrapper.
//
// Handles connection lifecycle (connect on module init, disconnect on destroy).
// Phase 0b will add Prisma Client Extension for automatic tenant context.

import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
