-- Local/dev bootstrap, executed once by the postgres container as the superuser (POSTGRES_USER=oms_owner).
-- In staging/production the same two roles are provisioned by your DBA / IaC (Terraform), NOT by this file.
--
--   oms_owner : owns the schema. Used only by migrations + seed (DATABASE_MIGRATION_URL).
--   oms_app   : runtime role used by api/worker/scheduler (DATABASE_URL). Deliberately NOSUPERUSER + NOBYPASSRLS and
--               NOT the table owner, so row-level security policies ALWAYS apply to application queries.

CREATE ROLE oms_app LOGIN PASSWORD 'oms_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE oms TO oms_app;

-- Second database for integration tests that need a real server (TEST_DATABASE_URL).
CREATE DATABASE oms_test OWNER oms_owner;
GRANT CONNECT ON DATABASE oms_test TO oms_app;

\connect oms
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT USAGE ON SCHEMA public TO oms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE oms_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE oms_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO oms_app;

\connect oms_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT USAGE ON SCHEMA public TO oms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE oms_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE oms_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO oms_app;
