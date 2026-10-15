CREATE TABLE "ai_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'rules' NOT NULL,
	"dedupe_key" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"result" jsonb,
	"rollback" jsonb,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_recommendations_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "ai_recommendations_status_chk" CHECK (status IN ('open', 'approved', 'rejected', 'applied', 'failed', 'expired', 'rolled_back')),
	CONSTRAINT "ai_recommendations_severity_chk" CHECK (severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'recommend' NOT NULL,
	"automated_actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_mode_chk" CHECK (mode IN ('observe', 'recommend', 'approve', 'automate'))
);
--> statement-breakpoint
CREATE TABLE "analytics_daily_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"variant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"revenue_minor" bigint DEFAULT 0 NOT NULL,
	"returned_units" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_daily_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"marketplace" text NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"cancelled_orders" integer DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"gross_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"shipping_minor" bigint DEFAULT 0 NOT NULL,
	"returned_units" integer DEFAULT 0 NOT NULL,
	"refund_minor" bigint DEFAULT 0 NOT NULL,
	"delivered_orders" integer DEFAULT 0 NOT NULL,
	"shipped_fulfillments" integer DEFAULT 0 NOT NULL,
	"ship_seconds_total" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_type" text NOT NULL,
	"action_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"rollback" jsonb,
	"error" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_executions_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "automation_executions_status_chk" CHECK (status IN ('executed', 'pending_approval', 'rejected', 'failed', 'skipped', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_event" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"mode" text DEFAULT 'approval' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_rules_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "automation_rules_mode_chk" CHECK (mode IN ('auto', 'approval')),
	CONSTRAINT "automation_rules_status_chk" CHECK (status IN ('draft', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "feature_flag_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"fee_percent_bps" integer DEFAULT 0 NOT NULL,
	"fixed_fee_minor" bigint DEFAULT 0 NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_profiles_chk" CHECK (fee_percent_bps BETWEEN 0 AND 10000 AND fixed_fee_minor >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"metric" text,
	"quantity" bigint DEFAULT 1 NOT NULL,
	"unit_minor" bigint DEFAULT 0 NOT NULL,
	"amount_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_vendor_id_id_uq" UNIQUE("vendor_id","id"),
	CONSTRAINT "invoices_status_chk" CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible'))
);
--> statement-breakpoint
CREATE TABLE "order_financials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"marketplace_fee_minor" bigint,
	"penalty_minor" bigint,
	"other_cost_minor" bigint,
	"notes" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_financials_nonneg_chk" CHECK ((marketplace_fee_minor IS NULL OR marketplace_fee_minor >= 0) AND (penalty_minor IS NULL OR penalty_minor >= 0) AND (other_cost_minor IS NULL OR other_cost_minor >= 0))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_chk" CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
	CONSTRAINT "payments_amount_chk" CHECK (amount_minor > 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"overage_per_order_minor" bigint,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_price_chk" CHECK (price_minor >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_chk" CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"period_start" date NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_metric_chk" CHECK (metric IN ('orders', 'products', 'marketplace_accounts', 'users', 'api_calls'))
);
--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily_products" ADD CONSTRAINT "analytics_daily_products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily_sales" ADD CONSTRAINT "analytics_daily_sales_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_rule_fk" FOREIGN KEY ("vendor_id","rule_id") REFERENCES "public"."automation_rules"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_flag_key_feature_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."feature_flags"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_profiles" ADD CONSTRAINT "fee_profiles_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_profiles" ADD CONSTRAINT "fee_profiles_account_fk" FOREIGN KEY ("vendor_id","marketplace_account_id") REFERENCES "public"."marketplace_accounts"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("vendor_id","invoice_id") REFERENCES "public"."invoices"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_order_fk" FOREIGN KEY ("vendor_id","order_id") REFERENCES "public"."orders"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("vendor_id","invoice_id") REFERENCES "public"."invoices"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_recommendations_open_uq" ON "ai_recommendations" USING btree ("vendor_id","dedupe_key") WHERE "ai_recommendations"."dedupe_key" IS NOT NULL AND "ai_recommendations"."status" IN ('open','approved');--> statement-breakpoint
CREATE INDEX "ai_recommendations_vendor_status_idx" ON "ai_recommendations" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_settings_vendor_uq" ON "ai_settings" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_daily_products_uq" ON "analytics_daily_products" USING btree ("vendor_id","day","variant_id");--> statement-breakpoint
CREATE INDEX "analytics_daily_products_variant_idx" ON "analytics_daily_products" USING btree ("vendor_id","variant_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_daily_sales_uq" ON "analytics_daily_sales" USING btree ("vendor_id","day","marketplace");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_executions_rule_event_uq" ON "automation_executions" USING btree ("rule_id","event_id");--> statement-breakpoint
CREATE INDEX "automation_executions_vendor_idx" ON "automation_executions" USING btree ("vendor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_executions_pending_idx" ON "automation_executions" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "automation_rules_vendor_trigger_idx" ON "automation_rules" USING btree ("vendor_id","trigger_event","status");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_overrides_uq" ON "feature_flag_overrides" USING btree ("vendor_id","flag_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_profiles_account_uq" ON "fee_profiles" USING btree ("marketplace_account_id");--> statement-breakpoint
CREATE INDEX "fee_profiles_vendor_idx" ON "fee_profiles" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_vendor_invoice_idx" ON "invoice_lines" USING btree ("vendor_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("vendor_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_period_uq" ON "invoices" USING btree ("vendor_id","period_start");--> statement-breakpoint
CREATE INDEX "invoices_vendor_status_idx" ON "invoices" USING btree ("vendor_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "order_financials_order_uq" ON "order_financials" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_financials_vendor_idx" ON "order_financials" USING btree ("vendor_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_vendor_invoice_idx" ON "payments" USING btree ("vendor_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_code_uq" ON "plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_vendor_uq" ON "subscriptions" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_uq" ON "usage_records" USING btree ("vendor_id","metric","period_start");