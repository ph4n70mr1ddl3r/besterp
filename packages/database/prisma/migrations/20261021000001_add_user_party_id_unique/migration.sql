-- Enforce the 1:1 Party↔User relation at the database level.
--
-- `schema.prisma` declares `partyId String @unique @map("party_id")` on the
-- User model (the 1:1 side of `Party.user`), but no migration ever created
-- the corresponding unique index. The database therefore did not enforce the
-- invariant the schema promises: two user rows could point at the same
-- party, and `db.user.findUnique({ where: { partyId } })` — which the Prisma
-- client derives from that unique index — had no index to use.
--
-- The index is created IF NOT EXISTS so the migration is idempotent, and it
-- is created BEFORE any conflicting rows could be rejected: a database that
-- already violates the invariant fails loudly here rather than silently
-- keeping duplicates.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "user_party_id_key" ON "user"("party_id");

COMMIT;
