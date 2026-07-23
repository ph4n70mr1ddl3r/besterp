-- Create the non-superuser application role for BestERP.
-- This MUST be run after initial database provisioning.
--
-- WHY: PostgreSQL superusers ALWAYS bypass Row-Level Security (RLS),
-- even with FORCE ROW LEVEL SECURITY. All application runtime queries
-- must use a non-superuser role for RLS to be enforced.
--
-- Usage: psql -U besterp -d besterp -f create-roles.sql
--
-- WARNING: The password below is a DEV-ONLY placeholder. For staging and
-- production environments, set the role password via:
--   ALTER ROLE besterp_app WITH PASSWORD '<strong-random-password>';
-- or pass it through a secrets manager / migration tool.

-- Create the application role.
-- PASSWORD must be set via ALTER ROLE before deploying to non-dev environments.
-- See the NOTE comment near the bottom of this file for the production command.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'besterp_app') THEN
    -- Placeholder password — MUST be replaced with a strong random value via
    // ALTER ROLE before first use outside local development.
    CREATE ROLE besterp_app WITH LOGIN PASSWORD 'CHANGE_ME_USE_ALTER_ROLE' NOINHERIT;
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

-- Revoke default PUBLIC privileges — prevent other roles from inheriting access
REVOKE CONNECT ON DATABASE besterp FROM PUBLIC;
REVOKE USAGE ON SCHEMA public FROM PUBLIC;

-- Grant on future tables (created by migrations)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO besterp_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO besterp_app;

-- Restrict set_tenant_context() to app role only (defense-in-depth)
REVOKE EXECUTE ON FUNCTION set_tenant_context(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_context(TEXT) TO besterp_app;
