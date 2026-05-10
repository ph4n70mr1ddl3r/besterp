// BestERP API — NestJS Bootstrap
//
// Initializes the NestJS application with:
// - Global API prefix
// - CORS for development
// - Request validation pipe
// - JWT secret check (warns in dev, fails in production)

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  // Warn if JWT_SECRET is not set
  if (!process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
      console.error("❌ FATAL: JWT_SECRET must be set in production. Exiting.");
      process.exit(1);
    }
    console.warn(
      "⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in production!"
    );
  }

  // Validate required environment variables
  const requiredInProduction = ["DATABASE_URL", "JWT_SECRET"];
  const missing = requiredInProduction.filter((v) => !process.env[v]);
  if (missing.length > 0 && process.env.NODE_ENV === "production") {
    console.error(
      `❌ FATAL: Missing required environment variables: ${missing.join(", ")}. Exiting.`
    );
    process.exit(1);
  }
  if (missing.length > 0) {
    console.warn(
      `⚠️  Missing optional environment variables: ${missing.join(", ")}. Defaults will be used.`
    );
  }

  const app = await NestFactory.create(AppModule);

  // Global prefix for REST endpoints
  app.setGlobalPrefix("api");

  // CORS for development
  app.enableCors();

  // Global validation pipe — strips unknown properties, validates DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 BestERP API running on http://localhost:${port}`);
}

bootstrap();
