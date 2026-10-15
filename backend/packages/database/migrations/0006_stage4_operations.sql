CREATE TABLE "bin_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bin_stock_qty_chk" CHECK (quantity >= 0)
);
--> statement-breakpoint
CREATE TABLE "inbound_shipment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"inbound_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"expected_quantity" integer NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"damaged_quantity" integer DEFAULT 0 NOT NULL,
	"bin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_shipment_items_qty_chk" CHECK (expected_quantity > 0 AND received_quantity >= 0 AND damaged_quantity >= 0 AND damaged_quantity <= received_quantity)
);
--> statement-breakpoint
CREATE TABLE "inbound_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"supplier" text,
	"reference" text,
	"status" text DEFAULT 'expected' NOT NULL,
	"expected_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_shipments_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "inbound_shipments_status_chk" CHECK (status IN ('expected', 'receiving', 'received', 'closed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "warehouse_bins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid,
	"code" text NOT NULL,
	"barcode" text,
	"capacity" integer,
	"pickable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_bins_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "warehouse_bins_status_chk" CHECK (status IN ('active', 'inactive', 'blocked')),
	CONSTRAINT "warehouse_bins_capacity_chk" CHECK (capacity IS NULL OR capacity >= 0)
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'storage' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_locations_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "warehouse_locations_type_chk" CHECK (type IN ('receiving', 'storage', 'packing', 'dispatch', 'returns', 'quarantine')),
	CONSTRAINT "warehouse_locations_status_chk" CHECK (status IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "warehouse_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_members_role_chk" CHECK (role IN ('manager', 'picker', 'packer', 'receiver', 'dispatcher', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "fulfillment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"pick_task_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" jsonb,
	"raised_by" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_exceptions_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "fulfillment_exceptions_kind_chk" CHECK (kind IN ('pick_short', 'damaged', 'wrong_item', 'pack_issue', 'insufficient_stock', 'address_issue', 'ndr', 'rto', 'other')),
	CONSTRAINT "fulfillment_exceptions_status_chk" CHECK (status IN ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "fulfillment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"picked_quantity" integer DEFAULT 0 NOT NULL,
	"packed_quantity" integer DEFAULT 0 NOT NULL,
	"short_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_items_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "fulfillment_items_qty_chk" CHECK (quantity > 0 AND picked_quantity >= 0 AND packed_quantity >= 0 AND short_quantity >= 0 AND picked_quantity + short_quantity <= quantity AND packed_quantity <= picked_quantity)
);
--> statement-breakpoint
CREATE TABLE "fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"hold_from" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"routing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"picked_at" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillments_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "fulfillments_status_chk" CHECK (status IN ('confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered', 'on_hold', 'cancelled', 'delivery_failed', 'rto_in_transit', 'rto_received')),
	CONSTRAINT "fulfillments_priority_chk" CHECK (priority IN ('normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "package_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"fulfillment_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_items_qty_chk" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"barcode" text NOT NULL,
	"box_type" text,
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"packed_by" uuid,
	"packed_at" timestamp with time zone,
	"shipment_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "packages_status_chk" CHECK (status IN ('open', 'packed', 'shipped', 'cancelled')),
	CONSTRAINT "packages_dims_chk" CHECK ((weight_grams IS NULL OR weight_grams > 0) AND (length_mm IS NULL OR length_mm > 0) AND (width_mm IS NULL OR width_mm > 0) AND (height_mm IS NULL OR height_mm > 0))
);
--> statement-breakpoint
CREATE TABLE "pick_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_lists_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "pick_lists_status_chk" CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "pick_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"pick_list_id" uuid NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"fulfillment_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"bin_id" uuid,
	"sequence" integer DEFAULT 0 NOT NULL,
	"quantity" integer NOT NULL,
	"picked_quantity" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"picked_by" uuid,
	"picked_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_tasks_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "pick_tasks_status_chk" CHECK (status IN ('pending', 'partial', 'picked', 'short', 'exception', 'cancelled')),
	CONSTRAINT "pick_tasks_qty_chk" CHECK (quantity > 0 AND picked_quantity >= 0 AND picked_quantity <= quantity)
);
--> statement-breakpoint
CREATE TABLE "manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"provider_ref" text,
	"document_key" text,
	"closed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifests_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "manifests_status_chk" CHECK (status IN ('open', 'closed', 'dispatched', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "ndr_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"status" text DEFAULT 'open' NOT NULL,
	"action" text,
	"action_by" text,
	"next_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ndr_cases_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "ndr_cases_status_chk" CHECK (status IN ('open', 'action_requested', 'resolved', 'rto'))
);
--> statement-breakpoint
CREATE TABLE "shipment_tracking_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"raw_status" text,
	"location" text,
	"note" text,
	"provider_event_id" text NOT NULL,
	"source" text DEFAULT 'provider' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_tracking_events_status_chk" CHECK (status IN ('created', 'label_ready', 'manifested', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'rto_in_transit', 'rto_delivered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"service" text,
	"carrier" text,
	"awb" text,
	"tracking_url" text,
	"label_key" text,
	"status" text DEFAULT 'created' NOT NULL,
	"cost_minor" bigint,
	"cod_amount_minor" bigint,
	"weight_grams" integer,
	"manifest_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"is_rto" boolean DEFAULT false NOT NULL,
	"estimated_delivery_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"rto_delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_tracked_at" timestamp with time zone,
	"provider_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "shipments_status_chk" CHECK (status IN ('created', 'label_ready', 'manifested', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'rto_in_transit', 'rto_delivered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "vendor_shipping_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_shipping_providers_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "vendor_shipping_providers_status_chk" CHECK (status IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "order_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"initiator" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"order_status_at_request" text NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"released_units" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_cancellations_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "order_cancellations_initiator_chk" CHECK (initiator IN ('customer', 'seller', 'marketplace', 'system')),
	CONSTRAINT "order_cancellations_status_chk" CHECK (status IN ('requested', 'accepted', 'rejected', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "return_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"return_order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"return_order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"quantity" integer NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"dispositioned_quantity" integer DEFAULT 0 NOT NULL,
	"restocked_quantity" integer DEFAULT 0 NOT NULL,
	"condition" text,
	"disposition" text,
	"inspected_by" text,
	"inspected_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_items_qty_chk" CHECK (quantity > 0 AND received_quantity >= 0 AND received_quantity <= quantity AND dispositioned_quantity >= 0 AND dispositioned_quantity <= received_quantity AND restocked_quantity >= 0 AND restocked_quantity <= dispositioned_quantity),
	CONSTRAINT "return_items_condition_chk" CHECK (condition IS NULL OR condition IN ('sellable', 'damaged', 'defective', 'wrong_item', 'missing')),
	CONSTRAINT "return_items_disposition_chk" CHECK (disposition IS NULL OR disposition IN ('restock', 'damaged', 'dispose', 'return_to_vendor', 'quarantine'))
);
--> statement-breakpoint
CREATE TABLE "return_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"source" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"marketplace_return_id" text,
	"shipment_id" uuid,
	"pickup_status" text DEFAULT 'not_required' NOT NULL,
	"pickup_awb" text,
	"pickup_scheduled_at" timestamp with time zone,
	"refund_status" text DEFAULT 'not_applicable' NOT NULL,
	"refund_amount_minor" bigint,
	"refund_reference" text,
	"refunded_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_orders_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "return_orders_source_chk" CHECK (source IN ('customer', 'marketplace', 'rto', 'seller')),
	CONSTRAINT "return_orders_status_chk" CHECK (status IN ('requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'in_transit', 'received', 'inspecting', 'completed', 'cancelled')),
	CONSTRAINT "return_orders_pickup_chk" CHECK (pickup_status IN ('not_required', 'requested', 'scheduled', 'picked_up', 'failed')),
	CONSTRAINT "return_orders_refund_chk" CHECK (refund_status IN ('not_applicable', 'pending', 'processed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "business_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"exclusive" boolean DEFAULT false NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_rules_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "business_rules_type_chk" CHECK (type IN ('pricing', 'stock', 'marketplace', 'fulfillment', 'notification')),
	CONSTRAINT "business_rules_status_chk" CHECK (status IN ('draft', 'active', 'disabled')),
	CONSTRAINT "business_rules_window_chk" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_platform_chk" CHECK (platform IN ('ios', 'android', 'web', 'expo'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"price_minor" bigint,
	"mrp_minor" bigint,
	"sale_price_minor" bigint,
	"sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"applied_price_minor" bigint,
	"applied_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_prices_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "marketplace_prices_amounts_chk" CHECK ((price_minor IS NULL OR price_minor > 0) AND (mrp_minor IS NULL OR mrp_minor > 0) AND (sale_price_minor IS NULL OR sale_price_minor > 0)),
	CONSTRAINT "marketplace_prices_window_chk" CHECK (sale_starts_at IS NULL OR sale_ends_at IS NULL OR sale_ends_at > sale_starts_at),
	CONSTRAINT "marketplace_prices_source_chk" CHECK (source IN ('manual', 'rule', 'bulk', 'catalog', 'schedule', 'import'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_chk" CHECK (channel IN ('in_app', 'email', 'push')),
	CONSTRAINT "notification_deliveries_status_chk" CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"push" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" text,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "notifications_severity_chk" CHECK (severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"marketplace_account_id" uuid,
	"field" text NOT NULL,
	"old_price_minor" bigint,
	"new_price_minor" bigint,
	"source" text NOT NULL,
	"rule_id" uuid,
	"batch_id" text,
	"reason" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_history_field_chk" CHECK (field IN ('base', 'mrp', 'marketplace', 'sale')),
	CONSTRAINT "price_history_source_chk" CHECK (source IN ('manual', 'rule', 'bulk', 'catalog', 'schedule', 'import'))
);
--> statement-breakpoint
CREATE TABLE "rule_executions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_type_chk";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "source" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "bin_stock" ADD CONSTRAINT "bin_stock_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_stock" ADD CONSTRAINT "bin_stock_bin_fk" FOREIGN KEY ("vendor_id","bin_id") REFERENCES "public"."warehouse_bins"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bin_stock" ADD CONSTRAINT "bin_stock_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_shipment_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_shipment_items_inbound_fk" FOREIGN KEY ("vendor_id","inbound_id") REFERENCES "public"."inbound_shipments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_shipment_items_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_shipment_items_bin_fk" FOREIGN KEY ("vendor_id","bin_id") REFERENCES "public"."warehouse_bins"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_location_fk" FOREIGN KEY ("vendor_id","location_id") REFERENCES "public"."warehouse_locations"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_members" ADD CONSTRAINT "warehouse_members_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_members" ADD CONSTRAINT "warehouse_members_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_members" ADD CONSTRAINT "warehouse_members_user_fk" FOREIGN KEY ("vendor_id","user_id") REFERENCES "public"."users"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_events" ADD CONSTRAINT "fulfillment_events_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_events" ADD CONSTRAINT "fulfillment_events_fulfillment_fk" FOREIGN KEY ("vendor_id","fulfillment_id") REFERENCES "public"."fulfillments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_fulfillment_fk" FOREIGN KEY ("vendor_id","fulfillment_id") REFERENCES "public"."fulfillments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_fulfillment_fk" FOREIGN KEY ("vendor_id","fulfillment_id") REFERENCES "public"."fulfillments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_order_item_fk" FOREIGN KEY ("vendor_id","order_item_id") REFERENCES "public"."order_items"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_package_fk" FOREIGN KEY ("vendor_id","package_id") REFERENCES "public"."packages"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_item_fk" FOREIGN KEY ("vendor_id","fulfillment_item_id") REFERENCES "public"."fulfillment_items"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_fulfillment_fk" FOREIGN KEY ("vendor_id","fulfillment_id") REFERENCES "public"."fulfillments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_tasks" ADD CONSTRAINT "pick_tasks_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_tasks" ADD CONSTRAINT "pick_tasks_list_fk" FOREIGN KEY ("vendor_id","pick_list_id") REFERENCES "public"."pick_lists"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_tasks" ADD CONSTRAINT "pick_tasks_fulfillment_fk" FOREIGN KEY ("vendor_id","fulfillment_id") REFERENCES "public"."fulfillments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_tasks" ADD CONSTRAINT "pick_tasks_item_fk" FOREIGN KEY ("vendor_id","fulfillment_item_id") REFERENCES "public"."fulfillment_items"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_tasks" ADD CONSTRAINT "pick_tasks_bin_fk" FOREIGN KEY ("vendor_id","bin_id") REFERENCES "public"."warehouse_bins"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ndr_cases" ADD CONSTRAINT "ndr_cases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ndr_cases" ADD CONSTRAINT "ndr_cases_shipment_fk" FOREIGN KEY ("vendor_id","shipment_id") REFERENCES "public"."shipments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_shipment_fk" FOREIGN KEY ("vendor_id","shipment_id") REFERENCES "public"."shipments"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_fulfillment_fk" FOREIGN KEY ("vendor_id","fulfillment_id") REFERENCES "public"."fulfillments"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_manifest_fk" FOREIGN KEY ("vendor_id","manifest_id") REFERENCES "public"."manifests"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_shipping_providers" ADD CONSTRAINT "vendor_shipping_providers_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cancellations" ADD CONSTRAINT "order_cancellations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cancellations" ADD CONSTRAINT "order_cancellations_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_return_fk" FOREIGN KEY ("vendor_id","return_order_id") REFERENCES "public"."return_orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_fk" FOREIGN KEY ("vendor_id","return_order_id") REFERENCES "public"."return_orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_fk" FOREIGN KEY ("vendor_id","order_item_id") REFERENCES "public"."order_items"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rules" ADD CONSTRAINT "business_rules_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_fk" FOREIGN KEY ("vendor_id","user_id") REFERENCES "public"."users"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_prices" ADD CONSTRAINT "marketplace_prices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_prices" ADD CONSTRAINT "marketplace_prices_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_prices" ADD CONSTRAINT "marketplace_prices_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_fk" FOREIGN KEY ("vendor_id","notification_id") REFERENCES "public"."notifications"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_fk" FOREIGN KEY ("vendor_id","user_id") REFERENCES "public"."users"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_fk" FOREIGN KEY ("vendor_id","user_id") REFERENCES "public"."users"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_rule_fk" FOREIGN KEY ("vendor_id","rule_id") REFERENCES "public"."business_rules"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bin_stock_uq" ON "bin_stock" USING btree ("bin_id","variant_id");--> statement-breakpoint
CREATE INDEX "bin_stock_vendor_variant_idx" ON "bin_stock" USING btree ("vendor_id","variant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_shipment_items_uq" ON "inbound_shipment_items" USING btree ("inbound_id","variant_id");--> statement-breakpoint
CREATE INDEX "inbound_shipment_items_vendor_idx" ON "inbound_shipment_items" USING btree ("vendor_id","inbound_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_shipments_number_uq" ON "inbound_shipments" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE INDEX "inbound_shipments_vendor_status_idx" ON "inbound_shipments" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_bins_code_uq" ON "warehouse_bins" USING btree ("warehouse_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_bins_barcode_uq" ON "warehouse_bins" USING btree ("vendor_id","barcode") WHERE "warehouse_bins"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "warehouse_bins_vendor_wh_idx" ON "warehouse_bins" USING btree ("vendor_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_locations_code_uq" ON "warehouse_locations" USING btree ("warehouse_id","code");--> statement-breakpoint
CREATE INDEX "warehouse_locations_vendor_wh_idx" ON "warehouse_locations" USING btree ("vendor_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_members_uq" ON "warehouse_members" USING btree ("warehouse_id","user_id");--> statement-breakpoint
CREATE INDEX "warehouse_members_vendor_user_idx" ON "warehouse_members" USING btree ("vendor_id","user_id");--> statement-breakpoint
CREATE INDEX "fulfillment_events_vendor_idx" ON "fulfillment_events" USING btree ("vendor_id","fulfillment_id","id");--> statement-breakpoint
CREATE INDEX "fulfillment_exceptions_vendor_status_idx" ON "fulfillment_exceptions" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fulfillment_exceptions_vendor_fulfillment_idx" ON "fulfillment_exceptions" USING btree ("vendor_id","fulfillment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_items_uq" ON "fulfillment_items" USING btree ("fulfillment_id","order_item_id");--> statement-breakpoint
CREATE INDEX "fulfillment_items_vendor_fulfillment_idx" ON "fulfillment_items" USING btree ("vendor_id","fulfillment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillments_number_uq" ON "fulfillments" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillments_order_warehouse_uq" ON "fulfillments" USING btree ("order_id","warehouse_id") WHERE "fulfillments"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "fulfillments_vendor_status_idx" ON "fulfillments" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fulfillments_vendor_order_idx" ON "fulfillments" USING btree ("vendor_id","order_id");--> statement-breakpoint
CREATE INDEX "fulfillments_vendor_warehouse_idx" ON "fulfillments" USING btree ("vendor_id","warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "package_items_uq" ON "package_items" USING btree ("package_id","fulfillment_item_id");--> statement-breakpoint
CREATE INDEX "package_items_vendor_package_idx" ON "package_items" USING btree ("vendor_id","package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_number_uq" ON "packages" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_barcode_uq" ON "packages" USING btree ("vendor_id","barcode");--> statement-breakpoint
CREATE INDEX "packages_vendor_fulfillment_idx" ON "packages" USING btree ("vendor_id","fulfillment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pick_lists_number_uq" ON "pick_lists" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE INDEX "pick_lists_vendor_status_idx" ON "pick_lists" USING btree ("vendor_id","warehouse_id","status");--> statement-breakpoint
CREATE INDEX "pick_tasks_vendor_list_idx" ON "pick_tasks" USING btree ("vendor_id","pick_list_id","sequence");--> statement-breakpoint
CREATE INDEX "pick_tasks_vendor_fulfillment_idx" ON "pick_tasks" USING btree ("vendor_id","fulfillment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "manifests_number_uq" ON "manifests" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE INDEX "manifests_vendor_status_idx" ON "manifests" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ndr_cases_attempt_uq" ON "ndr_cases" USING btree ("shipment_id","attempt_no");--> statement-breakpoint
CREATE INDEX "ndr_cases_vendor_status_idx" ON "ndr_cases" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_tracking_events_uq" ON "shipment_tracking_events" USING btree ("shipment_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "shipment_tracking_events_vendor_idx" ON "shipment_tracking_events" USING btree ("vendor_id","shipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_number_uq" ON "shipments" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_provider_awb_uq" ON "shipments" USING btree ("vendor_id","provider_code","awb") WHERE "shipments"."awb" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_vendor_warehouse_idx" ON "shipments" USING btree ("vendor_id","warehouse_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_active_fulfillment_uq" ON "shipments" USING btree ("fulfillment_id") WHERE "shipments"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "shipments_vendor_status_idx" ON "shipments" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipments_vendor_order_idx" ON "shipments" USING btree ("vendor_id","order_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("status","last_tracked_at") WHERE "shipments"."status" IN ('dispatched','in_transit','out_for_delivery','delivery_failed','rto_initiated','rto_in_transit');--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_shipping_providers_uq" ON "vendor_shipping_providers" USING btree ("vendor_id","provider_code");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_shipping_providers_default_uq" ON "vendor_shipping_providers" USING btree ("vendor_id") WHERE "vendor_shipping_providers"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "order_cancellations_open_uq" ON "order_cancellations" USING btree ("order_id") WHERE "order_cancellations"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "order_cancellations_vendor_order_idx" ON "order_cancellations" USING btree ("vendor_id","order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "return_events_vendor_idx" ON "return_events" USING btree ("vendor_id","return_order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_items_uq" ON "return_items" USING btree ("return_order_id","order_item_id");--> statement-breakpoint
CREATE INDEX "return_items_vendor_return_idx" ON "return_items" USING btree ("vendor_id","return_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_orders_number_uq" ON "return_orders" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "return_orders_marketplace_uq" ON "return_orders" USING btree ("vendor_id","marketplace_return_id") WHERE "return_orders"."marketplace_return_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "return_orders_shipment_uq" ON "return_orders" USING btree ("vendor_id","shipment_id") WHERE "return_orders"."shipment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "return_orders_vendor_status_idx" ON "return_orders" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "return_orders_vendor_order_idx" ON "return_orders" USING btree ("vendor_id","order_id");--> statement-breakpoint
CREATE INDEX "return_orders_vendor_warehouse_idx" ON "return_orders" USING btree ("vendor_id","warehouse_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "business_rules_vendor_type_idx" ON "business_rules" USING btree ("vendor_id","type","status","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_uq" ON "device_tokens" USING btree ("vendor_id","token");--> statement-breakpoint
CREATE INDEX "device_tokens_vendor_user_idx" ON "device_tokens" USING btree ("vendor_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_prices_uq" ON "marketplace_prices" USING btree ("marketplace_account_id","variant_id");--> statement-breakpoint
CREATE INDEX "marketplace_prices_vendor_variant_idx" ON "marketplace_prices" USING btree ("vendor_id","variant_id");--> statement-breakpoint
CREATE INDEX "marketplace_prices_sale_idx" ON "marketplace_prices" USING btree ("sale_starts_at","sale_ends_at") WHERE "marketplace_prices"."sale_price_minor" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_uq" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notification_deliveries_vendor_idx" ON "notification_deliveries" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_uq" ON "notification_preferences" USING btree ("vendor_id","user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("vendor_id","user_id","dedupe_key") WHERE "notifications"."dedupe_key" IS NOT NULL AND "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_vendor_user_idx" ON "notifications" USING btree ("vendor_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("vendor_id","user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "price_history_vendor_variant_idx" ON "price_history" USING btree ("vendor_id","variant_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_history_vendor_batch_idx" ON "price_history" USING btree ("vendor_id","batch_id");--> statement-breakpoint
CREATE INDEX "rule_executions_vendor_rule_idx" ON "rule_executions" USING btree ("vendor_id","rule_id","id");--> statement-breakpoint
CREATE INDEX "rule_executions_vendor_entity_idx" ON "rule_executions" USING btree ("vendor_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "orders_vendor_warehouse_idx" ON "orders" USING btree ("vendor_id","warehouse_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_type_chk" CHECK (type IN ('orders', 'inventory', 'prices', 'listings', 'listing_publish', 'listing_status', 'catalog_import', 'order_status', 'returns', 'tracking', 'full'));