import { PrismaClient } from "@prisma/client";
import { normalizeEnvironmentValue } from "@besterp/shared";

// Normalize NODE_ENV early (case-insensitive, trimmed) so "Production" or
// "PRODUCTION" or " Production " cannot bypass the production-seed guard
// below. The seed runs as a separate process that does NOT go through
// main.ts's normalizeEnvironment(), so without this a mis-cased or
// whitespace-padded NODE_ENV in a production shell would slip past the
// `=== "production"` check and seed hard-coded test tenants (tenant-acme,
// tenant-globex) into a real database. Mirrors main.ts's normalizeEnvironment().
if (process.env.NODE_ENV) {
  process.env.NODE_ENV = normalizeEnvironmentValue(process.env.NODE_ENV);
}

// Seed uses admin connection to bypass RLS for creating tenant records
if (!process.env.DATABASE_ADMIN_URL) {
  console.error(
    "[SEED] DATABASE_ADMIN_URL not set. Seed requires admin (superuser) connection to bypass RLS.\n" +
    "Set DATABASE_ADMIN_URL to a superuser connection string."
  );
  process.exit(1);
}
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_ADMIN_URL,
});

async function main() {
  // Refuse to run in production or staging. Seed is for local/dev only and
  // inserts hard-coded test tenants (tenant-acme, tenant-globex) that must
  // never appear in a real environment.
  //
  // The NODE_ENV check alone is bypassable: an operator pointing
  // DATABASE_ADMIN_URL at a production database while leaving NODE_ENV unset
  // or set to "development" (a common container-env reuse mistake) would
  // silently seed test tenants into prod. So seeding additionally requires an
  // explicit opt-in via ALLOW_SEED=1 — there is no safe default that permits
  // the destructive insert without a deliberate signal.
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
    throw new Error(
      "Refusing to seed in NODE_ENV=" + process.env.NODE_ENV + ". " +
      "Set NODE_ENV to something other than 'production' or 'staging' to run the seed."
    );
  }
  if (!process.env.ALLOW_SEED || process.env.ALLOW_SEED !== "1") {
    throw new Error(
      "Refusing to seed: ALLOW_SEED is not set to '1'. " +
      "Seeding inserts hard-coded test tenants and must be explicitly enabled. " +
      "Run with ALLOW_SEED=1 to seed local/dev databases only."
    );
  }

  console.log("[SEED] Seeding type tables with AI-facing descriptions...\n");

  // ─── Party Types ─────────────────────────────────────────────
  const partyTypes = await Promise.all([
    prisma.partyType.upsert({
      where: { partyTypeId: "pt-person" },
      update: {},
      create: {
        partyTypeId: "pt-person",
        name: "PERSON",
        description: "An individual human being. Use this for customers, employees, contacts, and any person.",
        aiPromptHint: "Use this type when creating a party that represents an individual person (e.g., a customer who is a person, an employee, a contact).",
        isSystem: true,
      },
    }),
    prisma.partyType.upsert({
      where: { partyTypeId: "pt-org" },
      update: {},
      create: {
        partyTypeId: "pt-org",
        name: "ORGANIZATION",
        description: "A company, business, or organizational entity. Use this for companies, departments, subsidiaries, and tenants.",
        aiPromptHint: "Use this type when creating a party that represents a company or organization (e.g., a corporate customer, a supplier, an internal department). Each tenant is also an ORGANIZATION.",
        isSystem: true,
      },
    }),
    prisma.partyType.upsert({
      where: { partyTypeId: "pt-tenant" },
      update: {},
      create: {
        partyTypeId: "pt-tenant",
        name: "TENANT",
        description: "An organization that is a tenant on the platform. Each tenant has isolated data.",
        aiPromptHint: "System type. Automatically used when onboarding a new tenant organization.",
        isSystem: true,
      },
    }),
  ]);
  console.log(`  [OK] ${partyTypes.length} party types seeded`);

  // ─── Role Types ──────────────────────────────────────────────
  const roleTypes = await Promise.all([
    prisma.roleType.upsert({
      where: { roleTypeId: "rt-customer" },
      update: {},
      create: {
        roleTypeId: "rt-customer",
        name: "Customer",
        description: "A party that purchases goods or services from the tenant.",
        aiPromptHint: "Assign this role to any party that buys from us. Required before creating a sales order.",
        isSystem: true,
      },
    }),
    prisma.roleType.upsert({
      where: { roleTypeId: "rt-supplier" },
      update: {},
      create: {
        roleTypeId: "rt-supplier",
        name: "Supplier",
        description: "A party that provides goods or services to the tenant.",
        aiPromptHint: "Assign this role to vendors, suppliers, and service providers.",
        isSystem: true,
      },
    }),
    prisma.roleType.upsert({
      where: { roleTypeId: "rt-employee" },
      update: {},
      create: {
        roleTypeId: "rt-employee",
        name: "Employee",
        description: "A person employed by the tenant organization.",
        aiPromptHint: "Assign this role to internal employees. Usually paired with PERSON type.",
        isSystem: true,
      },
    }),
    prisma.roleType.upsert({
      where: { roleTypeId: "rt-bill-to" },
      update: {},
      create: {
        roleTypeId: "rt-bill-to",
        name: "Bill-To",
        description: "The party responsible for paying an invoice.",
        aiPromptHint: "Used in order and invoice contexts to identify who receives the bill.",
        isSystem: true,
      },
    }),
    prisma.roleType.upsert({
      where: { roleTypeId: "rt-ship-to" },
      update: {},
      create: {
        roleTypeId: "rt-ship-to",
        name: "Ship-To",
        description: "The party or location where goods should be delivered.",
        aiPromptHint: "Used in order and fulfillment contexts to specify delivery destination.",
        isSystem: true,
      },
    }),
  ]);
  console.log(`  [OK] ${roleTypes.length} role types seeded`);

  // ─── Contact Mechanism Types ─────────────────────────────────
  const contactTypes = await Promise.all([
    prisma.contactMechanismType.upsert({
      where: { contactMechanismTypeId: "cmt-postal" },
      update: {},
      create: {
        contactMechanismTypeId: "cmt-postal",
        name: "POSTAL_ADDRESS",
        description: "A physical mailing address with street, city, state, and postal code.",
        aiPromptHint: "Use for physical addresses — shipping, billing, or office locations.",
      },
    }),
    prisma.contactMechanismType.upsert({
      where: { contactMechanismTypeId: "cmt-telecom" },
      update: {},
      create: {
        contactMechanismTypeId: "cmt-telecom",
        name: "TELECOM_NUMBER",
        description: "A phone number with country code, area code, and line number.",
        aiPromptHint: "Use for phone numbers — office, mobile, fax.",
      },
    }),
    prisma.contactMechanismType.upsert({
      where: { contactMechanismTypeId: "cmt-email" },
      update: {},
      create: {
        contactMechanismTypeId: "cmt-email",
        name: "EMAIL_ADDRESS",
        description: "An email address for electronic communication.",
        aiPromptHint: "Use for email addresses — primary contact, billing, support.",
      },
    }),
  ]);
  console.log(`  [OK] ${contactTypes.length} contact mechanism types seeded\n`);

  // ─── Seed tenant organizations ───────────────────────────────
  const tenantA = await prisma.party.upsert({
    where: { partyId: "tenant-acme" },
    update: {},
    create: {
      partyId: "tenant-acme",
      partyTypeId: "pt-org",
      tenantId: "tenant-acme",
      name: "Acme Corporation",
      description: "Seed tenant for testing",
      organization: {
        create: {
          legalName: "Acme Corporation Ltd.",
          taxId: "US-123456789",
        },
      },
    },
  });

  const tenantB = await prisma.party.upsert({
    where: { partyId: "tenant-globex" },
    update: {},
    create: {
      partyId: "tenant-globex",
      partyTypeId: "pt-org",
      tenantId: "tenant-globex",
      name: "Globex Industries",
      description: "Seed tenant for testing",
      organization: {
        create: {
          legalName: "Globex Industries Inc.",
          taxId: "US-987654321",
        },
      },
    },
  });

  console.log(`  [OK] 2 seed tenants created: ${tenantA.name}, ${tenantB.name}\n`);
  console.log("[SEED] Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
