// BestERP API — NestJS Bootstrap
//
// Phase 0b: Scaffold with health check and MCP module stub.
// The MCP tool server will be integrated here as a NestJS module,
// replacing the standalone stdio server from the spike.

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global prefix for REST endpoints
  app.setGlobalPrefix("api");

  // CORS for development
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 BestERP API running on http://localhost:${port}`);
}

bootstrap();
