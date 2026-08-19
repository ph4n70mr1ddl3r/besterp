-- Add tenant_id column to telecom_number for unique constraint enforcement.
--
-- Mirrors 20260724000000_add_email_unique_constraint: without a DB-level
-- constraint, the service-layer checkTelecomDuplicate is a find-then-insert
-- TOCTOU race — two concurrent add_contact_mechanism calls with the same
-- {country_code, area_code, line_number} can both pass findFirst and both
-- insert, storing duplicate phone numbers. Email already has this
-- single-table enforcement net (@@unique([tenantId, email])); telecom now
-- gets the same, closing the last un-backstopped sibling path in the same
-- transaction.
--
-- The tenant_id is redundant with contact_mechanism.tenant_id (they share
-- the same row via contact_mechanism_id) but allows a direct composite
-- unique index without a JOIN.

ALTER TABLE "telecom_number" ADD COLUMN "tenant_id" TEXT;

UPDATE "telecom_number" tn
SET "tenant_id" = cm."tenant_id"
FROM "contact_mechanism" cm
WHERE tn."contact_mechanism_id" = cm."contact_mechanism_id";

ALTER TABLE "telecom_number" ALTER COLUMN "tenant_id" SET NOT NULL;

-- Name follows Prisma's convention for @@unique([tenantId, countryCode,
-- areaCode, lineNumber]) so migrate dev does not see further drift.
CREATE UNIQUE INDEX IF NOT EXISTS "telecom_number_tenant_id_country_code_area_code_line_number_key"
  ON "telecom_number" ("tenant_id", "country_code", "area_code", "line_number");
