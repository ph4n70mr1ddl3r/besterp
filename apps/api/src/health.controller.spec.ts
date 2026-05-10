// Unit tests for the health controller.
// Uses NestJS testing utilities — no database required.

import { describe, it, expect, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { HealthController } from "./health.controller.js";
import { PrismaService } from "./prisma/prisma.service.js";

describe("HealthController", () => {
  it('returns ok status from health()', () => {
    const controller = new HealthController(null as any);
    const result = controller.health();

    expect(result.status).toBe("ok");
    expect(result.service).toBe("besterp-api");
    expect(result.version).toBe("0.0.1");
    expect(result.timestamp).toBeDefined();
  });

  it('returns ready status from ready()', async () => {
    // Create a mock PrismaService
    const mockPrisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    };

    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: mockPrisma }],
    })
      .overrideGuard(require("@nestjs/core").Reflector)
      .useValue({ getAllAndOverride: () => true }) // make it public
      .compile();

    const controller = module.get(HealthController);
    const result = await controller.ready();

    expect(result.status).toBe("ready");
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });
});
