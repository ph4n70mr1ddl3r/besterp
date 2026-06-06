-- Add a partial unique index to prevent duplicate active roles for the same party.
-- Only rows where thruDate IS NULL (active roles) are constrained, allowing
-- multiple historical roles with the same type after they are closed.
-- This is a defense-in-depth constraint alongside the application-level check
-- in PartyService.addPartyRole() and the TOCTOU-safe transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "party_role_active_unique"
    ON "party_role" ("party_id", "role_type_id")
    WHERE "thru_date" IS NULL;
