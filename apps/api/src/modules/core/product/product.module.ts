import { Module } from "@nestjs/common";
import { ProductService } from "./product.service.js";
import { PrismaModule } from "../../../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
