-- RLS setup for BestERP Phase 0a spike
-- Applied after Prisma migration

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

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

ALTER TABLE ai_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_log FORCE ROW LEVEL SECURITY;

ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;

-- ─── RLS Policies ─────────────────────────────────────────────
-- USING  = rows visible for SELECT, UPDATE, DELETE
-- WITH CHECK = rows allowed for INSERT, UPDATE
-- Note: Prisma String maps to TEXT, so no UUID cast needed.

-- Party
CREATE POLICY tenant_isolation_party ON party
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));

-- Contact Mechanism
CREATE POLICY tenant_isolation_contact_mechanism ON contact_mechanism
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));

-- Party Contact Mechanism (via party)
CREATE POLICY tenant_isolation_party_contact_mechanism ON party_contact_mechanism
  USING (
    party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    party_id IN (
      SELECT party_id FROM party
      WHERE tenant_id = current_setting('app.current_tenant', TRUE)
    )
  );

-- AI Action Log
CREATE POLICY tenant_isolation_ai_action_log ON ai_action_log
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));

-- Idempotency Record
CREATE POLICY tenant_isolation_idempotency_record ON idempotency_record
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
