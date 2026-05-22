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

@Global()
@Module({})
export class QueueModule {
  static forRoot(options?: Partial<QueueModuleOptions>): DynamicModule {
    const redisHost = options?.redis?.host || process.env.REDIS_HOST || "localhost";
    const redisPort = options?.redis?.port || parseInt(process.env.REDIS_PORT || "6380", 10);

    return {
      module: QueueModule,
      imports: [
        BullModule.forRoot({
          connection: {
            host: redisHost,
            port: redisPort,
            password: options?.redis?.password,
          },
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
