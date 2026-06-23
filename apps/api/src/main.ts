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
import helmet from "helmet";
import { sanitizeLogOutput } from "@besterp/shared";
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

  // Fail if JWT_SECRET is missing in any non-development environment.
  // In development, a random ephemeral secret is generated instead.
  if (!process.env.JWT_SECRET && process.env.NODE_ENV !== "development") {
    console.error(
      "❌ FATAL: JWT_SECRET is not set. This is required in non-development environments. " +
      "Set JWT_SECRET before running the API."
    );
    process.exit(1);
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
    const raw = detail instanceof Error ? detail.stack ?? detail.message : String(detail);
    console.error(`❌ ${label}:`, sanitizeLogOutput(raw));
    if (shuttingDown) process.exit(1);
    shuttingDown = true;

    const hardExitTimer = setTimeout(() => {
      console.error(`❌ Graceful shutdown exceeded ${HARD_EXIT_TIMEOUT_MS}ms — forcing exit.`);
      process.exit(1);
    }, HARD_EXIT_TIMEOUT_MS);
    hardExitTimer.unref();

    try {
      await app.close();
      clearTimeout(hardExitTimer);
      process.exit(0);
    } catch (closeErr) {
      const raw = closeErr instanceof Error ? closeErr.stack ?? closeErr.message : String(closeErr);
      console.error("❌ Error during graceful shutdown:", sanitizeLogOutput(raw));
      clearTimeout(hardExitTimer);
      process.exit(1);
    }
  }

  process.on("uncaughtException", (error) => {
    // After an uncaughtException, the process is in an undefined state.
    // Attempting graceful shutdown (app.close()) may hang or corrupt in-flight
    // requests. Log the error and exit immediately — let the process manager
    // (systemd, Docker, PM2) restart a clean instance.
    console.error("❌ Uncaught exception:", error.stack ?? error.message);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    void gracefulShutdown("Unhandled promise rejection", reason).catch((shutdownErr) => {
      console.error("Error during shutdown handler:", shutdownErr);
      process.exit(1);
    });
  });

  app.enableShutdownHooks();
}

function configureCors(app: INestApplication): void {
  const corsOrigins = process.env.CORS_ORIGINS;
  if (corsOrigins) {
    const origins = corsOrigins.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
    if (origins.length > 0) {
      app.enableCors({ origin: origins, credentials: true });
      return;
    }
  }
  if (process.env.NODE_ENV === "development") {
    const devOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://localhost:5174",
    ];
    console.warn(
      "⚠️  CORS_ORIGINS not set — using restrictive localhost origins for development. " +
      "Set CORS_ORIGINS for non-standard dev ports."
    );
    app.enableCors({ origin: devOrigins, credentials: false });
  } else if (process.env.NODE_ENV !== "production") {
    console.warn(
      "⚠️  CORS is not configured for this environment. " +
      "Set CORS_ORIGINS (comma-separated list) to enable cross-origin requests."
    );
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

  app.use(helmet());

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
