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
import { sanitizeForLogOutput, JWT_EXPIRES_IN_REGEX } from "@besterp/shared";
import { isWeakSecret, MIN_JWT_SECRET_LENGTH } from "./auth/secret-strength.js";
import { AppModule } from "./app.module.js";
import express, { type Request, type Response, type NextFunction } from "express";
// Import tenant-context for the Express module augmentation (req.requestId).
// This must remain imported so TypeScript recognises requestId on the Request type.
import "./common/tenant-context.js";
import { resolveRequestId } from "./common/request-id.js";

const logger = new Logger("Bootstrap");

function normalizeEnvironment(): void {
  // Normalize NODE_ENV early so all downstream comparisons are case-insensitive.
  // Without this, "PRODUCTION", "Production", or "production" would silently
  // bypass production guards and fall back to development behavior.
  if (process.env.NODE_ENV) {
    process.env.NODE_ENV = process.env.NODE_ENV.toLowerCase();
  }
}

function validateEnvironment(): void {
  const requiredInProduction = ["DATABASE_URL", "DATABASE_ADMIN_URL", "JWT_SECRET"];
  const missing = requiredInProduction.filter((v) => !process.env[v]);
  if (missing.length > 0 && process.env.NODE_ENV === "production") {
    logger.error(`Missing required environment variables: ${missing.join(", ")}. Exiting.`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
    logger.warn("DATABASE_URL not set — database operations will fail. Set DATABASE_URL before running the API.");
  }

  // Validate JWT_EXPIRES_IN format if provided.
  if (process.env.JWT_EXPIRES_IN && !JWT_EXPIRES_IN_REGEX.test(process.env.JWT_EXPIRES_IN)) {
    logger.error(
      `JWT_EXPIRES_IN "${process.env.JWT_EXPIRES_IN}" is invalid. Must be a duration string like "24h", "60m", "7d".`
    );
    process.exit(1);
  }

  // Fail if JWT_SECRET is missing in any non-development environment.
  // In development, a random ephemeral secret is generated instead.
  if (!process.env.JWT_SECRET && process.env.NODE_ENV !== "development") {
    logger.error(
      "JWT_SECRET is not set. This is required in non-development environments. " +
      "Set JWT_SECRET before running the API."
    );
    process.exit(1);
  }

  // Validate JWT_SECRET strength if provided.
  if (process.env.JWT_SECRET) {
    const secret = process.env.JWT_SECRET;
    if (secret.length < MIN_JWT_SECRET_LENGTH) {
      logger.error(
        `JWT_SECRET is too short (${secret.length} chars). Must be at least ${MIN_JWT_SECRET_LENGTH} characters. ` +
        "Generate a secure secret with: openssl rand -hex 32"
      );
      process.exit(1);
    }
    // Warn if the secret looks like a default/test value or has zero entropy
    // (a single repeated character padded out to pass the length check).
    // See ./auth/secret-strength.ts for the heuristics and rationale.
    if (isWeakSecret(secret)) {
      logger.warn(
        "JWT_SECRET appears to be a weak or default value. " +
        "Use a cryptographically random secret in production: openssl rand -hex 32"
      );
    }
  }

  const REDIS_WARN_VARS = ["REDIS_HOST", "REDIS_PORT"];
  const missingRedis = REDIS_WARN_VARS.filter((v) => !process.env[v]);
  if (missingRedis.length > 0 && process.env.NODE_ENV === "production") {
    logger.warn(`Missing Redis env vars: ${missingRedis.join(", ")}. Queues and background jobs will fail.`);
  }
}

function setupGracefulShutdown(app: INestApplication): void {
  const HARD_EXIT_TIMEOUT_MS = Number(process.env.HARD_EXIT_TIMEOUT_MS) || 10_000;
  let shuttingDown = false;

  async function gracefulShutdown(label: string, detail: unknown): Promise<void> {
    const raw = detail instanceof Error ? detail.stack ?? detail.message : String(detail);
    logger.error(`${label}: ${sanitizeForLogOutput(raw)}`);
    if (shuttingDown) process.exit(1);
    shuttingDown = true;

    const hardExitTimer = setTimeout(() => {
      logger.error(`Graceful shutdown exceeded ${HARD_EXIT_TIMEOUT_MS}ms — forcing exit.`);
      process.exit(1);
    }, HARD_EXIT_TIMEOUT_MS);
    hardExitTimer.unref();

    try {
      await app.close();
      clearTimeout(hardExitTimer);
      process.exit(0);
    } catch (closeErr) {
      const errorDetail = closeErr instanceof Error ? closeErr.stack ?? closeErr.message : String(closeErr);
      logger.error(`Error during graceful shutdown: ${sanitizeForLogOutput(errorDetail)}`);
      clearTimeout(hardExitTimer);
      process.exit(1);
    }
  }

  process.on("uncaughtException", (error) => {
    // After an uncaughtException, the process is in an undefined state.
    // Attempting graceful shutdown (app.close()) may hang or corrupt in-flight
    // requests. Log the error and exit immediately — let the process manager
    // (systemd, Docker, PM2) restart a clean instance.
    logger.error(`Uncaught exception: ${sanitizeForLogOutput(error.stack ?? error.message)}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    void gracefulShutdown("Unhandled promise rejection", reason).catch((shutdownErr) => {
      logger.error(`Error during shutdown handler: ${sanitizeForLogOutput(shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr))}`);
      process.exit(1);
    });
  });

  app.enableShutdownHooks();
}

function parseAllowedOrigins(): string[] {
  const corsOrigins = process.env.CORS_ORIGINS;
  if (corsOrigins) {
    const origins = corsOrigins.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
    if (origins.length > 0) return origins;
  }
  // Fall back to restrictive localhost origins in development so that
  // error-middleware CORS headers (which bypass the main CORS middleware)
  // still allow cross-origin error reads from local frontend dev servers.
  if (process.env.NODE_ENV === "development") {
    return [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://localhost:5174",
    ];
  }
  return [];
}

function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin || allowed.length === 0) return false;
  return allowed.includes(origin);
}

function configureCors(app: INestApplication, allowedOrigins: string[]): void {
  if (allowedOrigins.length > 0) {
    const isExplicitConfig = process.env.CORS_ORIGINS != null;
    if (!isExplicitConfig && process.env.NODE_ENV === "development") {
      logger.warn(
        "CORS_ORIGINS not set — using restrictive localhost origins for development. " +
        "Set CORS_ORIGINS for non-standard dev ports."
      );
    }
    // In development the fallback localhost origins imply a local frontend that
    // needs credentials (auth headers / cookies) to reach the API, so always
    // enable credentials when origins are present — only skip it for an
    // explicit production config that doesn't request it.
    app.enableCors({ origin: allowedOrigins, credentials: true });
    return;
  }
  logger.error(
    "CORS_ORIGINS is not set. In non-development environments, CORS_ORIGINS must be " +
    "configured as a comma-separated list of allowed origins (e.g., " +
    "CORS_ORIGINS=https://app.example.com,https://admin.example.com). " +
    "Without this, cross-origin requests will be blocked by the browser. " +
    "Set CORS_ORIGINS and restart the application."
  );
  if (process.env.NODE_ENV === "production") {
    logger.error("CORS_ORIGINS is required in production. Exiting.");
    process.exit(1);
  }
}

function parsePort(): number {
  const rawPort = process.env.PORT || "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.error(`Invalid PORT "${rawPort}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

async function bootstrap() {
  normalizeEnvironment();
  validateEnvironment();

  const app = await NestFactory.create(AppModule, { bodyParser: false });

  setupGracefulShutdown(app);

  app.setGlobalPrefix("api");

  const allowedOrigins = parseAllowedOrigins();
  configureCors(app, allowedOrigins);

  app.use(helmet());

  // Request ID middleware for correlation across logs, traces, and audit.
  // Derives the ID from the `x-request-id` header when it is a safe printable
  // token; otherwise generates a UUID v4. The header is untrusted client
  // input, so resolveRequestId validates it before it is reflected into the
  // response header and stored on req.requestId (defense-in-depth against
  // header/log injection).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  // Limit request body size to 100 KB to prevent DoS via oversized payloads.
  // Uses the raw express middleware since NestFactory.create({ bodyParser: false })
  // disables the built-in body parser.
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  // Handle body-parser errors with clear messages and appropriate status codes.
  // Express error middleware requires exactly 4 parameters.
  // CORS headers are set here so cross-origin clients can read the error
  // even when the main CORS middleware does not run for short-circuit errors.
  function setCorsHeaders(res: Response, origin: string | undefined): void {
    if (origin && isAllowedOrigin(origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  app.use((err: Error & { type?: string }, req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (err.type === "entity.too.large") {
      setCorsHeaders(res, origin);
      res.status(413).json({
        statusCode: 413,
        message: "Request body exceeds the 100 KB limit. Reduce payload size and retry.",
      });
    } else if (err.type === "entity.parse.failed") {
      setCorsHeaders(res, origin);
      res.status(400).json({
        statusCode: 400,
        message: "Request body contains malformed JSON. Check syntax and retry.",
      });
    } else {
      next(err);
    }
  });

  // Catch-all Express error handler — safety net for synchronous throws from
  // Express middleware that escape NestJS's exception filters. Always returns
  // a generic 500 so internal details (stack traces, DB connection strings,
  // middleware internals) are never leaked to the client, even in development.
  // The full sanitized error is logged server-side for debugging.
  // CORS headers are set mirroring the existing CORS middleware so the error
  // body is visible to cross-origin clients regardless of environment.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Unhandled Express middleware error: ${sanitizeForLogOutput(err.message)}`);
    setCorsHeaders(res, req.headers.origin);
    res.status(500).json({
      statusCode: 500,
      message: "Internal server error",
    });
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );

  const port = parsePort();
  try {
    await app.listen(port);
    logger.log(`BestERP API running on http://localhost:${port}`);
  } catch (err) {
    logger.error(`Failed to listen on port ${port}: ${err instanceof Error ? err.message : err}`);
    try { await app.close(); } catch { /* ignore */ }
    process.exit(1);
  }
}

void bootstrap();
