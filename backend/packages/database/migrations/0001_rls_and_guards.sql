-- ============================================================================
-- Tenant isolation (row-level security), integrity guards, updated_at triggers.
-- Hand-written migration (drizzle-kit does not model RLS/triggers). See docs/database/DATABASE.md.
--
-- Session variables set per transaction by @oms/database withScope():
--   app.scope      'vendor' | 'platform' | 'system'
--   app.vendor_id  uuid of the tenant when scope = 'vendor'
-- With no variables set (e.g. a forgotten withScope), NO tenant rows are visible: fail closed.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_scope() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.scope', true), ''), 'none') $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_vendor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.vendor_id', true), '')::uuid $$;
--> statement-breakpoint

-- Reusable helper: EVERY new tenant table's migration must call  SELECT enable_tenant_rls('table_name');
CREATE OR REPLACE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format($p$CREATE POLICY tenant_isolation ON %s
    USING (vendor_id = app_vendor_id() OR app_scope() IN ('platform', 'system'))
    WITH CHECK (vendor_id = app_vendor_id() OR app_scope() IN ('platform', 'system'))$p$, tbl);
END $fn$;
--> statement-breakpoint

-- Apply to every table that has a vendor_id column today.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'vendor_id'
  LOOP
    PERFORM enable_tenant_rls(quote_ident(t)::regclass);
  END LOOP;
END $$;
--> statement-breakpoint

-- vendors: a tenant sees only itself.
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE vendors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON vendors
  USING (id = app_vendor_id() OR app_scope() IN ('platform', 'system'))
  WITH CHECK (id = app_vendor_id() OR app_scope() IN ('platform', 'system'));
--> statement-breakpoint

-- System roles (vendor_id IS NULL) are readable by every tenant (assignable), never writable by them.
CREATE POLICY system_roles_readable ON roles FOR SELECT USING (vendor_id IS NULL);
--> statement-breakpoint

-- audit_logs is append-only: block UPDATE/DELETE for every role, including the table owner.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint

-- updated_at is maintained by the database so raw SQL / other writers cannot forget it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attach_updated_at(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()', replace(tbl::text, '"', '') || '_set_updated_at', tbl);
END $fn$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    PERFORM attach_updated_at(quote_ident(t)::regclass);
  END LOOP;
END $$;
--> statement-breakpoint

-- Runtime role privileges (role is created by infrastructure/postgres/init.sql or your DBA).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oms_app') THEN
    GRANT USAGE ON SCHEMA public TO oms_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oms_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM oms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO oms_app;
  END IF;
END $$;
