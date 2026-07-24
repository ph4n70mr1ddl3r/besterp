// Unit tests for PrismaService
// Tests tenant client caching, eviction, destroyed guard, and lifecycle

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// Set env vars before PrismaService is imported so the constructor's
// DATABASE_ADMIN_URL check passes in test mode.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test@localhost:5432/test";
process.env.DATABASE_ADMIN_URL = "postgresql://admin@localhost:5432/test";

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

import { InvalidTypeValueError } from "@besterp/shared";

vi.mock("@besterp/database", () => ({
  createTenantClient: vi.fn().mockImplementation((_prisma: any, tenantId: string) => ({
    party: {},
    _tenantId: tenantId,
  })),
  validateTenantIdEnhanced: vi.fn((tenantId: string) => {
    const trimmed = tenantId.trim();
    // Mirror the real validation logic for testing
    if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      throw new InvalidTypeValueError(
        `Invalid tenant ID: "${trimmed}".`,
        { context: { field: "tenantId", received: trimmed } }
      );
    }
    if (trimmed.length > 100) {
      throw new InvalidTypeValueError(
        "Tenant ID is too long (max 100 characters)",
        { context: { field: "tenantId", received: trimmed, maxLength: 100 } }
      );
    }
    return trimmed;
  }),
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

    it("should reject invalid tenant ID format", () => {
      const service = new PrismaService();
      expect(() => service.tenantScoped("bad@tenant")).toThrow();
      expect(() => service.tenantScoped("")).toThrow();
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

    it("should sanitize DB connection strings from onModuleDestroy disconnect logs", async () => {
      // Regression guard: a disconnect rejection carries a driver error whose
      // message can embed the datasource URL. `${reason}` stringifies an Error
      // as `name: message`, so the URL would reach the log verbatim without
      // the sanitizeForLogOutput scrub applied in onModuleDestroy.
      const service = new PrismaService();
      // Force the app client disconnect to reject with a URL-bearing error.
      service.appClient.$disconnect = vi.fn().mockRejectedValue(
        new Error("Connection lost: postgres://besterp:s3cret-pw@10.0.0.5:5432/besterp")
      );
      // `logger` is private; access via cast for the test spy.
      const logger = (service as unknown as { logger: { error: (m: string) => void } }).logger;
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      await service.onModuleDestroy();
      // Capture call args BEFORE mockRestore, which clears mock.calls.
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      errorSpy.mockRestore();

      expect(logged).not.toContain("s3cret-pw");
      expect(logged).not.toContain("postgres://besterp");
      expect(logged).toContain("[DATABASE_URL]");
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

  describe("boot-time RLS / role verification fail-closed", () => {
    const prevDbUrl = process.env.DATABASE_URL;
    const prevAdminUrl = process.env.DATABASE_ADMIN_URL;
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://app:app@localhost:5432/besterp";
      process.env.DATABASE_ADMIN_URL = "postgres://admin:admin@localhost:5432/besterp";
    });
    afterAll(() => {
      if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDbUrl;
      if (prevAdminUrl === undefined) delete process.env.DATABASE_ADMIN_URL;
      else process.env.DATABASE_ADMIN_URL = prevAdminUrl;
    });

    it("refuses to boot when the role verification query fails (tenant isolation unverified)", async () => {
      const service = new PrismaService();
      // Make the real verifyAppClientRole run but have its pg_roles lookup fail,
      // so the fail-closed path is exercised (spying on the method would bypass
      // its body and never reach the catch).
      (service.appClient as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = vi
        .fn()
        .mockRejectedValue(new Error("permission denied on pg_catalog.pg_roles"));
      await expect(service.onModuleInit()).rejects.toThrow(/tenant isolation unverified/);
    });

    it("refuses to boot when the RLS enablement verification query fails (tenant isolation unverified)", async () => {
      const service = new PrismaService();
      // current_user lookup succeeds (so verifyAppClientRole passes), but the
      // pg_class RLS check query fails — exercising the fail-closed path in
      // verifyRlsEnabled.
      let call = 0;
      (service.appClient as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = vi
        .fn()
        .mockImplementation(async () => {
          call += 1;
          if (call === 1) return [{ role: "besterp_app" }];
          if (call === 2) return [{ rolsuper: false, rolcatupdate: false }];
          throw new Error("relation pg_class does not exist");
        });
      await expect(service.onModuleInit()).rejects.toThrow(/tenant isolation unverified/);
    });

    it("boots successfully when global reference tables lack RLS but all tenant tables have force RLS", async () => {
      // Regression guard: verifyRlsEnabled must only require RLS on the
      // enumerated tenant tables. Global reference tables (party_type, role_type,
      // contact_mechanism_type) are intentionally NOT RLS-enforced and would
      // previously be flagged as "missing", causing a false boot failure.
      const service = new PrismaService();
      let call = 0;
      (service.appClient as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = vi
        .fn()
        .mockImplementation(async () => {
          call += 1;
          if (call === 1) return [{ role: "besterp_app" }];
          if (call === 2) return [{ rolsuper: false, rolbypassrls: false }];
          return [
            { relname: "party_type", relrowsecurity: false, relforcerowsecurity: false },
            { relname: "role_type", relrowsecurity: false, relforcerowsecurity: false },
            { relname: "contact_mechanism_type", relrowsecurity: false, relforcerowsecurity: false },
            { relname: "party", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "contact_mechanism", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "party_contact_mechanism", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "party_role", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "ai_action_log", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "idempotency_record", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "person", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "organization", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "postal_address", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "telecom_number", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "email_address", relrowsecurity: true, relforcerowsecurity: true },
          ];
        });
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it("still refuses to boot when a tenant table is missing force RLS", async () => {
      const service = new PrismaService();
      let call = 0;
      (service.appClient as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = vi
        .fn()
        .mockImplementation(async () => {
          call += 1;
          if (call === 1) return [{ role: "besterp_app" }];
          if (call === 2) return [{ rolsuper: false, rolbypassrls: false }];
          return [
            { relname: "party_type", relrowsecurity: false, relforcerowsecurity: false },
            { relname: "party", relrowsecurity: true, relforcerowsecurity: false },
          ];
        });
      await expect(service.onModuleInit()).rejects.toThrow(/Row-Level Security is NOT/);
    });
  });

  describe("onModuleInit error logging", () => {
    it("should sanitize DB connection strings from the connect-failure log", async () => {
      // Regression guard: PrismaClientInitializationError / driver connection
      // errors embed the datasource URL (credentials + hostname) in their
      // message and stack. onModuleInit must scrub these before logging,
      // consistent with main.ts shutdown and the global error handler.
      const prevDbUrl = process.env.DATABASE_URL;
      const prevAdminUrl = process.env.DATABASE_ADMIN_URL;
      process.env.DATABASE_URL = "postgres://app:s3cret-app@10.0.0.5:5432/besterp";
      process.env.DATABASE_ADMIN_URL = "postgres://admin:s3cret-adm@10.0.0.5:5432/besterp";

      const service = new PrismaService();
      // app client connect fails with a URL-bearing driver-style error.
      service.appClient.$connect = vi.fn().mockRejectedValue(
        new Error("connect failed: postgres://app:s3cret-app@10.0.0.5:5432/besterp")
      );
      const logger = (service as unknown as {
        logger: { error: (m: string, t?: string) => void };
      }).logger;
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      try {
        await expect(service.onModuleInit()).rejects.toThrow();
        // Capture and assert BEFORE mockRestore (which clears mock.calls).
        const messages = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        const traces = errorSpy.mock.calls.map((c) => (c[1] ? String(c[1]) : "")).join("\n");
        expect(messages).not.toContain("s3cret-app");
        expect(messages).not.toContain("postgres://app");
        expect(messages).toContain("[DATABASE_URL]");
        expect(traces).not.toContain("s3cret-app");
      } finally {
        errorSpy.mockRestore();
        if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = prevDbUrl;
        if (prevAdminUrl === undefined) delete process.env.DATABASE_ADMIN_URL;
        else process.env.DATABASE_ADMIN_URL = prevAdminUrl;
      }
    });
  });
});
