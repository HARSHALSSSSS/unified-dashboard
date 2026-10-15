-- Extensions required by the schema (trigram search on product titles).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"vendor_id" uuid,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"vendor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid,
	"user_type" text DEFAULT 'vendor' NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"full_name" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "users_status_chk" CHECK (status IN ('invited', 'active', 'disabled')),
	CONSTRAINT "users_type_chk" CHECK ((user_type = 'platform' AND vendor_id IS NULL) OR (user_type = 'vendor' AND vendor_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vendors_status_chk" CHECK (status IN ('pending', 'active', 'suspended', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"attribute_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "categories_vendor_id_id_uq" UNIQUE("vendor_id","id")
);
--> statement-breakpoint
CREATE TABLE "product_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"kind" text DEFAULT 'image' NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint,
	"checksum_sha256" text,
	"width" integer,
	"height" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending_upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_documents_kind_chk" CHECK (kind IN ('image', 'document', 'video')),
	CONSTRAINT "product_documents_status_chk" CHECK (status IN ('pending_upload', 'uploaded', 'processed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"option_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"mrp_minor" bigint,
	"selling_price_minor" bigint,
	"cost_price_minor" bigint,
	"tax_rate_bps" integer,
	"weight_grams" integer,
	"dimensions_mm" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_variants_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "product_variants_status_chk" CHECK (status IN ('active', 'inactive')),
	CONSTRAINT "product_variants_price_chk" CHECK ((mrp_minor IS NULL OR mrp_minor >= 0) AND (selling_price_minor IS NULL OR selling_price_minor >= 0))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"brand" text,
	"category_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "products_status_chk" CHECK (status IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"display_name" text NOT NULL,
	"external_account_id" text,
	"region" text DEFAULT 'IN' NOT NULL,
	"status" text DEFAULT 'pending_authorization' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_accounts_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "marketplace_accounts_marketplace_chk" CHECK (marketplace IN ('amazon_in', 'flipkart', 'myntra', 'snapdeal')),
	CONSTRAINT "marketplace_accounts_status_chk" CHECK (status IN ('pending_authorization', 'active', 'paused', 'error', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"auth_type" text NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_authorizations_status_chk" CHECK (status IN ('active', 'expiring', 'expired', 'revoked', 'error'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"external_listing_id" text,
	"external_sku" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"price_minor" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_hash" text,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_listings_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "marketplace_listings_status_chk" CHECK (status IN ('draft', 'pending', 'live', 'inactive', 'error', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_qty_chk" CHECK (quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"external_item_id" text NOT NULL,
	"variant_id" uuid,
	"listing_id" uuid,
	"sku" text NOT NULL,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_chk" CHECK (quantity > 0),
	CONSTRAINT "order_items_status_chk" CHECK (status IN ('new', 'allocated', 'shipped', 'delivered', 'cancelled', 'returned'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"external_order_id" text NOT NULL,
	"order_number" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"shipping_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"buyer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shipping_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_payload" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "orders_status_chk" CHECK (status IN ('new', 'confirmed', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'returned'))
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "warehouses_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "warehouses_status_chk" CHECK (status IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"on_behalf_of_vendor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_chk" CHECK (actor_type IN ('user', 'api_key', 'system', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_id" uuid,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"idempotency_key" text NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cursor" jsonb,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"queue_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_jobs_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "sync_jobs_type_chk" CHECK (type IN ('orders', 'inventory', 'prices', 'listings', 'returns', 'full')),
	CONSTRAINT "sync_jobs_status_chk" CHECK (status IN ('queued', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled')),
	CONSTRAINT "sync_jobs_trigger_chk" CHECK (trigger IN ('schedule', 'manual', 'webhook', 'event', 'system'))
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vendor_id" uuid NOT NULL,
	"sync_job_id" uuid NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_logs_level_chk" CHECK (level IN ('debug', 'info', 'warn', 'error'))
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("vendor_id","parent_id") REFERENCES "public"."categories"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_product_fk" FOREIGN KEY ("vendor_id","product_id") REFERENCES "public"."products"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("vendor_id","product_id") REFERENCES "public"."products"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("vendor_id","category_id") REFERENCES "public"."categories"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_authorizations" ADD CONSTRAINT "marketplace_authorizations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_authorizations" ADD CONSTRAINT "marketplace_authorizations_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_warehouse_fk" FOREIGN KEY ("vendor_id","warehouse_id") REFERENCES "public"."warehouses"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_listing_fk" FOREIGN KEY ("vendor_id","listing_id") REFERENCES "public"."marketplace_listings"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_job_fk" FOREIGN KEY ("vendor_id","sync_job_id") REFERENCES "public"."sync_jobs"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_vendor_key_uq" ON "roles" USING btree (coalesce("vendor_id", '00000000-0000-0000-0000-000000000000'::uuid),"key");--> statement-breakpoint
CREATE INDEX "user_roles_vendor_idx" ON "user_roles" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email")) WHERE "users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_vendor_idx" ON "users" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_slug_uq" ON "vendors" USING btree ("slug") WHERE "vendors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_vendor_slug_uq" ON "categories" USING btree ("vendor_id","slug") WHERE "categories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "categories_vendor_parent_idx" ON "categories" USING btree ("vendor_id","parent_id");--> statement-breakpoint
CREATE INDEX "categories_vendor_path_idx" ON "categories" USING btree ("vendor_id","path" text_pattern_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "product_documents_storage_key_uq" ON "product_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "product_documents_vendor_product_idx" ON "product_documents" USING btree ("vendor_id","product_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_documents_primary_uq" ON "product_documents" USING btree ("vendor_id","product_id") WHERE "product_documents"."is_primary" AND "product_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_vendor_sku_uq" ON "product_variants" USING btree ("vendor_id","sku") WHERE "product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "product_variants_vendor_product_idx" ON "product_variants" USING btree ("vendor_id","product_id");--> statement-breakpoint
CREATE INDEX "product_variants_vendor_barcode_idx" ON "product_variants" USING btree ("vendor_id","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "products_vendor_code_uq" ON "products" USING btree ("vendor_id","product_code") WHERE "products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "products_vendor_status_idx" ON "products" USING btree ("vendor_id","status","id");--> statement-breakpoint
CREATE INDEX "products_vendor_category_idx" ON "products" USING btree ("vendor_id","category_id");--> statement-breakpoint
CREATE INDEX "products_vendor_created_idx" ON "products" USING btree ("vendor_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "products_title_trgm_idx" ON "products" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_accounts_external_uq" ON "marketplace_accounts" USING btree ("vendor_id","marketplace","external_account_id") WHERE "marketplace_accounts"."external_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "marketplace_accounts_vendor_idx" ON "marketplace_accounts" USING btree ("vendor_id","marketplace");--> statement-breakpoint
CREATE INDEX "marketplace_accounts_status_idx" ON "marketplace_accounts" USING btree ("status","marketplace");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_authorizations_account_uq" ON "marketplace_authorizations" USING btree ("marketplace_account_id");--> statement-breakpoint
CREATE INDEX "marketplace_authorizations_vendor_idx" ON "marketplace_authorizations" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "marketplace_authorizations_expiry_idx" ON "marketplace_authorizations" USING btree ("access_token_expires_at") WHERE "marketplace_authorizations"."status" IN ('active','expiring');--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listings_account_ext_id_uq" ON "marketplace_listings" USING btree ("marketplace_account_id","external_listing_id") WHERE "marketplace_listings"."external_listing_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listings_account_sku_uq" ON "marketplace_listings" USING btree ("marketplace_account_id","external_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listings_account_variant_uq" ON "marketplace_listings" USING btree ("marketplace_account_id","variant_id");--> statement-breakpoint
CREATE INDEX "marketplace_listings_vendor_variant_idx" ON "marketplace_listings" USING btree ("vendor_id","variant_id");--> statement-breakpoint
CREATE INDEX "marketplace_listings_vendor_status_idx" ON "marketplace_listings" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_variant_warehouse_uq" ON "inventory" USING btree ("vendor_id","variant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_vendor_warehouse_idx" ON "inventory" USING btree ("vendor_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_external_uq" ON "order_items" USING btree ("order_id","external_item_id");--> statement-breakpoint
CREATE INDEX "order_items_vendor_order_idx" ON "order_items" USING btree ("vendor_id","order_id");--> statement-breakpoint
CREATE INDEX "order_items_vendor_variant_idx" ON "order_items" USING btree ("vendor_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_account_external_uq" ON "orders" USING btree ("marketplace_account_id","external_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_vendor_number_uq" ON "orders" USING btree ("vendor_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_vendor_status_placed_idx" ON "orders" USING btree ("vendor_id","status","placed_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "orders_vendor_placed_idx" ON "orders" USING btree ("vendor_id","placed_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_vendor_code_uq" ON "warehouses" USING btree ("vendor_id","code") WHERE "warehouses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_default_uq" ON "warehouses" USING btree ("vendor_id") WHERE "warehouses"."is_default" AND "warehouses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_vendor_created_idx" ON "audit_logs" USING btree ("vendor_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("vendor_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("vendor_id","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_request_idx" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_uq" ON "idempotency_keys" USING btree (coalesce("vendor_id", '00000000-0000-0000-0000-000000000000'::uuid),"scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("occurred_at") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_vendor_idx" ON "outbox_events" USING btree ("vendor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_vendor_idem_uq" ON "sync_jobs" USING btree ("vendor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sync_jobs_vendor_account_idx" ON "sync_jobs" USING btree ("vendor_id","marketplace_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs" USING btree ("status","scheduled_at") WHERE "sync_jobs"."status" IN ('queued','running');--> statement-breakpoint
CREATE INDEX "sync_logs_job_idx" ON "sync_logs" USING btree ("vendor_id","sync_job_id","id");--> statement-breakpoint
CREATE INDEX "sync_logs_created_idx" ON "sync_logs" USING btree ("created_at");