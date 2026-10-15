-- Stage 2: tenant isolation + updated_at triggers for the tables added in 0002.
-- (Convention: every migration that adds a tenant table calls enable_tenant_rls() for it.)
SELECT enable_tenant_rls('invitations');
--> statement-breakpoint
SELECT enable_tenant_rls('attribute_definitions');
--> statement-breakpoint
SELECT enable_tenant_rls('attribute_values');
--> statement-breakpoint
SELECT enable_tenant_rls('category_attributes');
--> statement-breakpoint
SELECT enable_tenant_rls('product_attribute_values');
--> statement-breakpoint
SELECT enable_tenant_rls('product_marketplace_data');
--> statement-breakpoint
SELECT enable_tenant_rls('data_jobs');
--> statement-breakpoint
SELECT attach_updated_at('invitations');
--> statement-breakpoint
SELECT attach_updated_at('attribute_definitions');
--> statement-breakpoint
SELECT attach_updated_at('attribute_values');
--> statement-breakpoint
SELECT attach_updated_at('product_attribute_values');
--> statement-breakpoint
SELECT attach_updated_at('product_marketplace_data');
--> statement-breakpoint
SELECT attach_updated_at('data_jobs');
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oms_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM oms_app;
  END IF;
END $$;
