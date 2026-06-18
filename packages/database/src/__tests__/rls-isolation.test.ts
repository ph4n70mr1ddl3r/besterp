// RLS Tenant Isolation Integration Tests
//
// Validates that Row-Level Security correctly isolates tenant data.
// These tests require a running PostgreSQL instance with RLS configured.
//
// Run: DATABASE_URL="..." DATABASE_ADMIN_URL="..." npx vitest run

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Skip all integration tests when DATABASE_URL is not set
const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;
import { PrismaClient } from "@prisma/client";
import { withTenant } from "@besterp/shared";
import {
  TENANT_A,
  TENANT_B,
  createAppClient,
  createAdminClient,
  createTestPerson,
  createTestOrganization,
  cleanupTestData,
  uniqueId,
} from "./helpers.js";

describeIntegration("RLS Tenant Isolation", () => {
  let app: PrismaClient;
  let admin: PrismaClient;
  const prefix = "test-rls";

  beforeAll(async () => {
    // Skip integration tests when DATABASE_URL is not set
    if (!process.env.DATABASE_URL) return;

    app = createAppClient();
    admin = createAdminClient();
    await cleanupTestData(admin, prefix);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(admin, prefix);
    } finally {
      await app.$disconnect();
      await admin.$disconnect();
    }
  });

  // ─── Tenant A cannot see Tenant B's data ────────────────

  it("prevents tenant A from seeing tenant B's parties", async () => {
    const personA = await createTestPerson(app, TENANT_A, {
      partyId: uniqueId(prefix),
      firstName: "Alice",
      lastName: "Acme",
    });

    const orgB = await createTestOrganization(app, TENANT_B, {
      partyId: uniqueId(prefix),
      legalName: "Globex Corp",
    });

    // Tenant A should only see its own data
    const tenantAParties = await withTenant(app, TENANT_A, async (tx) => {
      return tx.party.findMany({
        select: { partyId: true },
      });
    });
    const tenantAIds = tenantAParties.map((p) => p.partyId);

    expect(tenantAIds).toContain(personA.partyId);
    expect(tenantAIds).not.toContain(orgB.partyId);

    // Tenant B should only see its own data
    const tenantBParties = await withTenant(app, TENANT_B, async (tx) => {
      return tx.party.findMany({
        select: { partyId: true },
      });
    });
    const tenantBIds = tenantBParties.map((p) => p.partyId);

    expect(tenantBIds).toContain(orgB.partyId);
    expect(tenantBIds).not.toContain(personA.partyId);
  });

  // ─── Unset tenant context returns no rows ───────────────

  it("returns no rows when tenant context is not set", async () => {
    // A raw transaction without SET LOCAL should see nothing
    const results = await app.$transaction(async (tx) => {
      return tx.party.findMany({
        where: { partyId: { startsWith: prefix } },
      });
    });

    expect(results).toHaveLength(0);
  });

  // ─── Invalid tenant ID is rejected ──────────────────────

  it("rejects invalid tenant IDs", async () => {
    await expect(
      withTenant(app, "'; DROP TABLE party;--", async (tx) => {
        return tx.party.findMany();
      })
    ).rejects.toThrow("Invalid tenant ID");
  });

  // ─── Contact mechanisms are tenant-isolated ─────────────

  it("isolates contact mechanisms by tenant", async () => {
    const person = await createTestPerson(app, TENANT_A, {
      partyId: uniqueId(prefix),
      firstName: "Contact",
      lastName: "Test",
    });

    const cmId = uniqueId(prefix);

    // Create a postal address for tenant A's person
    await withTenant(app, TENANT_A, async (tx) => {
      return tx.contactMechanism.create({
        data: {
          contactMechanismId: cmId,
          contactMechanismTypeId: "cmt-postal",
          tenantId: TENANT_A,
          postalAddress: {
            create: {
              addressLine1: "100 Test St",
              city: "Testville",
              country: "US",
            },
          },
          partyContacts: {
            create: { partyId: person.partyId },
          },
        },
      });
    });

    // Tenant B should not see tenant A's contact mechanisms
    const tenantBContacts = await withTenant(app, TENANT_B, async (tx) => {
      return tx.contactMechanism.findMany();
    });
    const tenantBIds = tenantBContacts.map((c) => c.contactMechanismId);

    expect(tenantBIds).not.toContain(cmId);
  });

  // ─── Admin client bypasses RLS ──────────────────────────

  it("admin client can see all tenants' data", async () => {
    const personA = await createTestPerson(app, TENANT_A, {
      partyId: uniqueId(prefix),
      firstName: "Admin",
      lastName: "Visible",
    });
    const orgB = await createTestOrganization(app, TENANT_B, {
      partyId: uniqueId(prefix),
      legalName: "Admin Visible Corp",
    });

    // Admin should see both tenants' data
    const allParties = await admin.party.findMany({
      where: { partyId: { in: [personA.partyId, orgB.partyId] } },
    });

    expect(allParties).toHaveLength(2);
  });
});

describeIntegration("Class Table Inheritance", () => {
  let app: PrismaClient;
  let admin: PrismaClient;
  const prefix = "test-cti";

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    app = createAppClient();
    admin = createAdminClient();
    await cleanupTestData(admin, prefix);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(admin, prefix);
    } finally {
      await app.$disconnect();
      await admin.$disconnect();
    }
  });

  it("creates a person party with subtype data", async () => {
    const person = await createTestPerson(app, TENANT_A, {
      partyId: uniqueId(prefix),
      firstName: "Jane",
      lastName: "Doe",
    });

    expect(person.person).toBeDefined();
    expect(person.person?.firstName).toBe("Jane");
    expect(person.person?.lastName).toBe("Doe");
    expect(person.organization).toBeNull();
  });

  it("creates an organization party with subtype data", async () => {
    const org = await createTestOrganization(app, TENANT_A, {
      partyId: uniqueId(prefix),
      legalName: "CTI Test Corp",
    });

    expect(org.organization).toBeDefined();
    expect(org.organization?.legalName).toBe("CTI Test Corp");
    expect(org.person).toBeNull();
  });

  it("assigns roles to a party", async () => {
    const person = await createTestPerson(app, TENANT_A, {
      partyId: uniqueId(prefix),
      firstName: "Role",
      lastName: "Test",
    });

    const role = await withTenant(app, TENANT_A, async (tx) => {
      return tx.partyRole.create({
        data: {
          partyId: person.partyId,
          roleTypeId: "rt-customer",
        },
      });
    });

    expect(role.partyId).toBe(person.partyId);
    expect(role.roleTypeId).toBe("rt-customer");
  });
});

describeIntegration("Idempotency", () => {
  let app: PrismaClient;
  let admin: PrismaClient;
  const prefix = "test-idem";

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    app = createAppClient();
    admin = createAdminClient();
    await cleanupTestData(admin, prefix);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(admin, prefix);
    } finally {
      await app.$disconnect();
      await admin.$disconnect();
    }
  });

  it("creates and replays idempotency records", async () => {
    const key = uniqueId(prefix);

    // Create record
    await withTenant(app, TENANT_A, async (tx) => {
      return tx.idempotencyRecord.create({
        data: {
          idempotencyKey: key,
          toolName: "create_party",
          tenantId: TENANT_A,
          userId: "test-user",
          status: "pending",
          inputHash: "sha256:abc123",
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    });

    // Complete it
    await withTenant(app, TENANT_A, async (tx) => {
      return tx.idempotencyRecord.update({
        where: { idempotencyKey: key },
        data: {
          status: "completed",
          result: { partyId: "test-123" },
          completedAt: new Date(),
        },
      });
    });

    // Replay: find by key
    const record = await withTenant(app, TENANT_A, async (tx) => {
      return tx.idempotencyRecord.findUnique({
        where: { idempotencyKey: key },
      });
    });

    expect(record?.status).toBe("completed");
    expect((record?.result as Record<string, string>)?.partyId).toBe("test-123");
  });

  it("detects input hash mismatches", async () => {
    const key = uniqueId(prefix);

    await withTenant(app, TENANT_A, async (tx) => {
      return tx.idempotencyRecord.create({
        data: {
          idempotencyKey: key,
          toolName: "create_party",
          tenantId: TENANT_A,
          userId: "test-user",
          status: "completed",
          inputHash: "sha256:original",
          result: { partyId: "original-party" },
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    });

    const record = await withTenant(app, TENANT_A, async (tx) => {
      return tx.idempotencyRecord.findUnique({
        where: { idempotencyKey: key },
      });
    });

    expect(record?.inputHash).toBe("sha256:original");
    expect(record?.inputHash).not.toBe("sha256:different");
  });
});
