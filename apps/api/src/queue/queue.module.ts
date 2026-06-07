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

  static forRoot(options?: Partial<QueueModuleOptions>): DynamicModule {
    const redisHost = options?.redis?.host || process.env.REDIS_HOST || "localhost";
    // The default port (6379) intentionally differs from .env.example (6380)
    // because the example targets a non-default Docker-mapped port. Operators
    // who set REDIS_HOST without REDIS_PORT will silently hit the standard
    // Redis port; log a warning when we fall back to the hard-coded default
    // so they notice.
    let redisPort: number;
    if (options?.redis?.port) {
      redisPort = options.redis.port;
    } else if (process.env.REDIS_PORT) {
      redisPort = Number.parseInt(process.env.REDIS_PORT, 10);
    } else {
      redisPort = 6379;
      this.logger.warn(
        "REDIS_PORT is not set — defaulting to 6379. Note: .env.example uses 6380. " +
        "Set REDIS_PORT explicitly to avoid connecting to the wrong Redis instance."
      );
    }
    if (!Number.isFinite(redisPort) || redisPort < 1 || redisPort > 65535) {
      throw new Error(
        `Invalid Redis port: ${redisPort}. Must be a number between 1 and 65535.`
      );
    }
    const redisPassword = options?.redis?.password || process.env.REDIS_PASSWORD;

    const connection: {
      host: string;
      port: number;
      maxRetriesPerRequest: null;
      retryStrategy: (times: number) => number;
      connectTimeout: number;
      password?: string;
    } = {
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null, // required by BullMQ for sticky connections
      retryStrategy: (times: number): number => Math.min(times * 200, 5000),
      connectTimeout: 10000,
      ...(redisPassword ? { password: redisPassword } : {}),
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
