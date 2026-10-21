-- Change agent_registry primary key from single agent_id to composite (agent_id, tenant_id).
--
-- Rationale: agent_registry is per-tenant; each tenant must be able to register
-- its own agent with the same agentId. The single-column PK prevented the seed
-- from creating a default-agent for tenant-globex (it found and no-op'd the
-- tenant-acme row instead) and would reject runtime registerAgent calls that
-- reuse an agentId across tenants.
--
-- IMPLEMENTATION NOTE (this migration previously failed on EVERY fresh
-- database):
-- The original implementation recreated the table
-- (CREATE TABLE agent_registry_new → INSERT → DROP TABLE agent_registry →
-- RENAME). That approach was broken twice over:
--
--   1. The recreated table declared `CONSTRAINT "agent_registry_pkey"`, but
--      that constraint name was ALREADY TAKEN by the primary key of the
--      original `agent_registry` table created in migration 20260901000001.
--      PostgreSQL requires unique-constraint/index names to be unique within
--      a schema, so the CREATE TABLE failed with
--      "relation \"agent_registry_pkey\" already exists" and the whole
--      transaction rolled back. `prisma migrate deploy` therefore ABORTED
--      here on every fresh database — the migration chain could never
--      complete.
--   2. Even where it did run, `DROP TABLE` silently destroys the table's
--      Row-Level Security configuration: dropping a table removes its
--      policies AND its ENABLE/FORCE ROW LEVEL SECURITY flags. Any
--      environment that had already applied rls-setup.sql was left with
--      `agent_registry` completely unprotected (it holds every tenant's
--      agent capabilities and financial limits) — while
--      PrismaService.verifyRlsEnabled() refused to boot, so the API was down
--      after a routine deploy.
--
-- PostgreSQL DOES support swapping a primary key in place, and an in-place
-- ALTER preserves both the rows and the RLS configuration:
--
--   ALTER TABLE ... DROP CONSTRAINT ... PRIMARY KEY   -- drops the old index
--   ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY     -- adds the new one
--
-- The composite primary key is weaker than the single-column one (it permits
-- the same agent_id in different tenants), so no existing row can violate it.

BEGIN;

ALTER TABLE "agent_registry" DROP CONSTRAINT "agent_registry_pkey";
ALTER TABLE "agent_registry" ADD CONSTRAINT "agent_registry_pkey" PRIMARY KEY ("agent_id", "tenant_id");

CREATE INDEX IF NOT EXISTS "agent_registry_tenant_id_idx" ON "agent_registry"("tenant_id");

COMMIT;
