CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_status_chk" CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tokens_purpose_chk" CHECK (purpose IN ('email_verification', 'password_reset'))
);
--> statement-breakpoint
CREATE TABLE "attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"data_type" text DEFAULT 'text' NOT NULL,
	"applies_to" text DEFAULT 'product' NOT NULL,
	"unit" text,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attribute_definitions_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "attribute_definitions_type_chk" CHECK (data_type IN ('text', 'number', 'boolean', 'date', 'enum')),
	CONSTRAINT "attribute_definitions_applies_chk" CHECK (applies_to IN ('product', 'variant'))
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attribute_values_vendor_id_id_uq" UNIQUE("vendor_id","id")
);
--> statement-breakpoint
CREATE TABLE "category_attributes" (
	"vendor_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_attributes_category_id_attribute_id_pk" PRIMARY KEY("category_id","attribute_id")
);
--> statement-breakpoint
CREATE TABLE "data_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity" text DEFAULT 'products' NOT NULL,
	"status" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"input_key" text,
	"output_key" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_jobs_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "data_jobs_kind_chk" CHECK (kind IN ('import', 'export')),
	CONSTRAINT "data_jobs_status_chk" CHECK (status IN ('awaiting_upload', 'queued', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "product_attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"attribute_id" uuid NOT NULL,
	"value_text" text,
	"value_number" numeric,
	"value_bool" boolean,
	"value_date" date,
	"attribute_value_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_marketplace_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketplace_accounts" DROP CONSTRAINT "marketplace_accounts_marketplace_chk";--> statement-breakpoint
DROP INDEX "product_variants_vendor_barcode_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "business_email" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "pan" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "address" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "currency" char(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "logo_key" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_documents" ADD COLUMN "purpose" text DEFAULT 'product_image' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_documents" ADD COLUMN "listing_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "manufacturer" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "country_of_origin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hsn_code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gst_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "connection_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "last_failure_message" text;--> statement-breakpoint
ALTER TABLE "marketplace_authorizations" ADD COLUMN "rotation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_fk" FOREIGN KEY ("vendor_id","attribute_id") REFERENCES "public"."attribute_definitions"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_attributes" ADD CONSTRAINT "category_attributes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_attributes" ADD CONSTRAINT "category_attributes_category_fk" FOREIGN KEY ("vendor_id","category_id") REFERENCES "public"."categories"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_attributes" ADD CONSTRAINT "category_attributes_attribute_fk" FOREIGN KEY ("vendor_id","attribute_id") REFERENCES "public"."attribute_definitions"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_jobs" ADD CONSTRAINT "data_jobs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_product_fk" FOREIGN KEY ("vendor_id","product_id") REFERENCES "public"."products"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_variant_fk" FOREIGN KEY ("vendor_id","variant_id") REFERENCES "public"."product_variants"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_attribute_fk" FOREIGN KEY ("vendor_id","attribute_id") REFERENCES "public"."attribute_definitions"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_value_fk" FOREIGN KEY ("vendor_id","attribute_value_id") REFERENCES "public"."attribute_values"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_marketplace_data" ADD CONSTRAINT "product_marketplace_data_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_marketplace_data" ADD CONSTRAINT "product_marketplace_data_product_fk" FOREIGN KEY ("vendor_id","product_id") REFERENCES "public"."products"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_hash_uq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_uq" ON "invitations" USING btree ("vendor_id",lower("email")) WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invitations_vendor_idx" ON "invitations" USING btree ("vendor_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tokens_hash_uq" ON "user_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_tokens_user_idx" ON "user_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_vendor_code_uq" ON "attribute_definitions" USING btree ("vendor_id","code") WHERE "attribute_definitions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_attr_value_uq" ON "attribute_values" USING btree ("attribute_id","value") WHERE "attribute_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "attribute_values_vendor_attr_idx" ON "attribute_values" USING btree ("vendor_id","attribute_id","sort_order");--> statement-breakpoint
CREATE INDEX "category_attributes_vendor_idx" ON "category_attributes" USING btree ("vendor_id","category_id");--> statement-breakpoint
CREATE INDEX "data_jobs_vendor_created_idx" ON "data_jobs" USING btree ("vendor_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_attribute_values_uq" ON "product_attribute_values" USING btree ("product_id",coalesce("variant_id", '00000000-0000-0000-0000-000000000000'::uuid),"attribute_id");--> statement-breakpoint
CREATE INDEX "product_attribute_values_vendor_product_idx" ON "product_attribute_values" USING btree ("vendor_id","product_id");--> statement-breakpoint
CREATE INDEX "product_attribute_values_vendor_attr_idx" ON "product_attribute_values" USING btree ("vendor_id","attribute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_marketplace_data_uq" ON "product_marketplace_data" USING btree ("product_id","marketplace");--> statement-breakpoint
CREATE INDEX "product_marketplace_data_vendor_idx" ON "product_marketplace_data" USING btree ("vendor_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_vendor_barcode_uq" ON "product_variants" USING btree ("vendor_id","barcode") WHERE "product_variants"."barcode" IS NOT NULL AND "product_variants"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_purpose_chk" CHECK (purpose IN ('product_image', 'product_document', 'listing_document'));--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_mode_chk" CHECK (mode IN ('live', 'sandbox'));--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_connection_chk" CHECK (connection_status IN ('unknown', 'connected', 'degraded', 'disconnected', 'error'));--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_marketplace_chk" CHECK (marketplace IN ('amazon_in', 'flipkart', 'myntra', 'snapdeal', 'mock'));