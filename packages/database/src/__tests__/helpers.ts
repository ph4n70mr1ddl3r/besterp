// Shared test utilities for database integration tests.
//
// These helpers assume a running PostgreSQL instance with RLS configured.
// Tests use a unique prefix to isolate test data and clean up after themselves.

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { withTenant } from "@besterp/shared";

// ─── Test tenant IDs ────────────────────────────────────────

export const TENANT_A = "test-tenant-a";
export const TENANT_B = "test-tenant-b";

// ─── Prisma clients ─────────────────────────────────────────
// App client (non-superuser, subject to RLS)
// Admin client (superuser, bypasses RLS for setup/teardown)

export function createAppClient(): PrismaClient {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log: ["error"],
  });
}

export function createAdminClient(): PrismaClient {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
    log: ["error"],
  });
}

// ─── Test data factory helpers ──────────────────────────────

let counter = 0;
export function uniqueId(prefix: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `${prefix}-${Date.now()}-${suffix}-${++counter}`;
}

/** Create a person party within a tenant context. */
export async function createTestPerson(
  client: PrismaClient,
  tenantId: string,
  overrides: { firstName?: string; lastName?: string; partyId?: string } = {}
) {
  const partyId = overrides.partyId || uniqueId("test-person");
  return withTenant(client, tenantId, async (tx) => {
    return tx.party.create({
      data: {
        partyId,
        partyTypeId: "pt-person",
        tenantId,
        name: `${overrides.firstName || "Test"} ${overrides.lastName || "Person"}`,
        person: {
          create: {
            firstName: overrides.firstName || "Test",
            lastName: overrides.lastName || "Person",
          },
        },
      },
      include: { person: true, organization: true },
    });
  });
}

/** Create an organization party within a tenant context. */
export async function createTestOrganization(
  client: PrismaClient,
  tenantId: string,
  overrides: { legalName?: string; partyId?: string } = {}
) {
  const partyId = overrides.partyId || uniqueId("test-org");
  return withTenant(client, tenantId, async (tx) => {
    return tx.party.create({
      data: {
        partyId,
        partyTypeId: "pt-org",
        tenantId,
        name: overrides.legalName || "Test Org",
        organization: {
          create: {
            legalName: overrides.legalName || "Test Organization LLC",
          },
        },
      },
      include: { person: true, organization: true },
    });
  });
}

// ─── Cleanup helper ─────────────────────────────────────────

/** Delete all test data matching a prefix pattern. Uses admin client to bypass RLS. */
export async function cleanupTestData(admin: PrismaClient, prefix: string) {
  await admin.partyContactMechanism.deleteMany({
    where: { partyId: { startsWith: prefix } },
  });
  await admin.postalAddress.deleteMany({
    where: { contactMechanismId: { startsWith: prefix } },
  });
  await admin.telecomNumber.deleteMany({
    where: { contactMechanismId: { startsWith: prefix } },
  });
  await admin.emailAddress.deleteMany({
    where: { contactMechanismId: { startsWith: prefix } },
  });
  await admin.contactMechanism.deleteMany({
    where: { contactMechanismId: { startsWith: prefix } },
  });
  await admin.idempotencyRecord.deleteMany({
    where: { idempotencyKey: { startsWith: prefix } },
  });
  await admin.person.deleteMany({
    where: { partyId: { startsWith: prefix } },
  });
  await admin.organization.deleteMany({
    where: { partyId: { startsWith: prefix } },
  });
  await admin.partyRole.deleteMany({
    where: { partyId: { startsWith: prefix } },
  });
  await admin.party.deleteMany({
    where: { partyId: { startsWith: prefix } },
  });
}
