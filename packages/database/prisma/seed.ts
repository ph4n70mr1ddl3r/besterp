import { PrismaClient } from "@prisma/client";
import { normalizeEnvironmentValue, sanitizeForLogOutput } from "@besterp/shared";
import { assertSeedAllowed } from "../src/seed-guard.js";

// Normalize NODE_ENV into a local variable (case-insensitive, trimmed) so
// "Production" or "PRODUCTION" or " Production " cannot bypass the
// production-seed guard below. The seed runs as a separate process that does
// NOT go through main.ts's normalizeEnvironment(), so without this a
// mis-cased or whitespace-padded NODE_ENV in a production shell would slip
// past the `=== "production"` check and seed hard-coded test tenants
// (tenant-acme, tenant-globex) into a real database. Mirrors main.ts's
// normalizeEnvironment(). We use a local variable instead of mutating
// process.env to avoid side-effects if the script is ever imported.
const normalizedNodeEnv = normalizeEnvironmentValue(process.env.NODE_ENV);

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

async function seedPartyTypes(prisma: PrismaClient): Promise<number> {
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
  return partyTypes.length;
}

async function seedRoleTypes(prisma: PrismaClient): Promise<number> {
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
  return roleTypes.length;
}

async function seedContactTypes(prisma: PrismaClient): Promise<number> {
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
  return contactTypes.length;
}

async function seedTenants(prisma: PrismaClient): Promise<[string, string]> {
  // Seed tenants use the TENANT party type (pt-tenant) — the type this seed
  // defines specifically for "an organization that is a tenant on the
  // platform". Seeding them as plain pt-org left pt-tenant defined-but-unused,
  // so tenant detection by type returned nothing in a seeded database.
  // Upserts use update: {} so already-seeded databases keep their existing
  // type; only fresh seeds get pt-tenant.
  const tenantA = await prisma.party.upsert({
    where: { partyId: "tenant-acme" },
    update: {},
    create: {
      partyId: "tenant-acme",
      partyTypeId: "pt-tenant",
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
      partyTypeId: "pt-tenant",
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
  return [tenantA.name, tenantB.name];
}

async function seedEntityDescriptors(prisma: PrismaClient): Promise<number> {
  const descriptors = await Promise.all([
    prisma.entityDescriptor.upsert({
      where: { entityName: "party" },
      update: {},
      create: {
        entityName: "party",
        description: "A person or organization that interacts with the tenant. Every customer, supplier, employee, and tenant itself is a Party.",
        aiPromptHint: "Use this entity when creating or querying any person or organization in the system. Always assign roles (Customer, Supplier, etc.) after creation.",
        keyFields: { partyId: "UUID", tenantId: "tenant-slug", name: "display-name" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "person" },
      update: {},
      create: {
        entityName: "person",
        description: "Subtype of PARTY representing an individual human being. Links to Party via partyId (1:1).",
        aiPromptHint: "Only used as a PARTY subtype. Create a PARTY with partyType=PERSON first, then fill in firstName, lastName, and optional middleName/birthDate/gender.",
        keyFields: { partyId: "UUID (FK to party)" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "organization" },
      update: {},
      create: {
        entityName: "organization",
        description: "Subtype of PARTY representing a company or business entity. Links to Party via partyId (1:1).",
        aiPromptHint: "Only used as a PARTY subtype. Create a PARTY with partyType=ORGANIZATION first, then fill in legalName and optional taxId/registrationDate.",
        keyFields: { partyId: "UUID (FK to party)" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "party_role" },
      update: {},
      create: {
        entityName: "party_role",
        description: "Associates a role (Customer, Supplier, Employee, etc.) with a party for a time period. Supports effective dating via fromDate/thruDate.",
        aiPromptHint: "Use add_party_role to assign roles. A party can have multiple active roles. Use get_type_table_values with ROLE_TYPE to see available roles.",
        keyFields: { partyRoleId: "UUID", partyId: "UUID", roleTypeId: "role-slug" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "contact_mechanism" },
      update: {},
      create: {
        entityName: "contact_mechanism",
        description: "A contact point (address, phone, email) associated with a party. Each mechanism has exactly one subtype.",
        aiPromptHint: "Use add_contact_mechanism to create. Choose POSTAL_ADDRESS, TELECOM_NUMBER, or EMAIL_ADDRESS — only one subtype per mechanism.",
        keyFields: { contactMechanismId: "UUID", tenantId: "tenant-slug" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "postal_address" },
      update: {},
      create: {
        entityName: "postal_address",
        description: "Subtype of contact_mechanism representing a physical mailing address.",
        aiPromptHint: "Requires postalAddress object with addressLine1, city, and country (ISO 3166-1 code). Optional: addressLine2, stateProvince, postalCode.",
        keyFields: { contactMechanismId: "UUID (FK to contact_mechanism)" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "telecom_number" },
      update: {},
      create: {
        entityName: "telecom_number",
        description: "Subtype of contact_mechanism representing a phone number.",
        aiPromptHint: "Requires telecomNumber with areaCode and lineNumber. Optional: countryCode (defaults to +1), extension.",
        keyFields: { contactMechanismId: "UUID (FK to contact_mechanism)" },
      },
    }),
    prisma.entityDescriptor.upsert({
      where: { entityName: "email_address" },
      update: {},
      create: {
        entityName: "email_address",
        description: "Subtype of contact_mechanism representing an email address. Tenant-scoped unique.",
        aiPromptHint: "Requires emailAddress with email field. Must be unique within the tenant.",
        keyFields: { contactMechanismId: "UUID (FK to contact_mechanism)" },
      },
    }),
  ]);
  console.log(`  [OK] ${descriptors.length} entity descriptors seeded\n`);
  return descriptors.length;
}

async function seedConfirmationGates(prisma: PrismaClient): Promise<number> {
  const gates = await Promise.all([
    prisma.confirmationGate.upsert({
      where: { toolName: "create_party" },
      update: {},
      create: {
        toolName: "create_party",
        enabled: true,
        description: "Creating a new party (person or organization) in the ERP system.",
        reason: "Irreversible write that creates a new business entity visible to all agents in the tenant.",
      },
    }),
    prisma.confirmationGate.upsert({
      where: { toolName: "add_party_role" },
      update: {},
      create: {
        toolName: "add_party_role",
        enabled: true,
        description: "Assigning a role (Customer, Supplier, Employee, etc.) to a party.",
        reason: "Changes the party's permissions and business relationships within the tenant.",
      },
    }),
    prisma.confirmationGate.upsert({
      where: { toolName: "add_contact_mechanism" },
      update: {},
      create: {
        toolName: "add_contact_mechanism",
        enabled: true,
        description: "Adding a contact mechanism (address, phone, or email) to a party.",
        reason: "Modifies party contact information that may be used for communications and billing.",
      },
    }),
  ]);
  console.log(`  [OK] ${gates.length} confirmation gates seeded`);
  return gates.length;
}

async function main() {
  // Refuse to seed into any non-local environment without an explicit opt-in.
  // The allowlist + ALLOW_SEED logic lives in assertSeedAllowed (see there for
  // the rationale and the history of bypasses); keeping it in a separate module
  // lets it be unit-tested (this script self-executes and cannot be imported).
  // Note: NODE_ENV was already normalized to lowercase above, but the guard
  // normalizes again defensively so it is safe when called with a raw value.
  assertSeedAllowed(normalizedNodeEnv, process.env.ALLOW_SEED);

  console.log("[SEED] Seeding type tables with AI-facing descriptions...\n");

  await seedPartyTypes(prisma);
  await seedRoleTypes(prisma);
  await seedContactTypes(prisma);
  await seedTenants(prisma);
  await seedEntityDescriptors(prisma);
  await seedConfirmationGates(prisma);

  console.log("[SEED] Seeding complete!");
}

main()
  .catch((e) => {
    // Sanitize like the sibling cleanup script does: a Prisma/driver
    // connection error's message embeds the datasource URL verbatim
    // (DATABASE_ADMIN_URL — credentials + host), and the seed connects via
    // that URL. `console.error(e.message)` would print the password to the
    // terminal / container stdout capture, exactly the leak the rest of the
    // codebase scrubs at every durable sink. The assertSeedAllowed guard
    // throws a clean message, but Prisma errors reach this path too.
    console.error(sanitizeForLogOutput(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", sanitizeForLogOutput(String(reason ?? "")));
  process.exitCode = 1;
});
