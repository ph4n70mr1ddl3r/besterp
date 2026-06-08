-- Add missing party_role indexes identified during code review.
--
-- The Prisma schema declares @@index([partyId]), @@index([roleTypeId]),
-- and @@index([partyId, roleTypeId]) on the PartyRole model, but the
-- init migration omitted them. Without these indexes, every role query
-- and RLS policy evaluation on party_role requires a full table scan.

CREATE INDEX IF NOT EXISTS "party_role_party_id_idx"
  ON "party_role"("party_id");

CREATE INDEX IF NOT EXISTS "party_role_role_type_id_idx"
  ON "party_role"("role_type_id");

CREATE INDEX IF NOT EXISTS "party_role_party_id_role_type_id_idx"
  ON "party_role"("party_id", "role_type_id");
