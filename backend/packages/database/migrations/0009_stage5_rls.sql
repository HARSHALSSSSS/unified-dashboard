-- Stage 5: tenant isolation + updated_at triggers + grants + seed data (see 0008).
SELECT enable_tenant_rls('analytics_daily_sales');
--> statement-breakpoint
SELECT enable_tenant_rls('analytics_daily_products');
--> statement-breakpoint
SELECT enable_tenant_rls('order_financials');
--> statement-breakpoint
SELECT enable_tenant_rls('fee_profiles');
--> statement-breakpoint
SELECT enable_tenant_rls('ai_settings');
--> statement-breakpoint
SELECT enable_tenant_rls('ai_recommendations');
--> statement-breakpoint
SELECT enable_tenant_rls('automation_rules');
--> statement-breakpoint
SELECT enable_tenant_rls('automation_executions');
--> statement-breakpoint
SELECT enable_tenant_rls('feature_flag_overrides');
--> statement-breakpoint
SELECT enable_tenant_rls('subscriptions');
--> statement-breakpoint
SELECT enable_tenant_rls('usage_records');
--> statement-breakpoint
SELECT enable_tenant_rls('invoices');
--> statement-breakpoint
SELECT enable_tenant_rls('invoice_lines');
--> statement-breakpoint
SELECT enable_tenant_rls('payments');
--> statement-breakpoint
SELECT attach_updated_at('analytics_daily_sales');
--> statement-breakpoint
SELECT attach_updated_at('analytics_daily_products');
--> statement-breakpoint
SELECT attach_updated_at('order_financials');
--> statement-breakpoint
SELECT attach_updated_at('fee_profiles');
--> statement-breakpoint
SELECT attach_updated_at('ai_settings');
--> statement-breakpoint
SELECT attach_updated_at('ai_recommendations');
--> statement-breakpoint
SELECT attach_updated_at('automation_rules');
--> statement-breakpoint
SELECT attach_updated_at('automation_executions');
--> statement-breakpoint
SELECT attach_updated_at('feature_flag_overrides');
--> statement-breakpoint
SELECT attach_updated_at('subscriptions');
--> statement-breakpoint
SELECT attach_updated_at('usage_records');
--> statement-breakpoint
SELECT attach_updated_at('invoices');
--> statement-breakpoint
SELECT attach_updated_at('invoice_lines');
--> statement-breakpoint
SELECT attach_updated_at('payments');
--> statement-breakpoint
SELECT attach_updated_at('plans');
--> statement-breakpoint
SELECT attach_updated_at('feature_flags');
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oms_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM oms_app;
    REVOKE UPDATE, TRUNCATE ON inventory_movements, order_status_events, fulfillment_events, shipment_tracking_events, return_events, rule_executions, price_history FROM oms_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON permissions, role_permissions FROM oms_app;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO feature_flags (key, description, default_enabled) VALUES
  ('ai.enabled', 'AI insights, questions and recommendations', true),
  ('automation.enabled', 'Rule-based automation engine', true),
  ('billing.enforce_limits', 'Reject actions that exceed the plan limits (otherwise limits are only reported)', false),
  ('connector.amazon_in.enabled', 'Amazon India marketplace connector', true),
  ('connector.flipkart.enabled', 'Flipkart marketplace connector', true),
  ('connector.myntra.enabled', 'Myntra marketplace connector', true),
  ('connector.snapdeal.enabled', 'Snapdeal marketplace connector', true),
  ('beta.features', 'Early-access features', false)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO plans (code, name, description, price_minor, currency, interval, limits, overage_per_order_minor, features, sort_order) VALUES
  ('free', 'Free', 'Try the platform', 0, 'INR', 'month', '{"orders":100,"products":50,"marketplace_accounts":1,"users":2}', NULL, '["core"]', 1),
  ('growth', 'Growth', 'For growing sellers', 99900, 'INR', 'month', '{"orders":2000,"products":1000,"marketplace_accounts":3,"users":10}', 300, '["core","analytics","automation"]', 2),
  ('scale', 'Scale', 'High volume sellers', 499900, 'INR', 'month', '{"orders":20000,"products":20000,"marketplace_accounts":10,"users":50}', 150, '["core","analytics","automation","ai"]', 3)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
