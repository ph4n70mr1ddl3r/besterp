-- Add entity_descriptor and confirmation_gate tables for AI self-service.
--
-- entity_descriptor: AI-facing descriptions for every core entity. Fills the
-- gap identified in ERP_PLAN.md Phase 0c ("Create entity_descriptor table and
-- seed for all core entities") so the describe_entity discovery tool can
-- return structured schema info without exposing raw Prisma output to agents.
--
-- confirmation_gate: Tracks which tools require agent confirmation before
-- execution. Fills the gap identified in ERP_PLAN.md Phase 0c ("Create
-- confirmation_gate table and enforcement middleware"). Admin-curated, global
-- reference data — not tenant-scoped.

CREATE TABLE IF NOT EXISTS "entity_descriptor" (
  "entity_name"   TEXT    NOT NULL,
  "description"   TEXT    NOT NULL,
  "ai_prompt_hint" TEXT,
  "key_fields"    JSONB,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "entity_descriptor_pkey" PRIMARY KEY ("entity_name")
);

CREATE TABLE IF NOT EXISTS "confirmation_gate" (
  "tool_name"   TEXT    NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "description" TEXT    NOT NULL,
  "reason"      TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "confirmation_gate_pkey" PRIMARY KEY ("tool_name")
);
