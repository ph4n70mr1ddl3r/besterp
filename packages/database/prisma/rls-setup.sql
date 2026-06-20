-- RLS setup for BestERP Phase 0a spike
-- Applied after Prisma migration

-- ─── Tenant Context Function ────────────────────────────────
-- Parameterized function for setting tenant context, avoiding
-- string interpolation in application code. Eliminates the SQL
-- injection surface area of SET LOCAL with concatenated values.
-- Called via Prisma's $executeRaw tagged template (parameterized).

CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id TEXT)
RETURNS void AS $$
BEGIN
  -- Must use EXECUTE + format(%L) because SET LOCAL does not resolve
  -- PL/pgSQL variables — a plain SET LOCAL would assign the literal
  -- string "p_tenant_id" instead of the parameter value.
  EXECUTE format('SET LOCAL app.current_tenant = %L', p_tenant_id);
END;
$$ LANGUAGE plpgsql;

-- ─── Force RLS even for table owner ──────────────────────────
-- By default, table OWNERS bypass RLS. We need FORCE ROW LEVEL SECURITY
-- so that even the application role (non-owner) is properly restricted.
-- NOTE: Superusers ALWAYS bypass RLS regardless of this setting.

ALTER TABLE party ENABLE ROW LEVEL SECURITY;
ALTER TABLE party FORCE ROW LEVEL SECURITY;

ALTER TABLE contact_mechanism ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_mechanism FORCE ROW LEVEL SECURITY;

ALTER TABLE party_contact_mechanism ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_contact_mechanism FORCE ROW LEVEL SECURITY;

ALTER TABLE party_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_role FORCE ROW LEVEL SECURITY;

ALTER TABLE ai_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_log FORCE ROW LEVEL SECURITY;

ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;

-- ─── RLS Policies ─────────────────────────────────────────────
-- USING  = rows visible for SELECT, UPDATE, DELETE
-- WITH CHECK = rows allowed for INSERT, UPDATE
-- Note: Prisma String maps to TEXT, so no UUID cast needed.
-- IMPORTANT: current_setting(..., TRUE) returns '' (empty string) when
-- the setting is unset. We guard against '' to prevent edge-case leaks.

-- Party
CREATE POLICY IF NOT EXISTS tenant_isolation_party ON party
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

-- Contact Mechanism
CREATE POLICY IF NOT EXISTS tenant_isolation_contact_mechanism ON contact_mechanism
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

-- Party Contact Mechanism (via party AND contact mechanism)
-- SECURITY: Both foreign keys must belong to the current tenant.
-- Without the contact_mechanism_id check, a buggy code path could link
-- a tenant's party to another tenant's contact mechanism.
CREATE POLICY IF NOT EXISTS tenant_isolation_party_contact_mechanism ON party_contact_mechanism
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- Party Role (via party subquery — party_role has no tenant_id column)
CREATE POLICY IF NOT EXISTS tenant_isolation_party_role ON party_role
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- AI Action Log
CREATE POLICY IF NOT EXISTS tenant_isolation_ai_action_log ON ai_action_log
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

-- Idempotency Record
CREATE POLICY IF NOT EXISTS tenant_isolation_idempotency_record ON idempotency_record
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND tenant_id = current_setting('app.current_tenant', TRUE)
  );

-- ─── Subtype tables (protected via parent party) ────────────────
-- These tables lack a direct tenant_id column, so policies JOIN through
-- the parent Party table to enforce isolation.

-- ─── Partial Unique Index: Active Party Roles ────────────────────
-- Prevents duplicate active roles at the DB level (defense-in-depth).
-- The application layer checks inside transactions, but this index
-- is the safety net against race conditions.
-- Uses a partial index (WHERE thru_date IS NULL) so expired roles
-- don't prevent re-assigning the same role type later.
CREATE UNIQUE INDEX IF NOT EXISTS party_role_active_unique
  ON party_role (party_id, role_type_id)
  WHERE thru_date IS NULL;

-- Person (subtype of Party)
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS tenant_isolation_person ON person
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- Organization (subtype of Party)
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS tenant_isolation_organization ON organization
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- Postal Address (subtype of ContactMechanism)
ALTER TABLE postal_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE postal_address FORCE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS tenant_isolation_postal_address ON postal_address
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- Telecom Number (subtype of ContactMechanism)
ALTER TABLE telecom_number ENABLE ROW LEVEL SECURITY;
ALTER TABLE telecom_number FORCE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS tenant_isolation_telecom_number ON telecom_number
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- Email Address (subtype of ContactMechanism)
ALTER TABLE email_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_address FORCE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS tenant_isolation_email_address ON email_address
  USING (
    current_setting('app.current_tenant', TRUE) != ''
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant', TRUE) != ''
    AND contact_mechanism_id IN (
      SELECT contact_mechanism_id FROM contact_mechanism
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );
