-- Add missing indexes identified during code review.
--
-- 1. party_contact_mechanism.contact_mechanism_id:
--    The Prisma schema declared @@index([contactMechanismId]) but the init
--    migration only created the partyId index. The RLS policy for
--    party_contact_mechanism subqueries on contact_mechanism_id, so this
--    index is essential for policy evaluation performance.

CREATE INDEX IF NOT EXISTS "party_contact_mechanism_contact_mechanism_id_idx"
  ON "party_contact_mechanism"("contact_mechanism_id");
