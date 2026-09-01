-- Add agent_registry and user tables for core-security (ERP_PLAN.md Phase 0c).
--
-- agent_registry: Per-tenant AI agent registry with capabilities, rate limits,
-- and financial restrictions. Implements AGENTIC_AI_DESIGN.md §8.1.
--
-- user: Human user account linked to a PARTY (Silverstone Party model).
-- Carries auth-specific data (password hash, last login). Implements ERP_PLAN.md
-- Phase 0c: core-security.

CREATE TABLE IF NOT EXISTS "agent_registry" (
  "agent_id"                          TEXT    NOT NULL,
  "tenant_id"                         TEXT    NOT NULL,
  "display_name"                      TEXT    NOT NULL,
  "description"                       TEXT    NOT NULL,
  "capabilities"                      JSONB,
  "max_tool_calls_per_conversation"   INTEGER NOT NULL DEFAULT 100,
  "max_concurrent_conversations"      INTEGER NOT NULL DEFAULT 5,
  "max_transaction_amount"            DECIMAL(19,4),
  "allowed_entity_types"              JSONB NOT NULL DEFAULT '[]',
  "rate_limit_per_minute"             INTEGER NOT NULL DEFAULT 30,
  "version"                           TEXT    NOT NULL,
  "is_active"                         BOOLEAN NOT NULL DEFAULT true,
  "created_at"                        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "agent_registry_pkey" PRIMARY KEY ("agent_id")
);

CREATE INDEX IF NOT EXISTS "agent_registry_tenant_id_idx" ON "agent_registry"("tenant_id");

CREATE TABLE IF NOT EXISTS "user" (
  "user_id"          TEXT    NOT NULL,
  "party_id"         TEXT    NOT NULL,
  "tenant_id"        TEXT    NOT NULL,
  "password_hash"    TEXT    NOT NULL,
  "last_login_at"    TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "user_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("party_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_tenant_party_unique" UNIQUE ("tenant_id", "party_id")
);

CREATE INDEX IF NOT EXISTS "user_tenant_id_idx" ON "user"("tenant_id");
