-- Add tenant_id column to email_address for unique constraint enforcement.
--
-- Without this column, duplicate emails across different parties in the same
-- tenant could slip through the service-layer check under concurrent access.
-- The tenant_id on email_address is redundant with contact_mechanism.tenant_id
-- (they share the same row via contact_mechanism_id), but it allows a direct
-- @@unique([tenantId, email]) composite index without a JOIN, giving the DB
-- a single-table enforcement net that the service layer cannot race against.

ALTER TABLE "email_address" ADD COLUMN "tenant_id" TEXT;

UPDATE "email_address" ea
SET "tenant_id" = cm."tenant_id"
FROM "contact_mechanism" cm
WHERE ea."contact_mechanism_id" = cm."contact_mechanism_id";

ALTER TABLE "email_address" ALTER COLUMN "tenant_id" SET NOT NULL;

CREATE UNIQUE INDEX email_address_tenant_email_unique_idx ON "email_address" ("tenant_id", "email");
