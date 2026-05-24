// Queue Module — Redis/BullMQ infrastructure for domain events and async jobs.
//
// Provides:
// - BullMQ queues registered via NestJS module
// - Domain event publishing infrastructure
// - Job scheduling and processing base classes
//
// Phase 0b: Infrastructure only — queues will be used for domain events
// when cross-module coordination is needed (Phase 1+).

import { DynamicModule, Global, Module } from "@nestjs/common";
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
  static forRoot(options?: Partial<QueueModuleOptions>): DynamicModule {
    const redisHost = options?.redis?.host || process.env.REDIS_HOST || "localhost";
    const redisPort = options?.redis?.port || Number.parseInt(process.env.REDIS_PORT || "6379", 10);
    if (!Number.isFinite(redisPort) || redisPort < 1 || redisPort > 65535) {
      throw new Error(
        `Invalid Redis port: ${process.env.REDIS_PORT}. Must be a number between 1 and 65535.`
      );
    }
    const redisPassword = options?.redis?.password || process.env.REDIS_PASSWORD;

    const connection: Record<string, unknown> = {
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null, // required by BullMQ for sticky connections
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
      connectTimeout: 10000,
    };
    if (redisPassword) {
      connection.password = redisPassword;
    }

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
