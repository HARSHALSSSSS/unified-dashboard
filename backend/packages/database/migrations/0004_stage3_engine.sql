CREATE TABLE "attribute_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"marketplace_category_id" text NOT NULL,
	"marketplace_attribute" text NOT NULL,
	"source_type" text NOT NULL,
	"core_field" text,
	"attribute_id" uuid,
	"static_value" text,
	"value_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_mappings_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "attribute_mappings_source_chk" CHECK (source_type IN ('core_field', 'attribute', 'static')),
	CONSTRAINT "attribute_mappings_shape_chk" CHECK ((source_type = 'core_field' AND core_field IS NOT NULL) OR (source_type = 'attribute' AND attribute_id IS NOT NULL) OR (source_type = 'static' AND static_value IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "category_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"category_id" uuid NOT NULL,
	"marketplace_category_id" text NOT NULL,
	"marketplace_category_name" text,
	"marketplace_category_path" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_mappings_vendor_id_id_uq" UNIQUE("vendor_id","id")
);
--> statement-breakpoint
CREATE TABLE "channel_inventory_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"mode" text DEFAULT 'sync' NOT NULL,
	"safety_buffer" integer DEFAULT 0 NOT NULL,
	"allocation_percent" integer DEFAULT 100 NOT NULL,
	"max_quantity" integer,
	"warehouse_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_inventory_policies_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "channel_inventory_policies_mode_chk" CHECK (mode IN ('sync', 'paused')),
	CONSTRAINT "channel_inventory_policies_range_chk" CHECK (safety_buffer >= 0 AND allocation_percent BETWEEN 0 AND 100 AND (max_quantity IS NULL OR max_quantity >= 0))
);
--> statement-breakpoint
CREATE TABLE "channel_stock_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"sync_job_id" uuid,
	"external_sku" text NOT NULL,
	"available_quantity" integer NOT NULL,
	"requested_quantity" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_stock_updates_status_chk" CHECK (status IN ('pending', 'sent', 'succeeded', 'failed')),
	CONSTRAINT "channel_stock_updates_qty_chk" CHECK (available_quantity >= 0 AND requested_quantity >= 0)
);
--> statement-breakpoint
CREATE TABLE "imported_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"external_listing_id" text NOT NULL,
	"external_sku" text NOT NULL,
	"title" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"raw" jsonb,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"variant_id" uuid,
	"listing_id" uuid,
	"sync_job_id" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_products_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "imported_products_status_chk" CHECK (status IN ('new', 'linked', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"deliveries" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "webhook_events_status_chk" CHECK (status IN ('received', 'processing', 'processed', 'failed', 'dead_lettered', 'ignored', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"type" text NOT NULL,
	"delta_on_hand" integer DEFAULT 0 NOT NULL,
	"delta_reserved" integer DEFAULT 0 NOT NULL,
	"delta_incoming" integer DEFAULT 0 NOT NULL,
	"delta_damaged" integer DEFAULT 0 NOT NULL,
	"delta_returned" integer DEFAULT 0 NOT NULL,
	"on_hand_after" integer NOT NULL,
	"reserved_after" integer NOT NULL,
	"reason" text,
	"reference_type" text,
	"reference_id" text,
	"idempotency_key" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_type_chk" CHECK (type IN ('receive', 'adjust', 'reserve', 'release', 'commit', 'return_in', 'return_restock', 'damage', 'undamage', 'incoming_add', 'incoming_receive', 'transfer_out', 'transfer_in', 'count')),
	CONSTRAINT "inventory_movements_nonzero_chk" CHECK (delta_on_hand <> 0 OR delta_reserved <> 0 OR delta_incoming <> 0 OR delta_damaged <> 0 OR delta_returned <> 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"released_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "inventory_reservations_qty_chk" CHECK (quantity > 0),
	CONSTRAINT "inventory_reservations_status_chk" CHECK (status IN ('active', 'committed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_items_qty_chk" CHECK (quantity > 0 AND received_quantity >= 0 AND received_quantity <= quantity)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"from_warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"shipped_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "stock_transfers_status_chk" CHECK (status IN ('draft', 'in_transit', 'received', 'cancelled')),
	CONSTRAINT "stock_transfers_distinct_chk" CHECK (from_warehouse_id <> to_warehouse_id)
);
--> statement-breakpoint
CREATE TABLE "vendor_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"marketplace_status" text,
	"source" text NOT NULL,
	"applied" boolean DEFAULT true NOT NULL,
	"note" text,
	"actor_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_status_events_source_chk" CHECK (source IN ('marketplace', 'user', 'system', 'webhook', 'sync'))
);
--> statement-breakpoint
CREATE TABLE "order_status_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"requested_status" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"marketplace_status" text,
	"error_code" text,
	"error_message" text,
	"tracking" jsonb,
	"sync_job_id" uuid,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_status_updates_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "order_status_updates_status_chk" CHECK (status IN ('requested', 'sent', 'successful', 'failed', 'retrying', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "marketplace_listings" DROP CONSTRAINT "marketplace_listings_status_chk";--> statement-breakpoint
ALTER TABLE "inventory" DROP CONSTRAINT "inventory_qty_chk";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_qty_chk";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_chk";--> statement-breakpoint
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_type_chk";--> statement-breakpoint
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_status_chk";--> statement-breakpoint
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_trigger_chk";--> statement-breakpoint
DROP INDEX "sync_jobs_status_idx";--> statement-breakpoint
-- remap existing rows to the Stage 3 vocabularies BEFORE the new CHECK constraints are added.
-- (tables use FORCE ROW LEVEL SECURITY: run the data fixes in system scope, then clear it)
SELECT set_config('app.scope', 'system', false);--> statement-breakpoint
UPDATE "marketplace_listings" SET "status" = CASE "status" WHEN 'live' THEN 'active' WHEN 'inactive' THEN 'unpublished' WHEN 'suppressed' THEN 'unpublished' WHEN 'error' THEN 'rejected' ELSE "status" END;--> statement-breakpoint
UPDATE "orders" SET "status" = CASE "status" WHEN 'ready_to_ship' THEN 'ready_to_dispatch' WHEN 'shipped' THEN 'dispatched' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_vendor_id_id_uq" UNIQUE("vendor_id","id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_vendor_id_id_uq" UNIQUE("vendor_id","id");--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "webhook_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "webhook_secret_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "source" text DEFAULT 'created' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "external_status" text;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "marketplace_category_id" text;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "attribute_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "validation" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "approved_hash" text;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "mrp_minor" bigint;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "buffer_override" integer;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "max_quantity_override" integer;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "sellable_quantity" integer;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "pushed_quantity" integer;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "quantity_dirty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "quantity_dirty_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD COLUMN "quantity_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "quantity_incoming" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "quantity_damaged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "quantity_returned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "reserved_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "external_listing_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "marketplace" text;--> statement-breakpoint
UPDATE "orders" o SET "marketplace" = a."marketplace" FROM "marketplace_accounts" a WHERE a."id" = o."marketplace_account_id";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "marketplace" SET NOT NULL;--> statement-breakpoint
SELECT set_config('app.scope', '', false);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "marketplace_status" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cod_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "inventory_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attention_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "carrier" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "last_marketplace_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "progress" jsonb DEFAULT '{"total":0,"done":0,"failed":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "failure_details" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "attribute_mappings" ADD CONSTRAINT "attribute_mappings_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_mappings" ADD CONSTRAINT "attribute_mappings_attribute_fk" FOREIGN KEY ("vendor_id","attribute_id") REFERENCES "public"."attribute_definitions"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_category_fk" FOREIGN KEY ("vendor_id","category_id") REFERENCES "public"."categories"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_inventory_policies" ADD CONSTRAINT "channel_inventory_policies_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_inventory_policies" ADD CONSTRAINT "channel_inventory_policies_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stock_updates" ADD CONSTRAINT "channel_stock_updates_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stock_updates" ADD CONSTRAINT "channel_stock_updates_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stock_updates" ADD CONSTRAINT "channel_stock_updates_listing_fk" FOREIGN KEY ("vendor_id","listing_id") REFERENCES "public"."marketplace_listings"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stock_updates" ADD CONSTRAINT "channel_stock_updates_job_fk" FOREIGN KEY ("vendor_id","sync_job_id") REFERENCES "public"."sync_jobs"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_products" ADD CONSTRAINT "imported_products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_products" ADD CONSTRAINT "imported_products_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_products" ADD CONSTRAINT "imported_products_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_products" ADD CONSTRAINT "imported_products_listing_fk" FOREIGN KEY ("vendor_id","listing_id") REFERENCES "public"."marketplace_listings"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_item_fk" FOREIGN KEY ("vendor_id","order_item_id") REFERENCES "public"."order_items"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_fk" FOREIGN KEY ("vendor_id","transfer_id") REFERENCES "public"."stock_transfers"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_fk" FOREIGN KEY ("vendor_id","from_warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_fk" FOREIGN KEY ("vendor_id","to_warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_counters" ADD CONSTRAINT "vendor_counters_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_updates" ADD CONSTRAINT "order_status_updates_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_updates" ADD CONSTRAINT "order_status_updates_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_updates" ADD CONSTRAINT "order_status_updates_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_updates" ADD CONSTRAINT "order_status_updates_job_fk" FOREIGN KEY ("vendor_id","sync_job_id") REFERENCES "public"."sync_jobs"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_mappings_uq" ON "attribute_mappings" USING btree ("vendor_id","marketplace","marketplace_category_id","marketplace_attribute");--> statement-breakpoint
CREATE INDEX "attribute_mappings_vendor_category_idx" ON "attribute_mappings" USING btree ("vendor_id","marketplace","marketplace_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "category_mappings_uq" ON "category_mappings" USING btree ("vendor_id","marketplace","category_id");--> statement-breakpoint
CREATE INDEX "category_mappings_vendor_marketplace_idx" ON "category_mappings" USING btree ("vendor_id","marketplace");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_inventory_policies_account_uq" ON "channel_inventory_policies" USING btree ("marketplace_account_id");--> statement-breakpoint
CREATE INDEX "channel_inventory_policies_vendor_idx" ON "channel_inventory_policies" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "channel_stock_updates_vendor_listing_idx" ON "channel_stock_updates" USING btree ("vendor_id","listing_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channel_stock_updates_job_idx" ON "channel_stock_updates" USING btree ("vendor_id","sync_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_products_account_sku_uq" ON "imported_products" USING btree ("marketplace_account_id","external_sku");--> statement-breakpoint
CREATE INDEX "imported_products_vendor_status_idx" ON "imported_products" USING btree ("vendor_id","status","imported_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_account_key_uq" ON "webhook_events" USING btree ("marketplace_account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_events_vendor_received_idx" ON "webhook_events" USING btree ("vendor_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_events_pending_idx" ON "webhook_events" USING btree ("status","next_retry_at") WHERE "webhook_events"."status" IN ('received','failed');--> statement-breakpoint
CREATE INDEX "inventory_movements_vendor_variant_idx" ON "inventory_movements" USING btree ("vendor_id","variant_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_movements_vendor_warehouse_idx" ON "inventory_movements" USING btree ("vendor_id","warehouse_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_movements_reference_idx" ON "inventory_movements" USING btree ("vendor_id","reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_idem_uq" ON "inventory_movements" USING btree ("vendor_id","idempotency_key") WHERE "inventory_movements"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_item_warehouse_uq" ON "inventory_reservations" USING btree ("order_item_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_vendor_order_idx" ON "inventory_reservations" USING btree ("vendor_id","order_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_vendor_variant_idx" ON "inventory_reservations" USING btree ("vendor_id","variant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_items_uq" ON "stock_transfer_items" USING btree ("transfer_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_items_vendor_transfer_idx" ON "stock_transfer_items" USING btree ("vendor_id","transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_vendor_number_uq" ON "stock_transfers" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE INDEX "stock_transfers_vendor_status_idx" ON "stock_transfers" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_counters_uq" ON "vendor_counters" USING btree ("vendor_id","name");--> statement-breakpoint
CREATE INDEX "order_status_events_vendor_order_idx" ON "order_status_events" USING btree ("vendor_id","order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_status_updates_idem_uq" ON "order_status_updates" USING btree ("vendor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "order_status_updates_vendor_order_idx" ON "order_status_updates" USING btree ("vendor_id","order_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_listings_dirty_idx" ON "marketplace_listings" USING btree ("marketplace_account_id") WHERE "marketplace_listings"."quantity_dirty";--> statement-breakpoint
CREATE INDEX "marketplace_listings_poll_idx" ON "marketplace_listings" USING btree ("marketplace_account_id","last_polled_at") WHERE "marketplace_listings"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_vendor_marketplace_external_uq" ON "orders" USING btree ("vendor_id","marketplace","external_order_id");--> statement-breakpoint
CREATE INDEX "orders_vendor_attention_idx" ON "orders" USING btree ("vendor_id","placed_at" DESC NULLS LAST) WHERE "orders"."attention_reason" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_jobs_vendor_status_idx" ON "sync_jobs" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs" USING btree ("status","scheduled_at") WHERE "sync_jobs"."status" IN ('queued','running','retrying');--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_source_chk" CHECK (source IN ('created', 'imported'));--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_override_chk" CHECK ((buffer_override IS NULL OR buffer_override >= 0) AND (max_quantity_override IS NULL OR max_quantity_override >= 0));--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_status_chk" CHECK (status IN ('draft', 'ready', 'approved', 'pending', 'active', 'rejected', 'correction_required', 'unpublished'));--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_qty_chk" CHECK (quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand AND quantity_incoming >= 0 AND quantity_damaged >= 0 AND quantity_returned >= 0);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_qty_chk" CHECK (quantity > 0 AND reserved_quantity >= 0 AND reserved_quantity <= quantity);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_method_chk" CHECK (payment_method IN ('prepaid', 'cod', 'unknown'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_inventory_status_chk" CHECK (inventory_status IN ('pending', 'reserved', 'partial', 'unallocated', 'committed', 'released'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_chk" CHECK (status IN ('new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered', 'cancelled', 'returned'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_type_chk" CHECK (type IN ('orders', 'inventory', 'prices', 'listings', 'listing_publish', 'listing_status', 'catalog_import', 'order_status', 'returns', 'full'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_status_chk" CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'partially_failed', 'failed', 'dead_lettered', 'cancelled'));--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_trigger_chk" CHECK (trigger IN ('schedule', 'manual', 'webhook', 'event', 'system', 'retry'));