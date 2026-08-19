-- Close the schema/migration index drift.
--
-- schema.prisma declares 14 indexes that no migration ever created (verified
-- against every migration in this directory). A fresh `migrate deploy`
-- database therefore does not match schema.prisma, so the next
-- `prisma migrate dev` emits a large surprise migration, and production
-- lacks the FK-support indexes (party.party_type_id, *_parent_type_id —
-- every FK check cascades to a seq scan without them) and the audit/cleanup
-- query indexes (ai_action_log (tenant_id, created_at),
-- idempotency_record (status, expires_at)).
--
-- Index names follow Prisma's default convention (<table>_<columns>_idx /
-- <table>_<columns>_key) so `migrate dev` does not see further drift.
-- IF NOT EXISTS keeps the migration idempotent, matching the style of
-- 20260528210000_add_missing_indexes.

-- FK support: self-referencing type hierarchies
CREATE INDEX IF NOT EXISTS "party_type_parent_type_id_idx" ON "party_type"("parent_type_id");
CREATE INDEX IF NOT EXISTS "role_type_parent_type_id_idx" ON "role_type"("parent_type_id");

-- FK support + tenant-scoped type filters on party
CREATE INDEX IF NOT EXISTS "party_party_type_id_idx" ON "party"("party_type_id");
CREATE INDEX IF NOT EXISTS "party_tenant_id_party_type_id_idx" ON "party"("tenant_id", "party_type_id");

-- Role expiry sweeps (cleanup jobs filter on thru_date / order by from_date)
CREATE INDEX IF NOT EXISTS "party_role_from_date_idx" ON "party_role"("from_date");
CREATE INDEX IF NOT EXISTS "party_role_thru_date_idx" ON "party_role"("thru_date");

-- Audit log queries: tenant timelines, tool usage, user/agent/conversation lookups
CREATE INDEX IF NOT EXISTS "ai_action_log_tenant_id_created_at_idx" ON "ai_action_log"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_action_log_tenant_id_tool_called_idx" ON "ai_action_log"("tenant_id", "tool_called");
CREATE INDEX IF NOT EXISTS "ai_action_log_user_id_idx" ON "ai_action_log"("user_id");
CREATE INDEX IF NOT EXISTS "ai_action_log_agent_id_idx" ON "ai_action_log"("agent_id");
CREATE INDEX IF NOT EXISTS "ai_action_log_conversation_id_idx" ON "ai_action_log"("conversation_id");

-- Idempotency cleanup sweep (status + expires_at) and per-tool debugging
CREATE INDEX IF NOT EXISTS "idempotency_record_status_expires_at_idx" ON "idempotency_record"("status", "expires_at");
CREATE INDEX IF NOT EXISTS "idempotency_record_tool_name_idx" ON "idempotency_record"("tool_name");

-- Email duplicate pre-check lookups by address
CREATE INDEX IF NOT EXISTS "email_address_email_idx" ON "email_address"("email");
