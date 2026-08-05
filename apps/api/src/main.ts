// BestERP API — NestJS Bootstrap
//
// Initializes the NestJS application with:
// - Global API prefix
// - CORS for development
// - Request validation pipe
// - JWT secret check (warns in dev, fails in production)

import "reflect-metadata";
import { NestFactory, DiscoveryService } from "@nestjs/core";
import { Logger, ValidationPipe, type INestApplication } from "@nestjs/common";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { sanitizeForLogOutput, JWT_EXPIRES_IN_REGEX, MAX_JWT_EXPIRES_IN_DAYS, isDev, isProd } from "@besterp/shared";
import { isWeakSecret, MIN_JWT_SECRET_LENGTH } from "./auth/secret-strength.js";
import { AppModule } from "./app.module.js";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
// Import tenant-context for the Express module augmentation (req.requestId).
// This must remain imported so TypeScript recognises requestId on the Request type.
import "./common/tenant-context.js";
import { resolveRequestId } from "./common/request-id.js";
import { verifyPublicEndpointsScope } from "./auth/public-scope.js";
import {
  resolveHardExitTimeoutMs,
  resolveRateLimitConfig,
  resolveTrustProxyHops,
  normalizeEnvironmentValue,
  DEFAULT_HARD_EXIT_TIMEOUT_MS,
  type RateLimitConfig,
} from "./bootstrap-config.js";

const logger = new Logger("Bootstrap");

function normalizeEnvironment(): void {
  // Normalize NODE_ENV early so all downstream comparisons are case-insensitive
  // and whitespace-trimmed. Without this, "PRODUCTION", "Production", or a
  // whitespace-padded " production " would silently bypass production guards
  // and fall back to development behavior.
  const normalized = normalizeEnvironmentValue(process.env.NODE_ENV);
  if (normalized !== undefined) {
    process.env.NODE_ENV = normalized;
  }
}

/**
 * Resolve HARD_EXIT_TIMEOUT_MS, warning and falling back to the default on an
 * invalid value (unparseable, NaN, or negative). A negative value is the
 * dangerous case: Node clamps negative setTimeout delays to 1 ms, silently
 * converting graceful shutdown into an immediate forced exit.
 */
function resolveHardExitTimeout(env: NodeJS.ProcessEnv): number {
  try {
    return resolveHardExitTimeoutMs(env);
  } catch (err) {
    logger.warn(err instanceof Error ? err.message : String(err));
    return DEFAULT_HARD_EXIT_TIMEOUT_MS;
  }
}

function validateRequiredEnvVars(): void {
  const requiredInProduction = ["DATABASE_URL", "DATABASE_ADMIN_URL", "JWT_SECRET"];
  const missing = requiredInProduction.filter((v) => !process.env[v]);
  if (missing.length > 0 && isProd()) {
    logger.error(`Missing required environment variables: ${missing.join(", ")}. Exiting.`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && !isProd()) {
    logger.warn("DATABASE_URL not set — database operations will fail. Set DATABASE_URL before running the API.");
  }
}

function validateJwtConfig(): void {
  validateJwtExpiresIn();
  validateJwtSecretPresence();
  validateJwtSecretStrength();
}

function validateJwtExpiresIn(): void {
  // Validate JWT_EXPIRES_IN format if provided.
  if (process.env.JWT_EXPIRES_IN && !JWT_EXPIRES_IN_REGEX.test(process.env.JWT_EXPIRES_IN)) {
    logger.error(
      `JWT_EXPIRES_IN "${process.env.JWT_EXPIRES_IN}" is invalid. Must be a duration string like "24h", "60m", "7d".`
    );
    process.exit(1);
  }
  // Enforce a maximum token lifetime to prevent absurdly long-lived tokens
  // (e.g., "9999999999d" ≈ 27,397 years). The regex allows magnitudes up to
  // 10 digits, so we parse and cap the effective duration at 30 days.
  if (process.env.JWT_EXPIRES_IN) {
    const match = JWT_EXPIRES_IN_REGEX.exec(process.env.JWT_EXPIRES_IN);
    if (match) {
      const value = Number(match[1]);
      const unit = match[2];
      let exceedsMax = false;
      if (unit === "d" && value > MAX_JWT_EXPIRES_IN_DAYS) exceedsMax = true;
      else if (unit === "h" && value / 24 > MAX_JWT_EXPIRES_IN_DAYS) exceedsMax = true;
      else if (unit === "m" && value / (24 * 60) > MAX_JWT_EXPIRES_IN_DAYS) exceedsMax = true;
      else if (unit === "s" && value / (24 * 60 * 60) > MAX_JWT_EXPIRES_IN_DAYS) exceedsMax = true;
      if (exceedsMax) {
        logger.error(
          `JWT_EXPIRES_IN "${process.env.JWT_EXPIRES_IN}" exceeds the maximum allowed token lifetime of ${MAX_JWT_EXPIRES_IN_DAYS} days.`
        );
        process.exit(1);
      }
    }
  }
}

function validateJwtSecretPresence(): void {
  // Fail if JWT_SECRET is missing in any non-development environment.
  // In development, a random ephemeral secret is generated instead.
  if (!process.env.JWT_SECRET && !isProd()) {
    logger.error(
      "JWT_SECRET is not set. This is required in non-development environments. " +
      "Set JWT_SECRET before running the API."
    );
    process.exit(1);
  }
}

function validateJwtSecretStrength(): void {
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
}

function validateRedisConfig(): void {
  // REDIS_PASSWORD is included so a missing production password is flagged
  // here as a clear env-var warning rather than surfacing later as a
  // confusing QueueModule init throw inside NestFactory.create.
  const REDIS_WARN_VARS = ["REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"];
  const missingRedis = REDIS_WARN_VARS.filter((v) => !process.env[v]);
  if (missingRedis.length > 0 && isProd()) {
    logger.warn(`Missing Redis env vars: ${missingRedis.join(", ")}. Queues and background jobs will fail.`);
  }
}

function validateEnvironment(): void {
  validateRequiredEnvVars();
  validateJwtConfig();
  validateRedisConfig();
}

function setupGracefulShutdown(app: INestApplication): void {
  const HARD_EXIT_TIMEOUT_MS = resolveHardExitTimeout(process.env);
  let shuttingDown = false;

  async function gracefulShutdown(label: string, detail: unknown): Promise<void> {
    const raw = detail instanceof Error ? detail.stack ?? detail.message : String(detail);
    logger.error(`${label}: ${sanitizeForLogOutput(raw)}`);
    // Set the flag BEFORE checking to prevent a second concurrent invocation
    // from also logging and starting a second hard-exit timer. The first
    // invocation that reaches this point wins; the loser exits immediately.
    if (shuttingDown) process.exit(1);
    shuttingDown = true;

    const hardExitTimer = setTimeout(() => {
      logger.error(`Graceful shutdown exceeded ${HARD_EXIT_TIMEOUT_MS}ms — forcing exit.`);
      process.exit(1);
    }, HARD_EXIT_TIMEOUT_MS);
    hardExitTimer.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (closeErr) {
      const errorDetail = closeErr instanceof Error ? closeErr.stack ?? closeErr.message : String(closeErr);
      logger.error(`Error during graceful shutdown: ${sanitizeForLogOutput(errorDetail)}`);
      process.exit(1);
    } finally {
      clearTimeout(hardExitTimer);
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
    void gracefulShutdown("Unhandled promise rejection", reason);
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
  if (isDev()) {
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
    if (!isExplicitConfig && isDev()) {
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
  if (isProd()) {
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
  if (rawPort === "3000" && !process.env.PORT) {
    logger.warn(
      "PORT not set — defaulting to 3000. Set PORT explicitly in production."
    );
  }
  return port;
}

function resolveListenAddress(port: number, server: Server): string {
  const addr = server.address();
  if (!addr) return `http://localhost:${port}`;
  const address = typeof addr === "string" ? addr : addr?.address ?? "localhost";
  const network = address === "::" || address === "0.0.0.0" ? "0.0.0.0" : address;
  return `http://${network}:${port}`;
}

async function bootstrap() {
  normalizeEnvironment();
  validateEnvironment();

  // Resolve rate-limiter config up front so an invalid RATE_LIMIT_WINDOW_MS /
  // RATE_LIMIT_MAX_PER_WINDOW (e.g. "abc" → NaN) fails fast at boot instead of
  // silently disabling the brute-force protection control.
  let rateLimitConfig: RateLimitConfig;
  try {
    rateLimitConfig = resolveRateLimitConfig(process.env);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Resolve TRUST_PROXY_HOPS up front for the same fail-fast reason. When the
  // app sits behind a reverse proxy / load balancer that does NOT set this,
  // express-rate-limit v8 logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
  // proxied request AND keys every client on the proxy's IP (one shared
  // bucket), so a single abusive caller throttles the whole proxy.
  let trustProxyHops: number;
  try {
    trustProxyHops = resolveTrustProxyHops(process.env);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, { bodyParser: false });

  setupGracefulShutdown(app);

  // Trust exactly the configured number of proxy hops for client-IP
  // resolution. Opt-in and fail-closed: default 0 keeps req.ip tied to the
  // socket peer so a directly-connected client cannot forge X-Forwarded-For.
  if (trustProxyHops > 0) {
    const expressApp = app.getHttpAdapter().getInstance() as express.Express;
    expressApp.set("trust proxy", trustProxyHops);
    logger.warn(
      `TRUST_PROXY_HOPS=${trustProxyHops} — trusting that many reverse-proxy hops for client IPs. ` +
      "Every proxy in front MUST overwrite inbound X-Forwarded-For headers, otherwise IP-based " +
      "rate limiting can be bypassed by a directly-connected client."
    );
  }

  app.setGlobalPrefix("api");

  // Rate limiting — protects against brute-force auth attacks, MCP tool
  // exhaustion, and scraping of public endpoints. Uses a sliding window
  // approach so bursts are smoothed over time rather than allowing a full
  // quota every N seconds.
  const generalLimiter = rateLimit({
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { statusCode: 429, error: "RATE_LIMITED", message: "Rate limit exceeded. Please slow down and retry." },
  });
  // Helmet security headers — register FIRST so rate-limit 429 responses
  // and other early-exit paths also carry security headers.
  app.use(helmet());

  // Skip rate limiter for health/readiness endpoints — load balancers and
  // orchestrators poll these frequently, and rate-limiting them can cause
  // false-positive health failures and premature instance de-registration.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/health" || req.path.startsWith("/api/health/")) {
      return next();
    }
    return generalLimiter(req, res, next);
  });

  const allowedOrigins = parseAllowedOrigins();
  configureCors(app, allowedOrigins);

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

  // Limit request body size to 1 MB to prevent DoS via oversized payloads.
  // Uses the raw express middleware since NestFactory.create({ bodyParser: false })
  // disables the built-in body parser. Increased from 100 KB which was too
  // restrictive for legitimate ERP payloads (multi-line descriptions, contacts).
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  // Handle body-parser errors with clear messages and appropriate status codes.
  // Express error middleware requires exactly 4 parameters.
  // CORS headers are set here so cross-origin clients can read the error
  // even when the main CORS middleware does not run for short-circuit errors.
  function setCorsHeaders(res: Response, origin: string | undefined): void {
    if (origin && isAllowedOrigin(origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
  }

  // Consolidated Express error handler — catches body-parser errors (entity.too.large,
  // entity.parse.failed) and delegates everything else to the next handler. This replaces
  // two separate error middleware registrations with a single entry point that is easier to
  // maintain and keeps CORS header logic in one place.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (err && typeof err === "object" && "type" in err) {
      const typedErr = err as { type?: string };
      if (typedErr.type === "entity.too.large") {
        setCorsHeaders(res, origin);
        res.status(413).json({ statusCode: 413, message: "Request body exceeds the 1 MB limit. Reduce payload size and retry." });
        return;
      }
      if (typedErr.type === "entity.parse.failed") {
        setCorsHeaders(res, origin);
        res.status(400).json({ statusCode: 400, message: "Request body could not be parsed. Check syntax and retry." });
        return;
      }
    }
    next(err);
  });

  // Catch-all Express error handler — safety net for synchronous throws from
  // Express middleware that escape NestJS's exception filters. Always returns
  // a generic 500 so internal details (stack traces, DB connection strings,
  // middleware internals) are never leaked to the client, even in development.
  // The full sanitized error is logged server-side for debugging.
  // CORS headers are set mirroring the existing CORS middleware so the error
  // body is visible to cross-origin clients regardless of environment.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Unhandled Express middleware error: ${sanitizeForLogOutput(message)}`);
    setCorsHeaders(res, req.headers.origin);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );

  // Boot-time guard against a mis-scoped @Public(): scan every registered
  // controller/handler and abort startup if any non-Health endpoint opts out
  // of authentication. This catches the silent footgun at deploy time that the
  // per-request check in isPublicAllowedForHandler would otherwise only catch
  // when an attacker happens to hit the route.
  try {
    const discovery = app.get(DiscoveryService);
    verifyPublicEndpointsScope(discovery);
  } catch (scanErr) {
    logger.error(
      `Startup aborted by @Public() scope verification: ${
        sanitizeForLogOutput(scanErr instanceof Error ? scanErr.message : String(scanErr))
      }`
    );
    process.exit(1);
  }

  const port = parsePort();
  try {
    const server = await app.listen(port);
    const listenAddr = resolveListenAddress(port, server);
    logger.log(`BestERP API running on ${listenAddr}`);
  } catch (err) {
    logger.error(`Failed to listen on port ${port}: ${sanitizeForLogOutput(err instanceof Error ? err.message : String(err))}`);
    try {
      await app.close();
    } catch (closeErr) {
      logger.debug(`App close error after listen failure: ${sanitizeForLogOutput(closeErr instanceof Error ? closeErr.message : String(closeErr))}`);
    }
    process.exit(1);
  }
}

void bootstrap();
