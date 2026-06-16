// Queue Module — Redis/BullMQ infrastructure for domain events and async jobs.
//
// Provides:
// - BullMQ queues registered via NestJS module
// - Domain event publishing infrastructure
// - Job scheduling and processing base classes
//
// Phase 0b: Infrastructure only — queues will be used for domain events
// when cross-module coordination is needed (Phase 1+).

import { DynamicModule, Logger, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

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

  private static resolveRedisOptions(options?: Partial<QueueModuleOptions>): { host: string; port: number; password: string | undefined } {
    const host = options?.redis?.host || process.env.REDIS_HOST || "localhost";
    if (!host || host.trim().length === 0) {
      throw new Error("Redis host is required. Set REDIS_HOST or provide options.redis.host.");
    }
    let port: number;
    if (options?.redis?.port) {
      port = options.redis.port;
    } else if (process.env.REDIS_PORT) {
      port = Number.parseInt(process.env.REDIS_PORT, 10);
    } else {
      port = 6379;
      this.logger.warn(
        "REDIS_PORT is not set — defaulting to 6379. Note: .env.example uses 6380. " +
        "Set REDIS_PORT explicitly to avoid connecting to the wrong Redis instance."
      );
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid Redis port: ${port}. Must be a number between 1 and 65535.`);
    }
    const password = options?.redis?.password || process.env.REDIS_PASSWORD;
    return { host, port, password };
  }

  private static redisRetryStrategy(times: number): number | undefined {
    const MAX_RETRIES = 10;
    if (times > MAX_RETRIES) {
      this.logger.error(`Redis connection failed after ${MAX_RETRIES} retries — aborting.`);
      return undefined;
    }
    return Math.min(times * 200, 5000);
  }

  static forRoot(options?: Partial<QueueModuleOptions>): DynamicModule {
    const { host, port, password } = this.resolveRedisOptions(options);

    const connection: {
      host: string;
      port: number;
      maxRetriesPerRequest: null;
      retryStrategy: (times: number) => number | undefined;
      connectTimeout: number;
      password?: string;
    } = {
      host,
      port,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => QueueModule.redisRetryStrategy(times),
      connectTimeout: 10000,
      ...(password ? { password } : {}),
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
