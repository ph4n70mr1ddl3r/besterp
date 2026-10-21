-- Restore Row-Level Security on `agent_registry`.
--
-- Migration 20261007000000 changed the `agent_registry` primary key from
-- (agent_id) to (agent_id, tenant_id) by RECREATING the table:
--
--   CREATE TABLE "agent_registry_new" ...;
--   INSERT INTO "agent_registry_new" SELECT ... FROM "agent_registry";
--   DROP TABLE "agent_registry";
--   ALTER TABLE "agent_registry_new" RENAME TO "agent_registry";
--
-- Dropping a table in PostgreSQL also drops its policies AND its
-- ENABLE/FORCE ROW LEVEL SECURITY flags. In any environment where
-- rls-setup.sql had already been applied (the documented order is
-- `npm run db:migrate` → apply rls-setup.sql, but a deploy that runs
-- migrations AFTER the RLS script — or any environment where the RLS script
-- was applied early — ends up with `agent_registry` carrying NO row-level
-- security at all, silently exposing every tenant's agent configuration
-- (capabilities, rate limits, transaction limits) to every other tenant
-- that shares the application role.
--
-- `PrismaService.verifyRlsEnabled()` refuses to boot when RLS is missing, so
-- the failure mode was "the API is down after a routine deploy until an
-- operator remembers to re-apply rls-setup.sql" — with README only telling
-- operators to re-apply it after changes that ADD a tenant-scoped table.
--
-- This migration restores the flags and the policy so the table is protected
-- regardless of the order in which migrations and rls-setup.sql are applied.
-- It is idempotent: the ENABLE/FORCE statements are no-ops when the flags are
-- already set, and the policy is dropped and recreated.
--
-- NOTE: the historical `DROP TABLE` in 20261007000000 also DESTROYED any
-- agent rows that existed at that point (the data was copied into the new
-- table first, so only rows inserted between the two migrations were lost).
-- That migration is left untouched on purpose: Prisma records a checksum for
-- every applied migration and `migrate deploy` FAILS if an applied migration
-- file is modified, so rewriting it would break every existing deployment.
-- Future schema changes must use ALTER TABLE ... DROP CONSTRAINT / ADD
-- CONSTRAINT, which preserves both the data and the RLS configuration.

BEGIN;

ALTER TABLE "agent_registry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_registry" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_agent_registry ON "agent_registry";
CREATE POLICY tenant_isolation_agent_registry ON "agent_registry"
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

COMMIT;
