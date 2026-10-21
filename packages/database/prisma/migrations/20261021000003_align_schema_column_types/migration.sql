-- Align the live database with `schema.prisma`.
--
-- Every statement below closes a drift that `prisma migrate dev` would
-- otherwise detect on EVERY invocation, which produced either a steady stream
-- of generated migrations or — worse — a destructive "reset the database"
-- prompt for developers running the documented `npm run db:migrate`.
--
-- 1. `idempotency_record.status` is TEXT in the database while the schema
--    declares the native enum `IdempotencyStatus`. The database therefore
--    accepted arbitrary status strings the schema forbids, and the generated
--    client and the database disagreed about the column type.
--
-- 2. `idempotency_record(status, expires_at)` — the schema declares the
--    composite index (the cleanup query scans by status and expiry) but no
--    migration ever created it.
--
-- 3. `agent_registry.capabilities` is nullable in the database while the
--    schema declares `Json` (NOT NULL); `max_transaction_amount` is
--    DECIMAL(19,4) without a default while the schema declares
--    `Decimal? @default(0)`.
--
-- 4. Every table created AFTER the initial migration used TIMESTAMPTZ while
--    the schema (and the initial migration) use TIMESTAMP(3) — i.e. Prisma's
--    default `DateTime` mapping. Mixed timestamp semantics across tables in
--    one schema is a latent correctness bug: a `TIMESTAMP(3)` column is
--    interpreted as UTC by Prisma while a `TIMESTAMPTZ` column is an
--    absolute instant, so the same logical timestamp means different things
--    depending on which table it lives in.
--
--    The conversion is pinned to UTC (`SET LOCAL TIME ZONE 'UTC'`) so the
--    TIMESTAMPTZ → TIMESTAMP cast is deterministic and independent of the
--    server's time zone: Prisma writes UTC, so the wall-clock value is
--    unchanged.
--
-- 5. `updated_at` columns on the later tables carried a `DEFAULT now()`
--    that the schema does not declare. Prisma manages `updatedAt` in the
--    client, so the database default is dead weight that also shows up as
--    drift.

BEGIN;

-- Deterministic TIMESTAMPTZ → TIMESTAMP conversion (see note 4).
SET LOCAL TIME ZONE 'UTC';

-- ─── 1. idempotency_record.status → native enum ───────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IdempotencyStatus') THEN
    CREATE TYPE "IdempotencyStatus" AS ENUM ('pending', 'completed', 'failed');
  END IF;
END $$;

ALTER TABLE "idempotency_record" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "idempotency_record"
  ALTER COLUMN "status" TYPE "IdempotencyStatus" USING ("status"::"IdempotencyStatus");
ALTER TABLE "idempotency_record" ALTER COLUMN "status" SET DEFAULT 'pending';

-- ─── 2. missing composite index ───────────────────────────────────

CREATE INDEX IF NOT EXISTS "idempotency_record_status_expires_at_idx"
  ON "idempotency_record"("status", "expires_at");

-- ─── 3. agent_registry column alignment ────────────────────────────

-- Backfill NULL capabilities before enforcing NOT NULL so the migration
-- cannot fail on a table that already contains legacy rows.
UPDATE "agent_registry" SET "capabilities" = '[]'::jsonb WHERE "capabilities" IS NULL;
ALTER TABLE "agent_registry" ALTER COLUMN "capabilities" SET NOT NULL;

ALTER TABLE "agent_registry" ALTER COLUMN "max_transaction_amount" SET DEFAULT 0;
ALTER TABLE "agent_registry"
  ALTER COLUMN "max_transaction_amount" TYPE DECIMAL(65,30) USING "max_transaction_amount"::DECIMAL(65,30);

-- ─── 4/5. timestamp semantics + updated_at defaults ────────────────

ALTER TABLE "agent_registry"        ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "confirmation_gate"     ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "confirmation_gate"     ALTER COLUMN "updated_at"  DROP DEFAULT;
ALTER TABLE "confirmation_gate"     ALTER COLUMN "updated_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "entity_descriptor"     ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product"               ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product"               ALTER COLUMN "updated_at"  DROP DEFAULT;
ALTER TABLE "product"               ALTER COLUMN "updated_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product_category"      ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product_feature"       ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product_price"         ALTER COLUMN "from_date"   SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product_price"         ALTER COLUMN "thru_date"   SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product_price"         ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "product_type"          ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "user"                  ALTER COLUMN "last_login_at" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "user"                  ALTER COLUMN "created_at"  SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "user"                  ALTER COLUMN "updated_at"  DROP DEFAULT;
ALTER TABLE "user"                  ALTER COLUMN "updated_at"  SET DATA TYPE TIMESTAMP(3);

COMMIT;
