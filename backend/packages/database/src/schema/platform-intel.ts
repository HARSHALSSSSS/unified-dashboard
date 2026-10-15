import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inList, minor, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { marketplaceAccounts } from './marketplace';
import { orders } from './operations';

// ================================================================================================
// Stage 5: analytics read models, AI recommendations, automation, billing, feature flags
// ================================================================================================

// ------------------------------------------------------------------------------------------------
// analytics read models (rolled up by a job; dashboards never scan the operational tables)
// ------------------------------------------------------------------------------------------------
export const analyticsDailySales = pgTable('analytics_daily_sales', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  marketplace: text('marketplace').notNull(),
  orders: integer('orders').notNull().default(0),
  cancelledOrders: integer('cancelled_orders').notNull().default(0),
  units: integer('units').notNull().default(0),
  grossMinor: minor('gross_minor').notNull().default(0),
  taxMinor: minor('tax_minor').notNull().default(0),
  discountMinor: minor('discount_minor').notNull().default(0),
  shippingMinor: minor('shipping_minor').notNull().default(0),
  returnedUnits: integer('returned_units').notNull().default(0),
  refundMinor: minor('refund_minor').notNull().default(0),
  deliveredOrders: integer('delivered_orders').notNull().default(0),
  /** fulfillment performance: parcels shipped that day and the total seconds from fulfillment creation to shipping */
  shippedFulfillments: integer('shipped_fulfillments').notNull().default(0),
  shipSecondsTotal: bigint('ship_seconds_total', { mode: 'number' }).notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('analytics_daily_sales_uq').on(t.vendorId, t.day, t.marketplace),
]);

export const analyticsDailyProducts = pgTable('analytics_daily_products', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  variantId: uuid('variant_id').notNull(),
  sku: text('sku').notNull(),
  units: integer('units').notNull().default(0),
  revenueMinor: minor('revenue_minor').notNull().default(0),
  returnedUnits: integer('returned_units').notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('analytics_daily_products_uq').on(t.vendorId, t.day, t.variantId),
  index('analytics_daily_products_variant_idx').on(t.vendorId, t.variantId, t.day),
]);

/** Money the marketplace / courier actually charged for ONE order, entered or imported by the vendor. Absent = unknown (never guessed). */
export const orderFinancials = pgTable('order_financials', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  marketplaceFeeMinor: minor('marketplace_fee_minor'),
  penaltyMinor: minor('penalty_minor'),
  otherCostMinor: minor('other_cost_minor'),
  notes: text('notes'),
  updatedBy: text('updated_by'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('order_financials_order_uq').on(t.orderId),
  index('order_financials_vendor_idx').on(t.vendorId, t.updatedAt.desc()),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'order_financials_order_fk' }).onDelete('cascade'),
  check('order_financials_nonneg_chk', sql`(marketplace_fee_minor IS NULL OR marketplace_fee_minor >= 0) AND (penalty_minor IS NULL OR penalty_minor >= 0) AND (other_cost_minor IS NULL OR other_cost_minor >= 0)`),
]);

/** The vendor's commission terms with a marketplace. Used ONLY to produce clearly-labelled ESTIMATES when no actual fee is known. */
export const feeProfiles = pgTable('fee_profiles', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  feePercentBps: integer('fee_percent_bps').notNull().default(0),
  fixedFeeMinor: minor('fixed_fee_minor').notNull().default(0),
  label: text('label'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('fee_profiles_account_uq').on(t.marketplaceAccountId),
  index('fee_profiles_vendor_idx').on(t.vendorId),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'fee_profiles_account_fk' }).onDelete('cascade'),
  check('fee_profiles_chk', sql`fee_percent_bps BETWEEN 0 AND 10000 AND fixed_fee_minor >= 0`),
]);

// ------------------------------------------------------------------------------------------------
// AI: settings + recommendations (OBSERVE -> RECOMMEND -> APPROVE -> AUTOMATE)
// ------------------------------------------------------------------------------------------------
export const AI_MODES = ['observe', 'recommend', 'approve', 'automate'] as const;
export const RECOMMENDATION_STATUSES = ['open', 'approved', 'rejected', 'applied', 'failed', 'expired', 'rolled_back'] as const;
export const RECOMMENDATION_SEVERITIES = ['info', 'warning', 'critical'] as const;

export const aiSettings = pgTable('ai_settings', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  /** observe = insights only; recommend = + recommendations; approve = recommendations can be applied after a human approves; automate = listed action types apply themselves */
  mode: text('mode').notNull().default('recommend'),
  /** action types the vendor explicitly allows to run WITHOUT approval (only honoured in `automate` mode) */
  automatedActions: text('automated_actions').array().notNull().default(sql`'{}'::text[]`),
  ...timestamps(),
}, (t) => [
  uniqueIndex('ai_settings_vendor_uq').on(t.vendorId),
  check('ai_settings_mode_chk', inList('mode', AI_MODES)),
]);

export const aiRecommendations = pgTable('ai_recommendations', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  severity: text('severity').notNull().default('info'),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  /** the REAL data the recommendation is based on (so it can be checked): metrics, ids, windows */
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  /** what applying it would do: { type, params } from a whitelist; null = advice only */
  action: jsonb('action').$type<{ type: string; params: Record<string, unknown> } | null>(),
  status: text('status').notNull().default('open'),
  /** 'rules' = deterministic analysis, 'llm' = language-model narration of the same data, 'automation' = created by an automation rule */
  source: text('source').notNull().default('rules'),
  dedupeKey: text('dedupe_key'),
  decidedBy: text('decided_by'),
  decidedAt: tz('decided_at'),
  appliedAt: tz('applied_at'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  /** what is needed to undo the applied action */
  rollback: jsonb('rollback').$type<Record<string, unknown>>(),
  expiresAt: tz('expires_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('ai_recommendations_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('ai_recommendations_open_uq').on(t.vendorId, t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('open','approved')`),
  index('ai_recommendations_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  check('ai_recommendations_status_chk', inList('status', RECOMMENDATION_STATUSES)),
  check('ai_recommendations_severity_chk', inList('severity', RECOMMENDATION_SEVERITIES)),
]);

// ------------------------------------------------------------------------------------------------
// automation: trigger -> conditions -> action, with approval, history and rollback
// ------------------------------------------------------------------------------------------------
export const AUTOMATION_MODES = ['auto', 'approval'] as const;
export const AUTOMATION_RULE_STATUSES = ['draft', 'active', 'disabled'] as const;
export const AUTOMATION_EXECUTION_STATUSES = ['executed', 'pending_approval', 'rejected', 'failed', 'skipped', 'rolled_back'] as const;

export const automationRules = pgTable('automation_rules', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** the domain event that triggers it, e.g. inventory.low_stock */
  triggerEvent: text('trigger_event').notNull(),
  conditions: jsonb('conditions').$type<{ combinator: 'all' | 'any'; conditions: Array<{ field: string; op: string; value?: unknown }> }>().notNull(),
  action: jsonb('action').$type<{ type: string; params: Record<string, unknown> }>().notNull(),
  mode: text('mode').notNull().default('approval'),
  status: text('status').notNull().default('draft'),
  createdBy: text('created_by'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('automation_rules_vendor_id_id_uq').on(t.vendorId, t.id),
  index('automation_rules_vendor_trigger_idx').on(t.vendorId, t.triggerEvent, t.status),
  check('automation_rules_mode_chk', inList('mode', AUTOMATION_MODES)),
  check('automation_rules_status_chk', inList('status', AUTOMATION_RULE_STATUSES)),
]);

export const automationExecutions = pgTable('automation_executions', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id').notNull(),
  /** the domain event that fired it: (rule, event) is unique, so a redelivered event never runs an action twice */
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  status: text('status').notNull(),
  facts: jsonb('facts').$type<Record<string, unknown>>().notNull().default({}),
  actionType: text('action_type').notNull(),
  actionParams: jsonb('action_params').$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb('result').$type<Record<string, unknown>>(),
  rollback: jsonb('rollback').$type<Record<string, unknown>>(),
  error: text('error'),
  decidedBy: text('decided_by'),
  decidedAt: tz('decided_at'),
  executedAt: tz('executed_at'),
  ...timestamps(),
}, (t) => [
  unique('automation_executions_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('automation_executions_rule_event_uq').on(t.ruleId, t.eventId),
  index('automation_executions_vendor_idx').on(t.vendorId, t.createdAt.desc()),
  index('automation_executions_pending_idx').on(t.vendorId, t.status),
  foreignKey({ columns: [t.vendorId, t.ruleId], foreignColumns: [automationRules.vendorId, automationRules.id], name: 'automation_executions_rule_fk' }).onDelete('cascade'),
  check('automation_executions_status_chk', inList('status', AUTOMATION_EXECUTION_STATUSES)),
]);

// ------------------------------------------------------------------------------------------------
// feature flags (platform-wide default + per-vendor override)
// ------------------------------------------------------------------------------------------------
export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  description: text('description').notNull().default(''),
  defaultEnabled: boolean('default_enabled').notNull().default(false),
  ...timestamps(),
});

export const featureFlagOverrides = pgTable('feature_flag_overrides', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  flagKey: text('flag_key').notNull().references(() => featureFlags.key, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull(),
  updatedBy: text('updated_by'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('feature_flag_overrides_uq').on(t.vendorId, t.flagKey),
]);

// ------------------------------------------------------------------------------------------------
// billing (deliberately separate from the commerce tables: it only reads usage events)
// ------------------------------------------------------------------------------------------------
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled'] as const;
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunded'] as const;
export const USAGE_METRICS = ['orders', 'products', 'marketplace_accounts', 'users', 'api_calls'] as const;

export const plans = pgTable('plans', {
  id: pk(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  priceMinor: minor('price_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),
  interval: text('interval').notNull().default('month'),
  /** { orders: 1000, products: 500, marketplace_accounts: 2, users: 3 }  (absent / null = unlimited) */
  limits: jsonb('limits').$type<Record<string, number | null>>().notNull().default({}),
  /** per-order price above the included orders (minor units); null = hard limit only */
  overagePerOrderMinor: minor('overage_per_order_minor'),
  features: jsonb('features').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('plans_code_uq').on(t.code),
  check('plans_price_chk', sql`price_minor >= 0`),
]);

export const subscriptions = pgTable('subscriptions', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').notNull().references(() => plans.id),
  status: text('status').notNull().default('trialing'),
  trialEndsAt: tz('trial_ends_at'),
  currentPeriodStart: tz('current_period_start').notNull(),
  currentPeriodEnd: tz('current_period_end').notNull(),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  cancelledAt: tz('cancelled_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('subscriptions_vendor_uq').on(t.vendorId),
  check('subscriptions_status_chk', inList('status', SUBSCRIPTION_STATUSES)),
]);

export const usageRecords = pgTable('usage_records', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  metric: text('metric').notNull(),
  periodStart: date('period_start', { mode: 'string' }).notNull(),
  quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('usage_records_uq').on(t.vendorId, t.metric, t.periodStart),
  check('usage_records_metric_chk', inList('metric', USAGE_METRICS)),
]);

export const invoices = pgTable('invoices', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  periodStart: tz('period_start').notNull(),
  periodEnd: tz('period_end').notNull(),
  status: text('status').notNull().default('open'),
  currency: text('currency').notNull().default('INR'),
  subtotalMinor: minor('subtotal_minor').notNull().default(0),
  taxMinor: minor('tax_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull().default(0),
  dueAt: tz('due_at'),
  paidAt: tz('paid_at'),
  ...timestamps(),
}, (t) => [
  unique('invoices_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('invoices_number_uq').on(t.vendorId, t.number),
  /** one invoice per subscription period (the generator is idempotent) */
  uniqueIndex('invoices_period_uq').on(t.vendorId, t.periodStart),
  index('invoices_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  check('invoices_status_chk', inList('status', INVOICE_STATUSES)),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').notNull(),
  description: text('description').notNull(),
  metric: text('metric'),
  quantity: bigint('quantity', { mode: 'number' }).notNull().default(1),
  unitMinor: minor('unit_minor').notNull().default(0),
  amountMinor: minor('amount_minor').notNull().default(0),
  ...timestamps(),
}, (t) => [
  index('invoice_lines_vendor_invoice_idx').on(t.vendorId, t.invoiceId),
  foreignKey({ columns: [t.vendorId, t.invoiceId], foreignColumns: [invoices.vendorId, invoices.id], name: 'invoice_lines_invoice_fk' }).onDelete('cascade'),
]);

export const payments = pgTable('payments', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  status: text('status').notNull().default('pending'),
  provider: text('provider').notNull().default('manual'),
  providerRef: text('provider_ref'),
  failureReason: text('failure_reason'),
  ...timestamps(),
}, (t) => [
  index('payments_vendor_invoice_idx').on(t.vendorId, t.invoiceId),
  foreignKey({ columns: [t.vendorId, t.invoiceId], foreignColumns: [invoices.vendorId, invoices.id], name: 'payments_invoice_fk' }),
  check('payments_status_chk', inList('status', PAYMENT_STATUSES)),
  check('payments_amount_chk', sql`amount_minor > 0`),
]);
