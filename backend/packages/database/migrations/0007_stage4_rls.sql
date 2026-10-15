-- Stage 4: tenant isolation, updated_at triggers and append-only guards for the operational layer (see 0006).
SELECT enable_tenant_rls('warehouse_locations');
--> statement-breakpoint
SELECT enable_tenant_rls('warehouse_bins');
--> statement-breakpoint
SELECT enable_tenant_rls('warehouse_members');
--> statement-breakpoint
SELECT enable_tenant_rls('bin_stock');
--> statement-breakpoint
SELECT enable_tenant_rls('inbound_shipments');
--> statement-breakpoint
SELECT enable_tenant_rls('inbound_shipment_items');
--> statement-breakpoint
SELECT enable_tenant_rls('fulfillments');
--> statement-breakpoint
SELECT enable_tenant_rls('fulfillment_items');
--> statement-breakpoint
SELECT enable_tenant_rls('fulfillment_events');
--> statement-breakpoint
SELECT enable_tenant_rls('pick_lists');
--> statement-breakpoint
SELECT enable_tenant_rls('pick_tasks');
--> statement-breakpoint
SELECT enable_tenant_rls('fulfillment_exceptions');
--> statement-breakpoint
SELECT enable_tenant_rls('packages');
--> statement-breakpoint
SELECT enable_tenant_rls('package_items');
--> statement-breakpoint
SELECT enable_tenant_rls('vendor_shipping_providers');
--> statement-breakpoint
SELECT enable_tenant_rls('manifests');
--> statement-breakpoint
SELECT enable_tenant_rls('shipments');
--> statement-breakpoint
SELECT enable_tenant_rls('shipment_tracking_events');
--> statement-breakpoint
SELECT enable_tenant_rls('ndr_cases');
--> statement-breakpoint
SELECT enable_tenant_rls('return_orders');
--> statement-breakpoint
SELECT enable_tenant_rls('return_items');
--> statement-breakpoint
SELECT enable_tenant_rls('return_events');
--> statement-breakpoint
SELECT enable_tenant_rls('order_cancellations');
--> statement-breakpoint
SELECT enable_tenant_rls('business_rules');
--> statement-breakpoint
SELECT enable_tenant_rls('rule_executions');
--> statement-breakpoint
SELECT enable_tenant_rls('marketplace_prices');
--> statement-breakpoint
SELECT enable_tenant_rls('price_history');
--> statement-breakpoint
SELECT enable_tenant_rls('notifications');
--> statement-breakpoint
SELECT enable_tenant_rls('notification_deliveries');
--> statement-breakpoint
SELECT enable_tenant_rls('notification_preferences');
--> statement-breakpoint
SELECT enable_tenant_rls('device_tokens');
--> statement-breakpoint
SELECT attach_updated_at('warehouse_locations');
--> statement-breakpoint
SELECT attach_updated_at('warehouse_bins');
--> statement-breakpoint
SELECT attach_updated_at('warehouse_members');
--> statement-breakpoint
SELECT attach_updated_at('bin_stock');
--> statement-breakpoint
SELECT attach_updated_at('inbound_shipments');
--> statement-breakpoint
SELECT attach_updated_at('inbound_shipment_items');
--> statement-breakpoint
SELECT attach_updated_at('fulfillments');
--> statement-breakpoint
SELECT attach_updated_at('fulfillment_items');
--> statement-breakpoint
SELECT attach_updated_at('pick_lists');
--> statement-breakpoint
SELECT attach_updated_at('pick_tasks');
--> statement-breakpoint
SELECT attach_updated_at('fulfillment_exceptions');
--> statement-breakpoint
SELECT attach_updated_at('packages');
--> statement-breakpoint
SELECT attach_updated_at('package_items');
--> statement-breakpoint
SELECT attach_updated_at('vendor_shipping_providers');
--> statement-breakpoint
SELECT attach_updated_at('manifests');
--> statement-breakpoint
SELECT attach_updated_at('shipments');
--> statement-breakpoint
SELECT attach_updated_at('ndr_cases');
--> statement-breakpoint
SELECT attach_updated_at('return_orders');
--> statement-breakpoint
SELECT attach_updated_at('return_items');
--> statement-breakpoint
SELECT attach_updated_at('order_cancellations');
--> statement-breakpoint
SELECT attach_updated_at('business_rules');
--> statement-breakpoint
SELECT attach_updated_at('marketplace_prices');
--> statement-breakpoint
SELECT attach_updated_at('notifications');
--> statement-breakpoint
SELECT attach_updated_at('notification_deliveries');
--> statement-breakpoint
SELECT attach_updated_at('notification_preferences');
--> statement-breakpoint
SELECT attach_updated_at('device_tokens');
--> statement-breakpoint
CREATE TRIGGER fulfillment_events_append_only BEFORE UPDATE OR DELETE ON fulfillment_events FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER shipment_tracking_events_append_only BEFORE UPDATE OR DELETE ON shipment_tracking_events FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER return_events_append_only BEFORE UPDATE OR DELETE ON return_events FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER rule_executions_append_only BEFORE UPDATE OR DELETE ON rule_executions FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER price_history_append_only BEFORE UPDATE OR DELETE ON price_history FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON user_tokens USING (app_scope() IN ('platform', 'system')) WITH CHECK (app_scope() IN ('platform', 'system'));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oms_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM oms_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON permissions, role_permissions FROM oms_app;
    REVOKE UPDATE, TRUNCATE ON inventory_movements, order_status_events, fulfillment_events, shipment_tracking_events, return_events, rule_executions, price_history FROM oms_app;
  END IF;
END $$;
