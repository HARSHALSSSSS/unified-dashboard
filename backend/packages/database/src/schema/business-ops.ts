import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, minor, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors, users } from './identity';
import { productVariants } from './catalog';
import { marketplaceAccounts } from './marketplace';

// ------------------------------------------------------------------------------------------------
// business rules (controlled, data-driven: a typed condition language + a registry of whitelisted actions, no code)
// ------------------------------------------------------------------------------------------------
export const RULE_TYPES = ['pricing', 'stock', 'marketplace', 'fulfillment', 'notification'] as const;
export const RULE_STATUSES = ['draft', 'active', 'disabled'] as const;

export const businessRules = pgTable('business_rules', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('draft'),
  /** higher runs first */
  priority: integer('priority').notNull().default(100),
  /** stop evaluating lower-priority rules of this type once this one matched */
  exclusive: boolean('exclusive').notNull().default(false),
  /** { combinator: 'all' | 'any', conditions: [{ field, op, value }] } - fields/ops are whitelisted per rule type */
  conditions: jsonb('conditions').$type<{ combinator: 'all' | 'any'; conditions: Array<{ field: string; op: string; value?: unknown }> }>().notNull(),
  /** { type, params } - the action type is whitelisted per rule type and its params are validated */
  action: jsonb('action').$type<{ type: string; params: Record<string, unknown> }>().notNull(),
  startsAt: tz('starts_at'),
  endsAt: tz('ends_at'),
  createdBy: text('created_by'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('business_rules_vendor_id_id_uq').on(t.vendorId, t.id),
  index('business_rules_vendor_type_idx').on(t.vendorId, t.type, t.status, t.priority.desc()),
  check('business_rules_type_chk', inList('type', RULE_TYPES)),
  check('business_rules_status_chk', inList('status', RULE_STATUSES)),
  check('business_rules_window_chk', sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`),
]);

/** Which rule changed what: explainability for pricing/routing decisions (bounded, append-only). */
export const ruleExecutions = pgTable('rule_executions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id').notNull(),
  ruleType: text('rule_type').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('rule_executions_vendor_rule_idx').on(t.vendorId, t.ruleId, t.id),
  index('rule_executions_vendor_entity_idx').on(t.vendorId, t.entityType, t.entityId),
  foreignKey({ columns: [t.vendorId, t.ruleId], foreignColumns: [businessRules.vendorId, businessRules.id], name: 'rule_executions_rule_fk' }).onDelete('cascade'),
]);

// ------------------------------------------------------------------------------------------------
// pricing: base price lives on the variant; marketplace/sale prices and the history live here
// ------------------------------------------------------------------------------------------------
export const PRICE_FIELDS = ['base', 'mrp', 'marketplace', 'sale'] as const;
export const PRICE_SOURCES = ['manual', 'rule', 'bulk', 'catalog', 'schedule', 'import'] as const;

/** A price specific to ONE marketplace account (not all marketplaces take the same price or the same API). */
export const marketplacePrices = pgTable('marketplace_prices', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull(),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  priceMinor: minor('price_minor'),
  mrpMinor: minor('mrp_minor'),
  salePriceMinor: minor('sale_price_minor'),
  saleStartsAt: tz('sale_starts_at'),
  saleEndsAt: tz('sale_ends_at'),
  source: text('source').notNull().default('manual'),
  /** what was last pushed to the listing (so a sale ending / starting is applied exactly once) */
  appliedPriceMinor: minor('applied_price_minor'),
  appliedAt: tz('applied_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('marketplace_prices_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('marketplace_prices_uq').on(t.marketplaceAccountId, t.variantId),
  index('marketplace_prices_vendor_variant_idx').on(t.vendorId, t.variantId),
  index('marketplace_prices_sale_idx').on(t.saleStartsAt, t.saleEndsAt).where(sql`${t.salePriceMinor} IS NOT NULL`),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'marketplace_prices_variant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'marketplace_prices_account_fk' }).onDelete('cascade'),
  check('marketplace_prices_amounts_chk', sql`(price_minor IS NULL OR price_minor > 0) AND (mrp_minor IS NULL OR mrp_minor > 0) AND (sale_price_minor IS NULL OR sale_price_minor > 0)`),
  check('marketplace_prices_window_chk', sql`sale_starts_at IS NULL OR sale_ends_at IS NULL OR sale_ends_at > sale_starts_at`),
  check('marketplace_prices_source_chk', inList('source', PRICE_SOURCES)),
]);

/** Append-only price history. account NULL = the base price of the variant itself. */
export const priceHistory = pgTable('price_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull(),
  marketplaceAccountId: uuid('marketplace_account_id'),
  field: text('field').notNull(),
  oldPriceMinor: minor('old_price_minor'),
  newPriceMinor: minor('new_price_minor'),
  source: text('source').notNull(),
  ruleId: uuid('rule_id'),
  batchId: text('batch_id'),
  reason: text('reason'),
  actorId: text('actor_id'),
  createdAt: createdAt(),
}, (t) => [
  index('price_history_vendor_variant_idx').on(t.vendorId, t.variantId, t.id.desc()),
  index('price_history_vendor_batch_idx').on(t.vendorId, t.batchId),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'price_history_variant_fk' }).onDelete('cascade'),
  check('price_history_field_chk', inList('field', PRICE_FIELDS)),
  check('price_history_source_chk', inList('source', PRICE_SOURCES)),
]);

// ------------------------------------------------------------------------------------------------
// notifications: in-app records + per-channel deliveries + push-ready device tokens
// ------------------------------------------------------------------------------------------------
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push'] as const;
export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;

export const notifications = pgTable('notifications', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  /** the recipient; one row per recipient */
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  severity: text('severity').notNull().default('info'),
  title: text('title').notNull(),
  body: text('body'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  /** same key + recipient within the window = one notification (alert storms collapse into one) */
  dedupeKey: text('dedupe_key'),
  readAt: tz('read_at'),
  ...timestamps(),
}, (t) => [
  unique('notifications_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('notifications_dedupe_uq').on(t.vendorId, t.userId, t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL AND ${t.readAt} IS NULL`),
  index('notifications_vendor_user_idx').on(t.vendorId, t.userId, t.createdAt.desc()),
  index('notifications_unread_idx').on(t.vendorId, t.userId).where(sql`${t.readAt} IS NULL`),
  foreignKey({ columns: [t.vendorId, t.userId], foreignColumns: [users.vendorId, users.id], name: 'notifications_user_fk' }).onDelete('cascade'),
  check('notifications_severity_chk', inList('severity', NOTIFICATION_SEVERITIES)),
]);

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  notificationId: uuid('notification_id').notNull(),
  channel: text('channel').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  providerMessageId: text('provider_message_id'),
  sentAt: tz('sent_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('notification_deliveries_uq').on(t.notificationId, t.channel),
  index('notification_deliveries_vendor_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.notificationId], foreignColumns: [notifications.vendorId, notifications.id], name: 'notification_deliveries_notification_fk' }).onDelete('cascade'),
  check('notification_deliveries_channel_chk', inList('channel', NOTIFICATION_CHANNELS)),
  check('notification_deliveries_status_chk', inList('status', DELIVERY_STATUSES)),
]);

/** Per user, per notification type: which channels are on. No row = the type's defaults. */
export const notificationPreferences = pgTable('notification_preferences', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email').notNull().default(false),
  push: boolean('push').notNull().default(false),
  ...timestamps(),
}, (t) => [
  uniqueIndex('notification_preferences_uq').on(t.vendorId, t.userId, t.type),
  foreignKey({ columns: [t.vendorId, t.userId], foreignColumns: [users.vendorId, users.id], name: 'notification_preferences_user_fk' }).onDelete('cascade'),
]);

/** Push is "ready": devices register here; a provider (FCM / Expo push) plugs into the delivery step later. */
export const deviceTokens = pgTable('device_tokens', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  platform: text('platform').notNull(),
  token: text('token').notNull(),
  lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('device_tokens_uq').on(t.vendorId, t.token),
  index('device_tokens_vendor_user_idx').on(t.vendorId, t.userId),
  foreignKey({ columns: [t.vendorId, t.userId], foreignColumns: [users.vendorId, users.id], name: 'device_tokens_user_fk' }).onDelete('cascade'),
  check('device_tokens_platform_chk', inList('platform', ['ios', 'android', 'web', 'expo'])),
]);
