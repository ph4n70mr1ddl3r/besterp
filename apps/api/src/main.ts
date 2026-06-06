// BestERP API — NestJS Bootstrap
//
// Initializes the NestJS application with:
// - Global API prefix
// - CORS for development
// - Request validation pipe
// - JWT secret check (warns in dev, fails in production)

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  // Guard against unhandled promise rejections crashing the process silently.
  process.on("unhandledRejection", (reason) => {
    console.error(
      "❌ Unhandled promise rejection:",
      reason instanceof Error ? reason.stack : reason
    );
    // Exit with non-zero code so orchestrators (Docker, systemd, K8s) restart the pod.
    // Unhandled rejections indicate a programming error — the process is in an
    // unknown state and should not continue serving requests.
    process.exit(1);
  });
  // Validate required environment variables
  const requiredInProduction = ["DATABASE_URL", "JWT_SECRET"];
  const missing = requiredInProduction.filter((v) => !process.env[v]);
  if (missing.length > 0 && process.env.NODE_ENV === "production") {
    console.error(
      `❌ FATAL: Missing required environment variables: ${missing.join(", ")}. Exiting.`
    );
    process.exit(1);
  }
  if (missing.includes("JWT_SECRET")) {
    console.warn(
      "⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in production!"
    );
  }
  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
    console.warn(
      "⚠️  DATABASE_URL not set — database operations will fail. Set DATABASE_URL before running the API."
    );
  }

  const app = await NestFactory.create(AppModule);

  // Enable graceful shutdown so PrismaService.onModuleDestroy fires
  app.enableShutdownHooks();

  // Global prefix for REST endpoints
  app.setGlobalPrefix("api");

  // CORS — configurable via CORS_ORIGINS env var (comma-separated)
  const corsOrigins = process.env.CORS_ORIGINS;
  app.enableCors(
    corsOrigins
      ? { origin: corsOrigins.split(",").map((o) => o.trim()), credentials: true }
      : { origin: true, credentials: true }
  );

  // Global validation pipe — strips unknown properties, validates DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );

  const rawPort = process.env.PORT || "3000";
  const port = Number(rawPort);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`❌ FATAL: Invalid PORT "${rawPort}". Must be a number between 1 and 65535.`);
    process.exit(1);
  }
  try {
    await app.listen(port);
    console.log(`🚀 BestERP API running on http://localhost:${port}`);
  } catch (err) {
    console.error(
      `❌ FATAL: Failed to listen on port ${port}: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }
}

bootstrap();
