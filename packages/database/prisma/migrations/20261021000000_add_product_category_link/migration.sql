-- Add the optional category link to `product`.
--
-- The Prisma schema has declared
--   category ProductCategory? @relation(fields: [productCategoryId], references: [productCategoryId])
--   productCategoryId String? @map("product_category_id")
-- since the core-product module landed (migration 20260901000002), but that
-- migration created the `product` table WITHOUT the `product_category_id`
-- column and WITHOUT the foreign key. The schema and the database have been
-- out of sync since day one, so:
--
--   * `db.product.findMany({ include: { category: … } })` referenced a column
--     that does not exist → "column product.product_category_id does not
--     exist" → get_product / search_products ALWAYS failed.
--   * `db.product.create({ data: { category: { connect: … } } })` failed the
--     same way → create_product with a categoryId ALWAYS failed.
--
-- The column is nullable and the FK is ON DELETE SET NULL so removing a
-- category detaches (rather than deletes) its products — matching the
-- optional relation declared in the schema.

BEGIN;

ALTER TABLE "product"
  ADD COLUMN IF NOT EXISTS "product_category_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_product_category_id_fkey'
  ) THEN
    ALTER TABLE "product"
      ADD CONSTRAINT "product_product_category_id_fkey"
      FOREIGN KEY ("product_category_id")
      REFERENCES "product_category"("product_category_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Supporting index for the category join / lookup.
CREATE INDEX IF NOT EXISTS "product_product_category_id_idx"
  ON "product"("product_category_id");

COMMIT;
