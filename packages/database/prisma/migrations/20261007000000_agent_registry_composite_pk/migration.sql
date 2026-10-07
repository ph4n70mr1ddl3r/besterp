-- Change agent_registry primary key from single agent_id to composite (agent_id, tenant_id).
--
-- Rationale: agent_registry is per-tenant; each tenant must be able to register
-- its own agent with the same agentId. The single-column PK prevented the seed
-- from creating a default-agent for tenant-globex (it found and no-op'd the
-- tenant-acme row instead) and would reject runtime registerAgent calls that
-- reuse an agentId across tenants.
--
-- PostgreSQL does not support ALTER TABLE ... ADD PRIMARY KEY when a PK already
-- exists, so we recreate the table: create new → copy data → drop old → rename.

BEGIN;

CREATE TABLE IF NOT EXISTS "agent_registry_new" (
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

  CONSTRAINT "agent_registry_pkey" PRIMARY KEY ("agent_id", "tenant_id")
);

INSERT INTO "agent_registry_new" ("agent_id", "tenant_id", "display_name", "description",
  "capabilities", "max_tool_calls_per_conversation", "max_concurrent_conversations",
  "max_transaction_amount", "allowed_entity_types", "rate_limit_per_minute",
  "version", "is_active", "created_at")
SELECT "agent_id", "tenant_id", "display_name", "description",
  "capabilities", "max_tool_calls_per_conversation", "max_concurrent_conversations",
  "max_transaction_amount", "allowed_entity_types", "rate_limit_per_minute",
  "version", "is_active", "created_at"
FROM "agent_registry";

DROP TABLE "agent_registry";

ALTER TABLE "agent_registry_new" RENAME TO "agent_registry";

CREATE INDEX IF NOT EXISTS "agent_registry_tenant_id_idx" ON "agent_registry"("tenant_id");

COMMIT;
