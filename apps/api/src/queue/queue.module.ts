// Queue Module — Redis/BullMQ infrastructure for domain events and async jobs.
//
// Provides:
// - BullMQ queues registered via NestJS module
// - Domain event publishing infrastructure
// - Job scheduling and processing base classes
//
// Infrastructure: queues are registered but not yet used for domain events.
// Will be consumed by feature modules when cross-module coordination is needed.

import { DynamicModule, Logger, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { resolveRedisTls, sanitizeForLogOutput } from "@besterp/shared";

export interface QueueModuleOptions {
  redis: {
    host: string;
    port: number;
    password?: string;
  };
}

@Module({})
export class QueueModule {
  private static readonly logger = new Logger(QueueModule.name);

  private static resolveRedisOptions(options?: Partial<QueueModuleOptions>): { host: string; port: number; password: string | undefined; tls: { rejectUnauthorized: boolean } | undefined } {
    const rawHost = options?.redis?.host || process.env.REDIS_HOST;
    // Fail closed in non-development: a silently-defaulted localhost Redis in
    // production is a misconfiguration footgun — the app would connect to an
    // unintended (and unauthenticated, if REDIS_PASSWORD is also unset) Redis
    // rather than erroring. Only development keeps the localhost fallback so a
    // local dev box can run without env wiring; production must set REDIS_HOST
    // explicitly (mirrors resolvePassword's production guard).
    if (!rawHost && process.env.NODE_ENV?.toLowerCase() !== "development") {
      this.logger.error(
        "REDIS_HOST not set in production — refusing to default to localhost (would connect to an unintended Redis instance)."
      );
      throw new Error("Redis host is required in non-development environments. Set REDIS_HOST.");
    }
    const host = (rawHost ?? "localhost").trim();
    if (!host) {
      throw new Error("Redis host is required. Set REDIS_HOST or provide options.redis.host.");
    }
    const port = this.resolvePort(options?.redis?.port);
    const password = this.resolvePassword(options?.redis?.password);
    const tls = this.resolveTls();
    return { host, port, password, tls };
  }

  /**
   * Resolve whether the Redis connection must use TLS (default-on in
   * non-development). Without TLS the password and all job payloads travel in
   * cleartext, so a network observer can capture credentials and queued data.
   * Opt back out only in development via REDIS_TLS=0. The connection object
   * spreads the result, so `tls: undefined` leaves the (plain) socket as-is.
   */
  private static resolveTls(): { rejectUnauthorized: boolean } | undefined {
    if (!resolveRedisTls()) return undefined;
    return { rejectUnauthorized: true };
  }

  private static resolvePassword(explicitPassword?: string): string | undefined {
    const password = explicitPassword || process.env.REDIS_PASSWORD || undefined;
    if (password !== undefined && password.trim().length === 0) {
      throw new Error("Redis password is set but empty. Provide a non-empty password or unset REDIS_PASSWORD.");
    }
    if (!password && process.env.NODE_ENV?.toLowerCase() !== "development") {
      this.logger.error(
        "REDIS_PASSWORD not set in production — refusing to connect without authentication."
      );
      throw new Error(
        "Redis password is required in non-development environments. Set REDIS_PASSWORD."
      );
    }
    return password?.trim();
  }

  /** Warn once per process that REDIS_PORT is missing in dev. A per-call
   *  warning fires on every startup and every test that exercises forRoot,
   *  which drowns out real warnings. Track via a module-level flag so the
   *  message is emitted exactly once. */
  private static _redisPortWarned = false;

  private static resolvePort(explicitPort?: number): number {
    if (explicitPort !== undefined) return this.validatePort(explicitPort);
    if (process.env.REDIS_PORT) return this.validatePort(Number.parseInt(process.env.REDIS_PORT, 10));
    // Mirror the fail-closed posture of the host/password guards: silently
    // defaulting to 6380 in production could point the app at an unintended
    // Redis instance (e.g. an unrelated service on the same host) with no
    // error. Only development keeps the fallback.
    if (process.env.NODE_ENV?.toLowerCase() !== "development") {
      this.logger.error(
        "REDIS_PORT not set in production — refusing to default to 6380 (would connect to a possibly unintended Redis instance)."
      );
      throw new Error("Redis port is required in non-development environments. Set REDIS_PORT.");
    }
    if (!QueueModule._redisPortWarned) {
      QueueModule._redisPortWarned = true;
      this.logger.warn(
        "REDIS_PORT is not set — defaulting to 6380 to match .env.example. " +
        "Set REDIS_PORT explicitly to avoid connecting to the wrong Redis instance."
      );
    }
    return 6380;
  }

  private static validatePort(port: number): number {
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid Redis port: ${port}. Must be a number between 1 and 65535.`);
    }
    return port;
  }

  private static redisRetryStrategy(times: number, lastError?: Error): number | undefined {
    const MAX_RETRIES = 10;
    if (times > MAX_RETRIES) {
      QueueModule.logger.error(
        `Redis connection failed after ${MAX_RETRIES} retries — aborting. ${lastError ? `Last error: ${sanitizeForLogOutput(lastError.message)}` : ""}`
      );
      return undefined;
    }
    const baseDelay = Math.min(times * 200, 5000);
    const jitter = Math.random() * 200;
    return baseDelay + jitter;
  }

  static forRoot(options?: Partial<QueueModuleOptions>): DynamicModule {
    const { host, port, password, tls } = this.resolveRedisOptions(options);

    const connection: {
      host: string;
      port: number;
      maxRetriesPerRequest: null;
      retryStrategy: (times: number) => number | undefined;
      connectTimeout: number;
      password?: string;
      tls?: { rejectUnauthorized: boolean };
    } = {
      host,
      port,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number, lastError?: Error) => QueueModule.redisRetryStrategy(times, lastError),
      connectTimeout: 10000,
      ...(password ? { password } : {}),
      ...(tls ? { tls } : {}),
    };

    return {
      module: QueueModule,
      global: true,
      imports: [
        BullModule.forRoot({
          connection,
        }),
      ],
      exports: [BullModule],
    };
  }

  /**
   * Register a named queue for a specific domain.
   *
   * Usage in a feature module:
   * ```ts
   * imports: [QueueModule.registerQueue("party-events")]
   * ```
   */
  static registerQueue(queueName: string): DynamicModule {
    return {
      module: QueueModule,
      imports: [BullModule.registerQueue({ name: queueName })],
      exports: [BullModule],
    };
  }
}
