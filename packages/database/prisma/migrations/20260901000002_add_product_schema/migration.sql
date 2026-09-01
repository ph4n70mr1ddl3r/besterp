-- Add product domain tables for core-product module (ERP_PLAN.md Phase 1).
--
-- Implements Silverstone Ch. 3: Product / Goods with:
--   - product_type (classification: GOOD, SERVICE, RAW_MATERIAL, etc.)
--   - product_category (hierarchical classification)
--   - product (supertype with tenant scoping)
--   - product_feature (extensible attributes: color, size, weight)
--   - product_price (multiple price types with effective dating)

CREATE TABLE IF NOT EXISTS "product_type" (
  "product_type_id"   TEXT    NOT NULL,
  "parent_type_id"    TEXT,
  "name"              TEXT    NOT NULL,
  "description"       TEXT    NOT NULL,
  "ai_prompt_hint"    TEXT,
  "is_system"         BOOLEAN NOT NULL DEFAULT false,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "product_type_pkey" PRIMARY KEY ("product_type_id"),
  CONSTRAINT "product_type_name_key" UNIQUE ("name"),
  CONSTRAINT "product_type_parent_fkey" FOREIGN KEY ("parent_type_id") REFERENCES "product_type"("product_type_id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "product_type_parent_type_id_idx" ON "product_type"("parent_type_id");

CREATE TABLE IF NOT EXISTS "product_category" (
  "product_category_id" TEXT   NOT NULL,
  "parent_category_id"  TEXT,
  "tenant_id"           TEXT   NOT NULL,
  "name"                TEXT   NOT NULL,
  "description"         TEXT,
  "level"               INTEGER NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "product_category_pkey" PRIMARY KEY ("product_category_id"),
  CONSTRAINT "product_category_parent_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "product_category"("product_category_id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "product_category_tenant_id_idx" ON "product_category"("tenant_id");
CREATE INDEX IF NOT EXISTS "product_category_parent_category_id_idx" ON "product_category"("parent_category_id");

CREATE TABLE IF NOT EXISTS "product" (
  "product_id"      TEXT       NOT NULL,
  "product_type_id" TEXT       NOT NULL,
  "tenant_id"       TEXT       NOT NULL,
  "name"            TEXT       NOT NULL,
  "description"     TEXT,
  "sku"             TEXT,
  "version"         INTEGER    NOT NULL DEFAULT 1,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "product_pkey" PRIMARY KEY ("product_id"),
  CONSTRAINT "product_product_type_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id") ON DELETE RESTRICT,
  CONSTRAINT "product_sku_tenant_key" UNIQUE ("tenant_id", "sku")
);

CREATE INDEX IF NOT EXISTS "product_tenant_id_idx" ON "product"("tenant_id");
CREATE INDEX IF NOT EXISTS "product_product_type_id_idx" ON "product"("product_type_id");
CREATE INDEX IF NOT EXISTS "product_tenant_product_type_idx" ON "product"("tenant_id", "product_type_id");
CREATE INDEX IF NOT EXISTS "product_name_trgm_idx" ON "product" USING gin ("name" gin_trgm_ops);

CREATE TABLE IF NOT EXISTS "product_feature" (
  "product_feature_id" TEXT   NOT NULL,
  "product_id"         TEXT   NOT NULL,
  "name"               TEXT   NOT NULL,
  "value"              TEXT   NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "product_feature_pkey" PRIMARY KEY ("product_feature_id"),
  CONSTRAINT "product_feature_product_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "product_feature_product_id_idx" ON "product_feature"("product_id");

CREATE TABLE IF NOT EXISTS "product_price" (
  "product_price_id" TEXT         NOT NULL,
  "product_id"       TEXT         NOT NULL,
  "price_type"       TEXT         NOT NULL,
  "amount"           DECIMAL(19,4) NOT NULL,
  "currency_code"    TEXT         NOT NULL DEFAULT 'USD',
  "from_date"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "thru_date"        TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "product_price_pkey" PRIMARY KEY ("product_price_id"),
  CONSTRAINT "product_price_product_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "product_price_product_id_idx" ON "product_price"("product_id");
CREATE INDEX IF NOT EXISTS "product_price_from_date_idx" ON "product_price"("from_date");
CREATE INDEX IF NOT EXISTS "product_price_product_type_idx" ON "product_price"("product_id", "price_type");
