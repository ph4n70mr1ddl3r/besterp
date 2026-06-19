import { PrismaClient } from "@prisma/client";

// Seed uses admin connection to bypass RLS for creating tenant records
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
});

async function main() {
  // Refuse to run in production. Seed is for local/dev/staging only.
  // The seed is mostly idempotent (uses upsert), but it also inserts
  // hard-coded tenant records (tenant-acme, tenant-globex) that should
  // never appear in a real production environment. An accidental
  // `npm run seed` against prod would silently pollute the database.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "❌ Refusing to seed in NODE_ENV=production. " +
      "Set NODE_ENV to something other than 'production' to run the seed."
    );
    process.exit(1);
  }
  if (!process.env.NODE_ENV) {
    console.error(
      "❌ NODE_ENV is not set. Refusing to seed to prevent accidental data loss. " +
      "Set NODE_ENV=development explicitly."
    );
    process.exit(1);
  }

  console.log("🌱 Seeding type tables with AI-facing descriptions...\n");

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
  console.log(`  ✅ ${partyTypes.length} party types seeded`);

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
  console.log(`  ✅ ${roleTypes.length} role types seeded`);

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
  console.log(`  ✅ ${contactTypes.length} contact mechanism types seeded\n`);

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

  console.log(`  ✅ 2 seed tenants created: ${tenantA.name}, ${tenantB.name}\n`);
  console.log("🌱 Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
