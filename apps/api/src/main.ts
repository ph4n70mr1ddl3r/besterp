// BestERP API — NestJS Bootstrap
//
// Initializes the NestJS application with:
// - Global API prefix
// - CORS for development
// - Request validation pipe
// - JWT secret check (warns in dev, fails in production)

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe, type INestApplication } from "@nestjs/common";
import { AppModule } from "./app.module.js";

function validateEnvironment(): void {
  const requiredInProduction = ["DATABASE_URL", "DATABASE_ADMIN_URL", "JWT_SECRET"];
  const missing = requiredInProduction.filter((v) => !process.env[v]);
  if (missing.length > 0 && process.env.NODE_ENV === "production") {
    console.error(`❌ FATAL: Missing required environment variables: ${missing.join(", ")}. Exiting.`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
    console.warn("⚠️  DATABASE_URL not set — database operations will fail. Set DATABASE_URL before running the API.");
  }

  const REDIS_WARN_VARS = ["REDIS_HOST", "REDIS_PORT"];
  const missingRedis = REDIS_WARN_VARS.filter((v) => !process.env[v]);
  if (missingRedis.length > 0 && process.env.NODE_ENV === "production") {
    console.warn(`⚠️  Missing Redis env vars: ${missingRedis.join(", ")}. Queues and background jobs will fail.`);
  }
}

function setupGracefulShutdown(app: INestApplication): void {
  const HARD_EXIT_TIMEOUT_MS = Number(process.env.HARD_EXIT_TIMEOUT_MS) || 10_000;
  let shuttingDown = false;

  async function gracefulShutdown(label: string, detail: unknown): Promise<void> {
    console.error(`❌ ${label}:`, detail instanceof Error ? detail.stack : detail);
    if (shuttingDown) process.exit(1);
    shuttingDown = true;

    const hardExitTimer = setTimeout(() => {
      console.error(`❌ Graceful shutdown exceeded ${HARD_EXIT_TIMEOUT_MS}ms — forcing exit.`);
      process.exit(1);
    }, HARD_EXIT_TIMEOUT_MS);
    if (hardExitTimer.unref) hardExitTimer.unref();

    try {
      await app.close();
    } catch (closeErr) {
      console.error("❌ Error during graceful shutdown:", closeErr instanceof Error ? closeErr.stack : closeErr);
    }
    clearTimeout(hardExitTimer);
    process.exit(1);
  }

  process.on("uncaughtException", (error) => {
    void gracefulShutdown("Uncaught exception", error);
  });

  process.on("unhandledRejection", (reason) => {
    void gracefulShutdown("Unhandled promise rejection", reason);
  });

  app.enableShutdownHooks();
}

function configureCors(app: INestApplication): void {
  const corsOrigins = process.env.CORS_ORIGINS;
  if (corsOrigins) {
    const origins = corsOrigins.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
    if (origins.length > 0) {
      app.enableCors({ origin: origins, credentials: true });
    } else if (process.env.NODE_ENV === "development") {
      app.enableCors({ origin: true, credentials: false });
    }
  } else if (process.env.NODE_ENV === "development") {
    app.enableCors({ origin: true, credentials: false });
  }
}

function parsePort(): number {
  const rawPort = process.env.PORT || "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`❌ FATAL: Invalid PORT "${rawPort}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

async function bootstrap() {
  validateEnvironment();

  const app = await NestFactory.create(AppModule);

  setupGracefulShutdown(app);

  app.setGlobalPrefix("api");

  configureCors(app);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );

  const port = parsePort();
  try {
    await app.listen(port);
    const logger = new Logger("Bootstrap");
    logger.log(`BestERP API running on http://localhost:${port}`);
  } catch (err) {
    console.error(`❌ FATAL: Failed to listen on port ${port}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

void bootstrap();
