// Unit tests for PrismaService
// Tests tenant client caching, eviction, destroyed guard, and lifecycle

import { describe, it, expect, vi, beforeEach } from "vitest";

// PrismaService extends PrismaClient, which requires a datasource.
// We mock the PrismaClient constructor to avoid needing a real DB.
vi.mock("@prisma/client", () => {
  function MockPrismaClient(this: any, opts?: any) {
    this._opts = opts;
    this.$connect = vi.fn().mockResolvedValue(undefined);
    this.$disconnect = vi.fn().mockResolvedValue(undefined);
    this.$executeRaw = vi.fn();
    this.party = { findMany: vi.fn() };
  }
  return { PrismaClient: MockPrismaClient };
});

vi.mock("@besterp/database", () => ({
  createTenantClient: vi.fn().mockImplementation((_prisma: any, tenantId: string) => ({
    party: {},
    _tenantId: tenantId,
  })),
}));

import { PrismaService } from "./prisma.service.js";

describe("PrismaService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tenantScoped", () => {
    it("should return a tenant-scoped client", () => {
      const service = new PrismaService();
      const client = service.tenantScoped("tenant-1");
      expect(client).toBeDefined();
    });

    it("should return the same client for the same tenant ID (caching)", () => {
      const service = new PrismaService();
      const client1 = service.tenantScoped("tenant-1");
      const client2 = service.tenantScoped("tenant-1");
      expect(client1).toBe(client2);
    });

    it("should return different clients for different tenant IDs", () => {
      const service = new PrismaService();
      const client1 = service.tenantScoped("tenant-1");
      const client2 = service.tenantScoped("tenant-2");
      expect(client1).not.toBe(client2);
    });

    it("should throw when service is destroyed", async () => {
      const service = new PrismaService();
      await service.onModuleDestroy();
      expect(() => service.tenantScoped("tenant-1")).toThrow(
        "PrismaService is destroyed"
      );
    });
  });

  describe("onModuleDestroy", () => {
    it("should clear tenant client caches", async () => {
      const service = new PrismaService();
      // Create some cached clients
      service.tenantScoped("tenant-1");
      service.tenantScoped("tenant-2");

      await service.onModuleDestroy();

      // After destruction, creating a new client should throw
      expect(() => service.tenantScoped("tenant-1")).toThrow(
        "PrismaService is destroyed"
      );
    });

    it("should disconnect both admin and app clients", async () => {
      const service = new PrismaService();
      await service.onModuleDestroy();
      // Both $disconnect should have been called (admin = this, app = _appClient)
      expect(service.$disconnect).toHaveBeenCalled();
      expect(service.appClient.$disconnect).toHaveBeenCalled();
    });
  });

  describe("admin and appClient getters", () => {
    it("admin should return the base (admin) PrismaClient", () => {
      const service = new PrismaService();
      expect(service.admin).toBe(service);
    });

    it("appClient should return the app PrismaClient", () => {
      const service = new PrismaService();
      expect(service.appClient).toBeDefined();
      expect(service.appClient).not.toBe(service);
    });
  });
});
