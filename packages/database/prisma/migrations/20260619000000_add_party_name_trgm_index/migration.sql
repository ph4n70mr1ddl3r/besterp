-- Create trigram extension and GIN index for efficient case-insensitive LIKE searches on Party.name.
-- This prevents sequential scans on large tables when using search_parties with a name filter.
-- NOTE: For large tables in production, run this manually outside of a Prisma migration:
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--   CREATE INDEX CONCURRENTLY party_name_trgm_idx ON party USING gin (name gin_trgm_ops);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX party_name_trgm_idx ON party USING gin (name gin_trgm_ops);
