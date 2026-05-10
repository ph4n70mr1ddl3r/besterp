-- Create the non-superuser application role for BestERP.
-- This MUST be run after initial database provisioning.
--
-- WHY: PostgreSQL superusers ALWAYS bypass Row-Level Security (RLS),
-- even with FORCE ROW LEVEL SECURITY. All application runtime queries
-- must use a non-superuser role for RLS to be enforced.
--
-- Usage: psql -U besterp -d besterp -f create-roles.sql

-- Create the application role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'besterp_app') THEN
    CREATE ROLE besterp_app WITH LOGIN PASSWORD 'besterp_app_dev' NOINHERIT;
  END IF;
END
$$;

-- Grant database access
GRANT CONNECT ON DATABASE besterp TO besterp_app;

-- Grant schema access
GRANT USAGE ON SCHEMA public TO besterp_app;

-- Grant table access (existing tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO besterp_app;

-- Grant sequence access (existing sequences)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO besterp_app;

-- Grant on future tables (created by migrations)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO besterp_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO besterp_app;
