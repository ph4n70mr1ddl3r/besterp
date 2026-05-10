-- RenameColumn: party_type.party_id → party_type.party_type_id
-- This fixes a misnamed PK column that was incorrectly mapped.

-- 1. Rename the column
ALTER TABLE "party_type" RENAME COLUMN "party_id" TO "party_type_id";

-- 2. Update any foreign keys that reference this column
ALTER TABLE "party" RENAME COLUMN "party_type_id" TO "party_type_id_old";
ALTER TABLE "party" ADD COLUMN "party_type_id_new" TEXT;
UPDATE "party" SET "party_type_id_new" = "party_type_id_old";
ALTER TABLE "party" DROP COLUMN "party_type_id_old";
ALTER TABLE "party" RENAME COLUMN "party_type_id_new" TO "party_type_id";

-- Recreate the foreign key constraint
ALTER TABLE "party" DROP CONSTRAINT IF EXISTS "party_party_type_id_fkey";
ALTER TABLE "party" ADD CONSTRAINT "party_party_type_id_fkey" 
  FOREIGN KEY ("party_type_id") REFERENCES "party_type"("party_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;
