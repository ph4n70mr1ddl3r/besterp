-- Restore Row-Level Security on the tenant-scoped tables that no migration
-- ever protected.
--
-- The RLS configuration lives in the standalone `rls-setup.sql` script, which
-- `prisma migrate deploy` does NOT execute. The documented order is
--   npm run db:migrate → apply rls-setup.sql
-- but a deploy that runs the migrations AFTER the RLS script — or any
-- environment where the RLS script was applied early — ends up with every
-- table CREATED BY A MIGRATION carrying NO row-level security at all.
--
-- Migration 20261021000002 already fixed this for `agent_registry`. The
-- tables introduced by the same wave of migrations were left unprotected:
--
--   user             (20260901000001) — stores password_hash, the most
--                                  sensitive table in the schema
--   product          (20260901000002)
--   product_category (20260901000002)
--   product_feature  (20260901000002)
--   product_price    (20260901000002)
--
-- `PrismaService.verifyRlsEnabled()` refuses to boot when RLS is missing, so
-- the failure mode was "the API is down after a routine deploy until an
-- operator remembers to re-apply rls-setup.sql" — with the README only
-- telling operators to re-apply it after changes that ADD a tenant-scoped
-- table, not after a migration that CREATES one.
--
-- This migration restores the flags and the policies so the tables are
-- protected regardless of the order in which migrations and rls-setup.sql are
-- applied. It is idempotent: the ENABLE/FORCE statements are no-ops when the
-- flags are already set, and each policy is dropped and recreated.
--
-- The policy bodies are byte-identical to the ones in rls-setup.sql, so the
-- two paths cannot disagree. The `user` table is quoted because `user` is a
-- reserved word in PostgreSQL.

BEGIN;

-- ─── user ────────────────────────────────────────────────────────
-- Tenant-scoped via its own tenant_id AND via the owning party.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_user ON "user";
CREATE POLICY tenant_isolation_user ON "user"
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- ─── product ─────────────────────────────────────────────────────
ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_product ON product;
CREATE POLICY tenant_isolation_product ON product
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

-- ─── product_category ────────────────────────────────────────────
ALTER TABLE product_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_category FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_product_category ON product_category;
CREATE POLICY tenant_isolation_product_category ON product_category
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

-- ─── product_feature ─────────────────────────────────────────────
-- Protected through the owning product row, so a malformed write path
-- cannot attach another tenant's product metadata.
ALTER TABLE product_feature ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_feature FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_product_feature ON product_feature;
CREATE POLICY tenant_isolation_product_feature ON product_feature
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND product_id IN (
      SELECT product_id FROM product
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND product_id IN (
      SELECT product_id FROM product
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- ─── product_price ───────────────────────────────────────────────
ALTER TABLE product_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_price FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_product_price ON product_price;
CREATE POLICY tenant_isolation_product_price ON product_price
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND product_id IN (
      SELECT product_id FROM product
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND product_id IN (
      SELECT product_id FROM product
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- ─── contact_mechanism.contact_mechanism_type_id index ───────────
-- Every other foreign-key column in the schema has a supporting index (see
-- migration 20260819000000_add_schema_declared_indexes). This one was
-- missed: deleting or updating a contact_mechanism_type row performed a
-- sequential scan of contact_mechanism.
CREATE INDEX IF NOT EXISTS "contact_mechanism_contact_mechanism_type_id_idx"
  ON "contact_mechanism"("contact_mechanism_type_id");

COMMIT;
