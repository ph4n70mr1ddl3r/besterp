// BestERP API — NestJS Bootstrap
//
// Initializes the NestJS application with:
// - Global API prefix
// - CORS for development
// - Request validation pipe
// - JWT secret check (warns in dev, fails in production)

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  // Validate required environment variables BEFORE creating the Nest app
  // (before any work that might be torn down on shutdown).
  // DATABASE_ADMIN_URL is required so the admin PrismaClient (used for audit
  // logs and idempotency records) connects as a superuser. Without it the
  // admin client falls back to DATABASE_URL (the RLS-enforced role) and
  // cross-tenant writes are silently rejected.
  const requiredInProduction = ["DATABASE_URL", "DATABASE_ADMIN_URL", "JWT_SECRET"];
  const missing = requiredInProduction.filter((v) => !process.env[v]);
  if (missing.length > 0 && process.env.NODE_ENV === "production") {
    console.error(
      `❌ FATAL: Missing required environment variables: ${missing.join(", ")}. Exiting.`
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
    console.warn(
      "⚠️  DATABASE_URL not set — database operations will fail. Set DATABASE_URL before running the API."
    );
  }
  // Redis is strongly recommended for queue/worker functionality. In production
  // the process can start without it (BullMQ will retry connections), but warn
  // loudly so operators don't silently lose async job processing.
  const REDIS_WARN_VARS = ["REDIS_HOST", "REDIS_PORT"];
  const missingRedis = REDIS_WARN_VARS.filter((v) => !process.env[v]);
  if (missingRedis.length > 0 && process.env.NODE_ENV === "production") {
    console.warn(
      `⚠️  Missing Redis env vars: ${missingRedis.join(", ")}. Queues and background jobs will fail.`
    );
  }

  const app = await NestFactory.create(AppModule);

  // Guard against unhandled promise rejections crashing the process without
  // running onModuleDestroy. We must close the app first so PrismaService,
  // BullMQ workers, and the tenant client cache tear down cleanly. If close
  // itself fails or hangs (e.g., stalled DB connection), fall back to a hard
  // exit so the process doesn't get stuck — orchestrators that have given up
  // waiting will SIGKILL the pod, which can leave pooled resources in a bad
  // state and pollute logs with OOM-killer noise.
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
    // Synchronous-only handler: Node.js docs warn that async work in
    // 'uncaughtException' is unsafe because the process state may be
    // corrupted. Log the error and exit immediately. Do NOT attempt
    // graceful shutdown (app.close, DB disconnects) here — they are
    // async and may hang or panic on corrupted state.
    console.error("❌ Uncaught exception:", error instanceof Error ? error.stack : error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    // Unlike uncaughtException, the process state is still sound after
    // an unhandled rejection, so graceful shutdown is safe here.
    void gracefulShutdown("Unhandled promise rejection", reason);
  });

  // Enable graceful shutdown so PrismaService.onModuleDestroy fires
  app.enableShutdownHooks();

  // Global prefix for REST endpoints
  app.setGlobalPrefix("api");

  // CORS — configurable via CORS_ORIGINS env var (comma-separated).
  // Default: no CORS (origin: false). This is fail-closed: the API only
  // accepts cross-origin requests from an explicit allowlist. The previous
  // default (origin: true + credentials: true) reflected any request origin
  // and is equivalent to disabling the same-origin policy for browsers.
  const corsOrigins = process.env.CORS_ORIGINS;
  if (corsOrigins) {
    const origins = corsOrigins.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
    if (origins.length > 0) {
      app.enableCors({
        origin: origins,
        credentials: true,
      });
    } else {
      // CORS_ORIGINS was set to an empty/comma-only value — treat as "no cors"
      // rather than enabling CORS with an empty allowlist (which would deny all).
      if (process.env.NODE_ENV !== "production") {
        app.enableCors({ origin: true, credentials: false });
      }
    }
  } else if (process.env.NODE_ENV !== "production") {
    // Dev-only convenience: allow all origins (no credentials) so a local
    // browser UI (e.g., a SPA on a different port) can hit the API.
    app.enableCors({ origin: true, credentials: false });
  }

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
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`❌ FATAL: Invalid PORT "${rawPort}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  try {
    await app.listen(port);
    const logger = new Logger("Bootstrap");
    logger.log(`BestERP API running on http://localhost:${port}`);
  } catch (err) {
    console.error(
      `❌ FATAL: Failed to listen on port ${port}: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }
}

void bootstrap();
