# ADR-003: Class Table Inheritance for Supertype/Subtype

**Status:** Accepted  
**Date:** 2026-05-10  
**Deciders:** Architecture team  
**Related:** ERP_PLAN.md Section 4, AGENTIC_AI_DESIGN.md Section 2.2

---

## Context

Silverstone's universal data models use supertype/subtype extensively:

- **PARTY** → PERSON / ORGANIZATION
- **PRODUCT** → GOOD / SERVICE
- **ORDER** → (discriminated by ORDER_TYPE)
- **INVOICE** → (discriminated by INVOICE_TYPE)
- **CONTACT_MECHANISM** → POSTAL_ADDRESS / TELECOM_NUMBER / EMAIL_ADDRESS / WEB_ADDRESS

We need to decide how to implement this in PostgreSQL with Prisma.

## Decision

We use **Class Table Inheritance (CTI)** — one table per supertype and one table per subtype, joined by primary key.

### Pattern:

```sql
-- Supertype table
CREATE TABLE party (
  party_id UUID PRIMARY KEY,
  party_type_id UUID NOT NULL REFERENCES party_type,
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subtype tables (PK is also FK to supertype)
CREATE TABLE person (
  party_id UUID PRIMARY KEY REFERENCES party(party_id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  middle_name TEXT,
  birth_date DATE,
  gender TEXT
);

CREATE TABLE organization (
  party_id UUID PRIMARY KEY REFERENCES party(party_id),
  legal_name TEXT NOT NULL,
  tax_id TEXT,
  registration_date DATE
);
```

### Prisma representation:

```prisma
model Party {
  partyId       String         @id @default(uuid()) @map("party_id")
  partyTypeId   String         @map("party_type_id")
  partyType     PartyType      @relation(fields: [partyTypeId], references: [partyTypeId])
  tenantId      String         @map("tenant_id")
  name          String
  description   String?
  person        Person?
  organization  Organization?
  roles         PartyRole[]
  contacts      PartyContactMechanism[]
  createdAt     DateTime       @default(now()) @map("created_at")
  updatedAt     DateTime       @updatedAt @map("updated_at")

  @@map("party")
}

model Person {
  partyId    String   @id @map("party_id")
  party      Party    @relation(fields: [partyId], references: [partyId], onDelete: Cascade)
  firstName  String   @map("first_name")
  lastName   String   @map("last_name")
  middleName String?  @map("middle_name")
  birthDate  DateTime? @map("birth_date")
  gender     String?

  @@map("person")
}

model Organization {
  partyId          String   @id @map("party_id")
  party            Party    @relation(fields: [partyId], references: [partyId], onDelete: Cascade)
  legalName        String   @map("legal_name")
  taxId            String?  @map("tax_id")
  registrationDate DateTime? @map("registration_date")

  @@map("organization")
}
```

### Access pattern:

```typescript
// To get a party with its subtype data:
const party = await prisma.party.findUnique({
  where: { partyId: id },
  include: { person: true, organization: true, partyType: true }
});

// party.person is populated if PERSON, null otherwise
// party.organization is populated if ORGANIZATION, null otherwise
```

## Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **Single Table Inheritance (STI)** | One table, simple joins, no FK gymnastics | Sparse columns (all subtype fields nullable), no NOT NULL constraints on subtype fields, table gets very wide | ❌ Doesn't match Silverstone's normalized model |
| **Class Table Inheritance (CTI)** | Clean normalization, subtype-specific NOT NULL constraints, maps directly to Silverstone | Requires JOINs for subtype data, more tables to manage | ✅ Best alignment with the data model |
| **Concrete Table Inheritance** | No JOINs needed, each subtype is self-contained | Supertype queries require UNION across all subtype tables, duplicated columns, hard to add shared fields | ❌ Makes supertype queries painful |
| **JSONB subtype columns** | Flexible, easy to extend | No schema enforcement, can't query subtype fields efficiently, loses type safety | ❌ Too unstructured for ERP |

## Consequences

### Positive
- Direct mapping from Silverstone's data model to our schema
- Subtype-specific columns can have NOT NULL constraints (first_name is required for PERSON)
- Adding new subtypes means adding new tables — no altering existing tables
- Prisma's 1:1 relation handles the JOIN cleanly
- AI agents can query `describe_entity_type({ type: "person" })` and get subtype-specific schema

### Negative
- Every fetch of subtype data requires a JOIN (performance consideration for list queries)
- More migration files (each subtype is a separate table)
- Prisma doesn't natively support "polymorphic includes" — you must explicitly include all possible subtypes
- Delete operations must cascade from supertype to subtype

### Mitigations
- For list queries that only need supertype columns (name, type, status), query the supertype table only
- For detail views, use Prisma's `include` to eagerly fetch the relevant subtype
- Add database-level CASCADE DELETE on subtype FKs to prevent orphaned records
- Create a helper utility `getPartyWithType(id)` that auto-includes the correct subtype based on `party_type_id`

## References

- Len Silverstone, "The Data Model Resource Book" (Revised Edition) — Chapter 1
- Martin Fowler, "Patterns of Enterprise Application Architecture" — Class Table Inheritance
- ERP_PLAN.md — Section 4.1 (Party Model), 4.2 (Product Model)
