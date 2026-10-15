import { sql } from 'drizzle-orm';
import { boolean, char, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inList, minor, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { productVariants } from './catalog';

export const MARKETPLACE_CODES = ['amazon_in', 'flipkart', 'myntra', 'snapdeal', 'mock'] as const;
export const CONNECTION_STATUSES = ['unknown', 'connected', 'degraded', 'disconnected', 'error'] as const;
export const ACCOUNT_MODES = ['live', 'sandbox'] as const;
export const ACCOUNT_STATUSES = ['pending_authorization', 'active', 'paused', 'error', 'revoked'] as const;
export const AUTHORIZATION_STATUSES = ['active', 'expiring', 'expired', 'revoked', 'error'] as const;
/** Internal listing lifecycle (marketplace statuses are mapped to these; the original word is `external_status`). */
export const LISTING_STATUSES = ['draft', 'ready', 'approved', 'pending', 'active', 'rejected', 'correction_required', 'unpublished'] as const;
export const LISTING_SOURCES = ['created', 'imported'] as const;

/** A vendor's seller account on one marketplace. Many accounts per vendor, many vendors per marketplace. */
export const marketplaceAccounts = pgTable('marketplace_accounts', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplace: text('marketplace').notNull(),
  displayName: text('display_name').notNull(),
  /** seller / merchant id assigned by the marketplace; unique per (vendor, marketplace) */
  externalAccountId: text('external_account_id'),
  region: text('region').notNull().default('IN'),
  status: text('status').notNull().default('pending_authorization'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** live = real marketplace; sandbox = marketplace sandbox or the built-in mock connector */
  mode: text('mode').notNull().default('live'),
  /** health of the connection (distinct from authorization status) */
  connectionStatus: text('connection_status').notNull().default('unknown'),
  lastSyncedAt: tz('last_synced_at'),
  lastSuccessAt: tz('last_success_at'),
  lastFailureAt: tz('last_failure_at'),
  lastFailureMessage: text('last_failure_message'),
  /** per-account sync watermarks, e.g. { ordersSince: ISO } (jobs are per run; the watermark lives with the account) */
  syncState: jsonb('sync_state').$type<Record<string, unknown>>().notNull().default({}),
  /** AES-256-GCM envelope of the inbound-webhook signing secret (AAD-bound); the plaintext is shown once on creation/rotation */
  webhookSecretCiphertext: text('webhook_secret_ciphertext'),
  webhookSecretRotatedAt: tz('webhook_secret_rotated_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('marketplace_accounts_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('marketplace_accounts_external_uq').on(t.vendorId, t.marketplace, t.externalAccountId).where(sql`${t.externalAccountId} IS NOT NULL`),
  index('marketplace_accounts_vendor_idx').on(t.vendorId, t.marketplace),
  index('marketplace_accounts_status_idx').on(t.status, t.marketplace),
  check('marketplace_accounts_marketplace_chk', inList('marketplace', MARKETPLACE_CODES)),
  check('marketplace_accounts_status_chk', inList('status', ACCOUNT_STATUSES)),
  check('marketplace_accounts_mode_chk', inList('mode', ACCOUNT_MODES)),
  check('marketplace_accounts_connection_chk', inList('connection_status', CONNECTION_STATUSES)),
]);

/**
 * Credentials. NEVER selected by default repositories, NEVER serialised to API responses (no zod response
 * schema includes these columns). `credentials_ciphertext` is an AES-256-GCM envelope (see @oms/auth SecretBox),
 * AAD-bound to `marketplace_authorizations:<vendor_id>:<id>`.
 */
export const marketplaceAuthorizations = pgTable('marketplace_authorizations', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  authType: text('auth_type').notNull(),
  credentialsCiphertext: text('credentials_ciphertext').notNull(),
  encryptionKeyId: text('encryption_key_id').notNull(),
  scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('active'),
  accessTokenExpiresAt: tz('access_token_expires_at'),
  lastRefreshedAt: tz('last_refreshed_at'),
  rotationCount: integer('rotation_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: tz('last_error_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('marketplace_authorizations_account_uq').on(t.marketplaceAccountId),
  index('marketplace_authorizations_vendor_idx').on(t.vendorId),
  index('marketplace_authorizations_expiry_idx').on(t.accessTokenExpiresAt).where(sql`${t.status} IN ('active','expiring')`),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'marketplace_authorizations_account_fk' }).onDelete('cascade'),
  check('marketplace_authorizations_status_chk', inList('status', AUTHORIZATION_STATUSES)),
]);

/** Internal variant <-> marketplace listing mapping. */
export const marketplaceListings = pgTable('marketplace_listings', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  externalListingId: text('external_listing_id'),
  externalSku: text('external_sku').notNull(),
  status: text('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  priceMinor: minor('price_minor'),
  /** the payload last SUBMITTED to the marketplace (what the merchant approved) */
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  /** hash of last pushed state; skip no-op pushes */
  syncHash: text('sync_hash'),
  lastSyncedAt: tz('last_synced_at'),
  lastErrorCode: text('last_error_code'),
  source: text('source').notNull().default('created'),
  /** the marketplace's own status word, verbatim (never interpreted by core) */
  externalStatus: text('external_status'),
  /** marketplace errors/warnings from the last submission or status check */
  issues: jsonb('issues').$type<Array<{ code: string; message: string; attribute?: string; severity: 'error' | 'warning' }>>().notNull().default([]),
  marketplaceCategoryId: text('marketplace_category_id'),
  /** marketplace attribute name -> value, resolved from mappings at validation time and editable per listing */
  attributeValues: jsonb('attribute_values').$type<Record<string, string | number | boolean>>().notNull().default({}),
  /** last validation result { ready, errors[], warnings[] } */
  validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
  /** hash of the payload the merchant approved; a later change invalidates the approval */
  approvedHash: text('approved_hash'),
  approvedBy: uuid('approved_by'),
  approvedAt: tz('approved_at'),
  publishedAt: tz('published_at'),
  lastPolledAt: tz('last_polled_at'),
  mrpMinor: minor('mrp_minor'),
  // ---- channel inventory (see inventory sync)
  /** per-listing override of the channel safety buffer / cap (null = use the account policy) */
  bufferOverride: integer('buffer_override'),
  maxQuantityOverride: integer('max_quantity_override'),
  /** last quantity we computed for this channel and the last one the marketplace confirmed */
  sellableQuantity: integer('sellable_quantity'),
  pushedQuantity: integer('pushed_quantity'),
  quantityDirty: boolean('quantity_dirty').notNull().default(false),
  quantityDirtyAt: tz('quantity_dirty_at'),
  quantityPushedAt: tz('quantity_pushed_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('marketplace_listings_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('marketplace_listings_account_ext_id_uq').on(t.marketplaceAccountId, t.externalListingId).where(sql`${t.externalListingId} IS NOT NULL`),
  uniqueIndex('marketplace_listings_account_sku_uq').on(t.marketplaceAccountId, t.externalSku),
  uniqueIndex('marketplace_listings_account_variant_uq').on(t.marketplaceAccountId, t.variantId),
  index('marketplace_listings_vendor_variant_idx').on(t.vendorId, t.variantId),
  index('marketplace_listings_vendor_status_idx').on(t.vendorId, t.status),
  index('marketplace_listings_dirty_idx').on(t.marketplaceAccountId).where(sql`${t.quantityDirty}`),
  index('marketplace_listings_poll_idx').on(t.marketplaceAccountId, t.lastPolledAt).where(sql`${t.status} = 'pending'`),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'marketplace_listings_account_fk' }),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'marketplace_listings_variant_fk' }),
  check('marketplace_listings_status_chk', inList('status', LISTING_STATUSES)),
  check('marketplace_listings_source_chk', inList('source', LISTING_SOURCES)),
  check('marketplace_listings_override_chk', sql`(buffer_override IS NULL OR buffer_override >= 0) AND (max_quantity_override IS NULL OR max_quantity_override >= 0)`),
]);
