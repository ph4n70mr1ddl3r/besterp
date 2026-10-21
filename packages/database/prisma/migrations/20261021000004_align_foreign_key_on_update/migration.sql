-- Align the foreign keys of the core-product tables with schema.prisma.
--
-- The product tables were created by migration 20260901000002 with foreign
-- keys that omit `ON UPDATE CASCADE`:
--
--   CONSTRAINT "product_product_type_fkey" FOREIGN KEY ("product_type_id")
--     REFERENCES "product_type"("product_type_id") ON DELETE RESTRICT
--
-- Prisma's relation mapping always emits `ON DELETE <action> ON UPDATE
-- CASCADE`, so the schema and the database disagreed about the referential
-- action. `prisma migrate dev` therefore reported drift on every run and
-- wanted to DROP and re-CREATE all five constraints — a churn that briefly
-- removes the referential integrity the product module depends on (a product
-- row could be inserted with a dangling product_type_id in between).
--
-- The fix is to add the missing ON UPDATE clause to the existing
-- constraints in place. Dropping and re-adding the constraint is unnecessary:
-- `ALTER TABLE ... ADD CONSTRAINT` cannot redefine an existing constraint, but
-- the action clauses can be changed with a DROP + ADD inside a single
-- transaction (which is atomic — the constraint is never absent from outside
-- the transaction).

BEGIN;

ALTER TABLE "product" DROP CONSTRAINT "product_product_type_fkey";
ALTER TABLE "product" ADD CONSTRAINT "product_product_type_fkey"
  FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_type" DROP CONSTRAINT "product_type_parent_fkey";
ALTER TABLE "product_type" ADD CONSTRAINT "product_type_parent_fkey"
  FOREIGN KEY ("parent_type_id") REFERENCES "product_type"("product_type_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_category" DROP CONSTRAINT "product_category_parent_fkey";
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_parent_fkey"
  FOREIGN KEY ("parent_category_id") REFERENCES "product_category"("product_category_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_feature" DROP CONSTRAINT "product_feature_product_fkey";
ALTER TABLE "product_feature" ADD CONSTRAINT "product_feature_product_fkey"
  FOREIGN KEY ("product_id") REFERENCES "product"("product_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_price" DROP CONSTRAINT "product_price_product_fkey";
ALTER TABLE "product_price" ADD CONSTRAINT "product_price_product_fkey"
  FOREIGN KEY ("product_id") REFERENCES "product"("product_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
