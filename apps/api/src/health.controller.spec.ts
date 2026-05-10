// Unit tests for the health controller.
// Uses direct construction — no NestJS module overhead needed for simple controllers.

import { describe, it, expect, vi } from "vitest";
import { HealthController } from "./health.controller.js";

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
    const mockPrisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    };

    const controller = new HealthController(mockPrisma as any);
    const result = await controller.ready();

    expect(result.status).toBe("ready");
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });
});
