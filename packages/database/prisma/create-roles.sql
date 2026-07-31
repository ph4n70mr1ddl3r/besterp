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
-- The password is single-sourced from the psql variable `app_db_password`
-- (defaults to the dev value used by .env.example and docker-compose.yml).
-- CI overrides it with `psql -v app_db_password=besterp_app_dev ...` to match
-- the connection strings in .github/workflows/ci.yml. For staging/production,
-- pass a strong random value via -v or ALTER ROLE afterwards — see the NOTE
-- near the bottom of this file.
-- `format(...) \gexec` is used (not a DO block) because psql does not
-- interpolate variables inside dollar-quoted strings; the SELECT guard makes
-- this idempotent across re-runs.
\if :{?app_db_password}
\else
\set app_db_password 'CHANGEME_APP_PASSWORD'
\endif
SELECT format('CREATE ROLE besterp_app WITH LOGIN PASSWORD %L NOINHERIT', :'app_db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'besterp_app')\gexec

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

-- NOTE: set_tenant_context() EXECUTE restrictions live in rls-setup.sql, which
-- runs AFTER migrations create the function. This file cannot GRANT/REVOKE on
-- it because the function does not exist yet when this script runs.
