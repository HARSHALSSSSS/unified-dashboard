import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inList, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { categories, productVariants } from './catalog';
import { attributeDefinitions } from './catalog-ext';
import { marketplaceAccounts, marketplaceListings } from './marketplace';
import { syncJobs } from './platform';

/**
 * Marketplace-facing tables (everything keyed by a marketplace code or account). They hold the MAPPING between our
 * neutral models and each marketplace's vocabulary, so core tables never learn marketplace concepts.
 */
export const MAPPING_SOURCE_TYPES = ['core_field', 'attribute', 'static'] as const;
export const IMPORT_STATUSES = ['new', 'linked', 'ignored'] as const;
export const WEBHOOK_STATUSES = ['received', 'processing', 'processed', 'failed', 'dead_lettered', 'ignored', 'rejected'] as const;
export const CHANNEL_INVENTORY_MODES = ['sync', 'paused'] as const;
export const STOCK_UPDATE_STATUSES = ['pending', 'sent', 'succeeded', 'failed'] as const;

/** Internal category -> marketplace category (per marketplace). */
export const categoryMappings = pgTable('category_mappings', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplace: text('marketplace').notNull(),
  categoryId: uuid('category_id').notNull(),
  marketplaceCategoryId: text('marketplace_category_id').notNull(),
  marketplaceCategoryName: text('marketplace_category_name'),
  marketplaceCategoryPath: text('marketplace_category_path'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('category_mappings_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('category_mappings_uq').on(t.vendorId, t.marketplace, t.categoryId),
  index('category_mappings_vendor_marketplace_idx').on(t.vendorId, t.marketplace),
  foreignKey({ columns: [t.vendorId, t.categoryId], foreignColumns: [categories.vendorId, categories.id], name: 'category_mappings_category_fk' }).onDelete('cascade'),
]);

/**
 * Where a marketplace attribute's value comes from, per marketplace category:
 *   core_field -> a product/variant field (title, brand, description, barcode, mrp, country_of_origin ...)
 *   attribute  -> one of the vendor's attribute definitions (value read from the product/variant)
 *   static     -> a fixed value
 * `value_map` translates our value to the marketplace's allowed value ({ "Navy": "Blue" }).
 */
export const attributeMappings = pgTable('attribute_mappings', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplace: text('marketplace').notNull(),
  marketplaceCategoryId: text('marketplace_category_id').notNull(),
  marketplaceAttribute: text('marketplace_attribute').notNull(),
  sourceType: text('source_type').notNull(),
  coreField: text('core_field'),
  attributeId: uuid('attribute_id'),
  staticValue: text('static_value'),
  valueMap: jsonb('value_map').$type<Record<string, string>>().notNull().default({}),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('attribute_mappings_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('attribute_mappings_uq').on(t.vendorId, t.marketplace, t.marketplaceCategoryId, t.marketplaceAttribute),
  index('attribute_mappings_vendor_category_idx').on(t.vendorId, t.marketplace, t.marketplaceCategoryId),
  foreignKey({ columns: [t.vendorId, t.attributeId], foreignColumns: [attributeDefinitions.vendorId, attributeDefinitions.id], name: 'attribute_mappings_attribute_fk' }),
  check('attribute_mappings_source_chk', inList('source_type', MAPPING_SOURCE_TYPES)),
  check('attribute_mappings_shape_chk', sql`(source_type = 'core_field' AND core_field IS NOT NULL) OR (source_type = 'attribute' AND attribute_id IS NOT NULL) OR (source_type = 'static' AND static_value IS NOT NULL)`),
]);

/**
 * Products found on a marketplace (catalog import): Marketplace Product -> adapter -> NORMALISED product (this row)
 * -> operator action -> Master Product. `raw` keeps the marketplace payload for audit/reprocessing.
 */
export const importedProducts = pgTable('imported_products', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  externalListingId: text('external_listing_id').notNull(),
  externalSku: text('external_sku').notNull(),
  title: text('title').notNull(),
  normalized: jsonb('normalized').$type<Record<string, unknown>>().notNull(),
  raw: jsonb('raw'),
  contentHash: text('content_hash').notNull(),
  status: text('status').notNull().default('new'),
  /** set when linked to (or turned into) a master variant */
  variantId: uuid('variant_id'),
  listingId: uuid('listing_id'),
  syncJobId: uuid('sync_job_id'),
  importedAt: tz('imported_at').notNull().defaultNow(),
  ...timestamps(),
}, (t) => [
  unique('imported_products_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('imported_products_account_sku_uq').on(t.marketplaceAccountId, t.externalSku),
  index('imported_products_vendor_status_idx').on(t.vendorId, t.status, t.importedAt.desc()),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'imported_products_account_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'imported_products_variant_fk' }),
  foreignKey({ columns: [t.vendorId, t.listingId], foreignColumns: [marketplaceListings.vendorId, marketplaceListings.id], name: 'imported_products_listing_fk' }),
  check('imported_products_status_chk', inList('status', IMPORT_STATUSES)),
]);

/**
 * Inbound marketplace notifications. Receipt is fast and durable: verify signature -> insert here (the unique key makes
 * a redelivery a no-op) -> ack -> process asynchronously (retry with backoff, then dead-letter).
 * `rejected` rows (bad signature) keep NO payload: unauthenticated bytes are never stored.
 */
export const webhookEvents = pgTable('webhook_events', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  marketplace: text('marketplace').notNull(),
  eventType: text('event_type').notNull(),
  /** connector-derived (marketplace event id); unique per account => duplicate deliveries are dropped */
  idempotencyKey: text('idempotency_key').notNull(),
  externalId: text('external_id'),
  status: text('status').notNull().default('received'),
  payload: jsonb('payload'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /** how many times the marketplace re-sent this event (observability for duplicate protection) */
  deliveries: integer('deliveries').notNull().default(1),
  receivedAt: tz('received_at').notNull().defaultNow(),
  processedAt: tz('processed_at'),
  nextRetryAt: tz('next_retry_at'),
  ...timestamps(),
}, (t) => [
  unique('webhook_events_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('webhook_events_account_key_uq').on(t.marketplaceAccountId, t.idempotencyKey),
  index('webhook_events_vendor_received_idx').on(t.vendorId, t.receivedAt.desc()),
  index('webhook_events_pending_idx').on(t.status, t.nextRetryAt).where(sql`${t.status} IN ('received','failed')`),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'webhook_events_account_fk' }).onDelete('cascade'),
  check('webhook_events_status_chk', inList('status', WEBHOOK_STATUSES)),
]);

/**
 * How central stock becomes a channel's sellable quantity (per account):
 *   sellable = clamp( floor(available_in_channel_warehouses * allocation_percent/100) - safety_buffer, 0, max_quantity )
 * Never "the same number everywhere": every channel gets its own computed quantity.
 */
export const channelInventoryPolicies = pgTable('channel_inventory_policies', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  mode: text('mode').notNull().default('sync'),
  safetyBuffer: integer('safety_buffer').notNull().default(0),
  allocationPercent: integer('allocation_percent').notNull().default(100),
  maxQuantity: integer('max_quantity'),
  /** warehouses that feed this channel (empty = all active warehouses) */
  warehouseIds: uuid('warehouse_ids').array().notNull().default(sql`'{}'::uuid[]`),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('channel_inventory_policies_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('channel_inventory_policies_account_uq').on(t.marketplaceAccountId),
  index('channel_inventory_policies_vendor_idx').on(t.vendorId),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'channel_inventory_policies_account_fk' }).onDelete('cascade'),
  check('channel_inventory_policies_mode_chk', inList('mode', CHANNEL_INVENTORY_MODES)),
  check('channel_inventory_policies_range_chk', sql`safety_buffer >= 0 AND allocation_percent BETWEEN 0 AND 100 AND (max_quantity IS NULL OR max_quantity >= 0)`),
]);

/** One row per quantity push to a marketplace: request -> sent -> succeeded/failed (the "record result" step). */
export const channelStockUpdates = pgTable('channel_stock_updates', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  listingId: uuid('listing_id').notNull(),
  syncJobId: uuid('sync_job_id'),
  externalSku: text('external_sku').notNull(),
  /** what central stock says is available (before buffer/allocation) and what we asked the marketplace to show */
  availableQuantity: integer('available_quantity').notNull(),
  requestedQuantity: integer('requested_quantity').notNull(),
  status: text('status').notNull().default('pending'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  completedAt: tz('completed_at'),
  ...timestamps(),
}, (t) => [
  index('channel_stock_updates_vendor_listing_idx').on(t.vendorId, t.listingId, t.requestedAt.desc()),
  index('channel_stock_updates_job_idx').on(t.vendorId, t.syncJobId),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'channel_stock_updates_account_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.listingId], foreignColumns: [marketplaceListings.vendorId, marketplaceListings.id], name: 'channel_stock_updates_listing_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.syncJobId], foreignColumns: [syncJobs.vendorId, syncJobs.id], name: 'channel_stock_updates_job_fk' }),
  check('channel_stock_updates_status_chk', inList('status', STOCK_UPDATE_STATUSES)),
  check('channel_stock_updates_qty_chk', sql`available_quantity >= 0 AND requested_quantity >= 0`),
]);

