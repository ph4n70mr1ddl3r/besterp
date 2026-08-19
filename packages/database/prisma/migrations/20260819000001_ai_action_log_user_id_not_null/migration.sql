-- Close the ai_action_log.user_id nullable drift.
--
-- Same drift class as 20260718000000_ai_action_log_tenant_id_not_null: the
-- init migration (20260510081953_init) declared "ai_action_log"."user_id" as
-- TEXT (nullable), while schema.prisma mandates it NOT NULL. The 20260718
-- migration closed only tenant_id and left user_id nullable, so a freshly
-- `migrate deploy`-ed database can accept NULL user_id audit rows the schema
-- promises cannot exist — breaking audit attribution for any consumer that
-- trusts user_id is always present.
--
-- The audit-log middleware always supplies userId (required identity field
-- at the registry boundary), so no NULL rows are expected.

-- Safety backfill: any pre-existing NULL user_id (should be none) is assigned
-- the empty string so the NOT NULL constraint can be applied.
UPDATE "ai_action_log" SET "user_id" = '' WHERE "user_id" IS NULL;

ALTER TABLE "ai_action_log" ALTER COLUMN "user_id" SET NOT NULL;
