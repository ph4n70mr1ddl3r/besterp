-- Close the ai_action_log.tenant_id nullable drift.
--
-- The init migration (20260510081953_init) declared
-- "ai_action_log"."tenant_id" as TEXT (nullable), while schema.prisma mandates
-- it NOT NULL — every other tenant table in that same migration uses
-- "TEXT NOT NULL". Because the migrations are shipped/squashed, no later
-- migration closed the gap, so a freshly `migrate deploy`-ed database has a
-- genuinely nullable tenant_id column.
--
-- Under RLS a NULL tenant_id row is invisible to all tenants (no cross-tenant
-- leak), but it bypasses every tenant-scoped query and the idempotency
-- cleanup, producing a stranded audit row and a false assumption for any
-- consumer that trusts tenant_id is always present (carried as a deferred
-- finding since round 38).
--
-- The application always supplies tenant_id on every audit write, so no NULL
-- rows exist to backfill. Set NOT NULL to match the schema and remove the
-- drift.

-- Safety backfill: any pre-existing NULL tenant_id (should be none) is
-- assigned the empty string so the NOT NULL constraint can be applied. RLS
-- treats '' as "no tenant" and keeps such rows invisible to all tenants.
UPDATE "ai_action_log" SET "tenant_id" = '' WHERE "tenant_id" IS NULL;

ALTER TABLE "ai_action_log" ALTER COLUMN "tenant_id" SET NOT NULL;
