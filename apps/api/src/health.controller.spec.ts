// Unit tests for HealthController
// Tests the health check endpoint and environment validation

import { Test, TestingModule } from "@nestjs/testing";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

describe("HealthController", () => {
  let controller: HealthController;
  let healthService: HealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            getHealth: jest.fn(),
            getVersion: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthService = module.get<HealthService>(HealthService);
  });

  describe("getHealth", () => {
    it("should return health status", async () => {
      const expectedResponse = {
        status: "ok",
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        environment: "test",
        database: "connected",
        memory: expect.objectContaining({
          used: expect.any(Number),
          total: expect.any(Number),
          percentage: expect.any(Number),
        }),
      };

      jest.spyOn(healthService, "getHealth").mockResolvedValue(expectedResponse);

      const result = await controller.getHealth();
      expect(result).toEqual(expectedResponse);
      expect(healthService.getHealth).toHaveBeenCalled();
    });

    it("should handle database connection errors", async () => {
      jest.spyOn(healthService, "getHealth").mockResolvedValue({
        status: "error",
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        environment: "test",
        database: "disconnected",
        memory: expect.objectContaining({
          used: expect.any(Number),
          total: expect.any(Number),
          percentage: expect.any(Number),
        }),
      });

      const result = await controller.getHealth();
      expect(result.status).toBe("error");
      expect(result.database).toBe("disconnected");
    });
  });

  describe("getVersion", () => {
    it("should return version information", async () => {
      const expectedResponse = {
        version: "0.0.1",
        name: "@besterp/api",
        nodeVersion: process.version,
        environment: "test",
      };

      jest.spyOn(healthService, "getVersion").mockResolvedValue(expectedResponse);

      const result = await controller.getVersion();
      expect(result).toEqual(expectedResponse);
      expect(healthService.getVersion).toHaveBeenCalled();
    });

    it("should include additional build information when available", async () => {
      process.env.BUILD_NUMBER = "123";
      process.env.BUILD_DATE = "2024-01-01";

      const expectedResponse = {
        version: "0.0.1",
        name: "@besterp/api",
        nodeVersion: process.version,
        environment: "test",
        build: {
          number: "123",
          date: "2024-01-01",
        },
      };

      jest.spyOn(healthService, "getVersion").mockResolvedValue(expectedResponse);

      const result = await controller.getVersion();
      expect(result.build).toEqual(expectedResponse.build);

      // Clean up environment variables
      delete process.env.BUILD_NUMBER;
      delete process.env.BUILD_DATE;
    });
  });
});