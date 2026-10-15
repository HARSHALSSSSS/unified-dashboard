-- Stage 3: tenant isolation, updated_at triggers and ledger guards for the tables added in 0004.
SELECT enable_tenant_rls('category_mappings');
--> statement-breakpoint
SELECT enable_tenant_rls('attribute_mappings');
--> statement-breakpoint
SELECT enable_tenant_rls('imported_products');
--> statement-breakpoint
SELECT enable_tenant_rls('webhook_events');
--> statement-breakpoint
SELECT enable_tenant_rls('channel_inventory_policies');
--> statement-breakpoint
SELECT enable_tenant_rls('channel_stock_updates');
--> statement-breakpoint
SELECT enable_tenant_rls('inventory_movements');
--> statement-breakpoint
SELECT enable_tenant_rls('inventory_reservations');
--> statement-breakpoint
SELECT enable_tenant_rls('stock_transfers');
--> statement-breakpoint
SELECT enable_tenant_rls('stock_transfer_items');
--> statement-breakpoint
SELECT enable_tenant_rls('vendor_counters');
--> statement-breakpoint
SELECT enable_tenant_rls('order_status_events');
--> statement-breakpoint
SELECT enable_tenant_rls('order_status_updates');
--> statement-breakpoint
SELECT attach_updated_at('category_mappings');
--> statement-breakpoint
SELECT attach_updated_at('attribute_mappings');
--> statement-breakpoint
SELECT attach_updated_at('imported_products');
--> statement-breakpoint
SELECT attach_updated_at('webhook_events');
--> statement-breakpoint
SELECT attach_updated_at('channel_inventory_policies');
--> statement-breakpoint
SELECT attach_updated_at('channel_stock_updates');
--> statement-breakpoint
SELECT attach_updated_at('inventory_reservations');
--> statement-breakpoint
SELECT attach_updated_at('stock_transfers');
--> statement-breakpoint
SELECT attach_updated_at('stock_transfer_items');
--> statement-breakpoint
SELECT attach_updated_at('vendor_counters');
--> statement-breakpoint
SELECT attach_updated_at('order_status_updates');
--> statement-breakpoint

-- Append-only ledgers: a movement / timeline entry is never edited. DELETE is allowed only under system scope
-- (retention / tenant purge jobs), never to an application request.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END IF;
  IF TG_OP = 'DELETE' AND app_scope() <> 'system' THEN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER order_status_events_append_only BEFORE UPDATE OR DELETE ON order_status_events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint

-- Opening balances: any stock that existed before the ledger gets one `count` movement so cache == ledger from day one.
SELECT set_config('app.scope', 'system', false);
--> statement-breakpoint
INSERT INTO inventory_movements (vendor_id, variant_id, warehouse_id, type, delta_on_hand, delta_reserved, on_hand_after, reserved_after, reason, reference_type, actor_type)
SELECT vendor_id, variant_id, warehouse_id, 'count', quantity_on_hand, quantity_reserved, quantity_on_hand, quantity_reserved, 'opening balance (ledger introduced)', 'import', 'system'
FROM inventory WHERE quantity_on_hand <> 0 OR quantity_reserved <> 0;
--> statement-breakpoint
SELECT set_config('app.scope', '', false);
--> statement-breakpoint

-- Proves the stock cache equals the ledger. Returns ONLY mismatching (variant, warehouse) pairs: empty = healthy.
-- Runs with the caller's privileges, so RLS applies (a tenant can only inspect itself).
CREATE OR REPLACE FUNCTION inventory_ledger_drift(p_vendor uuid)
RETURNS TABLE (variant_id uuid, warehouse_id uuid, on_hand int, ledger_on_hand bigint, reserved int, ledger_reserved bigint, incoming int, ledger_incoming bigint, damaged int, ledger_damaged bigint, returned int, ledger_returned bigint)
LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT im.variant_id, im.warehouse_id, sum(delta_on_hand) oh, sum(delta_reserved) rs, sum(delta_incoming) inc, sum(delta_damaged) dm, sum(delta_returned) rt
    FROM inventory_movements im WHERE im.vendor_id = p_vendor GROUP BY im.variant_id, im.warehouse_id
  ), i AS (SELECT * FROM inventory WHERE vendor_id = p_vendor)
  SELECT coalesce(i.variant_id, m.variant_id), coalesce(i.warehouse_id, m.warehouse_id),
         coalesce(i.quantity_on_hand, 0), coalesce(m.oh, 0)::bigint,
         coalesce(i.quantity_reserved, 0), coalesce(m.rs, 0)::bigint,
         coalesce(i.quantity_incoming, 0), coalesce(m.inc, 0)::bigint,
         coalesce(i.quantity_damaged, 0), coalesce(m.dm, 0)::bigint,
         coalesce(i.quantity_returned, 0), coalesce(m.rt, 0)::bigint
  FROM i FULL JOIN m ON m.variant_id = i.variant_id AND m.warehouse_id = i.warehouse_id
  WHERE coalesce(i.quantity_on_hand, 0) <> coalesce(m.oh, 0) OR coalesce(i.quantity_reserved, 0) <> coalesce(m.rs, 0)
     OR coalesce(i.quantity_incoming, 0) <> coalesce(m.inc, 0) OR coalesce(i.quantity_damaged, 0) <> coalesce(m.dm, 0)
     OR coalesce(i.quantity_returned, 0) <> coalesce(m.rt, 0)
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oms_app;
    GRANT EXECUTE ON FUNCTION inventory_ledger_drift(uuid) TO oms_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM oms_app;
    REVOKE UPDATE, TRUNCATE ON inventory_movements, order_status_events FROM oms_app;
  END IF;
END $$;
