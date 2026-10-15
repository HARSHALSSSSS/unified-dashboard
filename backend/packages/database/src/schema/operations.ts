import { sql } from 'drizzle-orm';
import { boolean, char, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { deletedAt, inList, minor, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { productVariants } from './catalog';
import { marketplaceAccounts, marketplaceListings } from './marketplace';

export const WAREHOUSE_STATUSES = ['active', 'inactive'] as const;
/** Normalised order status (marketplace words are kept verbatim in `marketplace_status`). Mirrors @oms/marketplace-core. */
export const ORDER_STATUSES = ['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered', 'cancelled', 'returned'] as const;
export const ORDER_ITEM_STATUSES = ['new', 'allocated', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
export const PAYMENT_METHODS = ['prepaid', 'cod', 'unknown'] as const;
export const ORDER_INVENTORY_STATUSES = ['pending', 'reserved', 'partial', 'unallocated', 'committed', 'released'] as const;

export const warehouses = pgTable('warehouses', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  address: jsonb('address').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('active'),
  isDefault: boolean('is_default').notNull().default(false),
  priority: integer('priority').notNull().default(100),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  unique('warehouses_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('warehouses_vendor_code_uq').on(t.vendorId, t.code).where(sql`${t.deletedAt} IS NULL`),
  uniqueIndex('warehouses_default_uq').on(t.vendorId).where(sql`${t.isDefault} AND ${t.deletedAt} IS NULL`),
  check('warehouses_status_chk', inList('status', WAREHOUSE_STATUSES)),
]);

/**
 * Current stock per (variant, warehouse). EVERY change goes through the movement ledger (inventory_movements) in the same
 * transaction: these columns are a cache of the ledger, never edited on their own.
 *   on_hand   good physical stock in the warehouse            available = on_hand - reserved
 *   reserved  promised to orders (subset of on_hand)
 *   incoming  ordered / in transit, not yet received
 *   damaged   physically present but unsellable
 *   returned  customer returns awaiting inspection (not sellable yet)
 */
export const inventory = pgTable('inventory', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  quantityOnHand: integer('quantity_on_hand').notNull().default(0),
  quantityReserved: integer('quantity_reserved').notNull().default(0),
  quantityIncoming: integer('quantity_incoming').notNull().default(0),
  quantityDamaged: integer('quantity_damaged').notNull().default(0),
  quantityReturned: integer('quantity_returned').notNull().default(0),
  reorderLevel: integer('reorder_level'),
  version: version(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('inventory_variant_warehouse_uq').on(t.vendorId, t.variantId, t.warehouseId),
  index('inventory_vendor_warehouse_idx').on(t.vendorId, t.warehouseId),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'inventory_variant_fk' }),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'inventory_warehouse_fk' }),
  unique('inventory_vendor_id_id_uq').on(t.vendorId, t.id),
  check('inventory_qty_chk', sql`quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand AND quantity_incoming >= 0 AND quantity_damaged >= 0 AND quantity_returned >= 0`),
]);

/** One normalised order per marketplace order. (marketplace_account_id, external_order_id) is the ingestion idempotency key. */
export const orders = pgTable('orders', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  /** marketplace code, denormalised so (vendor, marketplace, external order id) can be unique across a vendor's accounts */
  marketplace: text('marketplace').notNull(),
  externalOrderId: text('external_order_id').notNull(),
  /** human-friendly internal number, assigned per vendor */
  orderNumber: text('order_number').notNull(),
  status: text('status').notNull().default('new'),
  /** the marketplace's own status word, verbatim */
  marketplaceStatus: text('marketplace_status'),
  statusChangedAt: tz('status_changed_at').notNull().defaultNow(),
  paymentMethod: text('payment_method').notNull().default('unknown'),
  paymentStatus: text('payment_status').notNull().default('unknown'),
  codAmountMinor: minor('cod_amount_minor'),
  inventoryStatus: text('inventory_status').notNull().default('pending'),
  /** set when the order needs a human (unmapped SKU, short stock, ...) */
  attentionReason: text('attention_reason'),
  warehouseId: uuid('warehouse_id'),
  trackingNumber: text('tracking_number'),
  carrier: text('carrier'),
  dispatchedAt: tz('dispatched_at'),
  deliveredAt: tz('delivered_at'),
  cancelledAt: tz('cancelled_at'),
  cancelReason: text('cancel_reason'),
  lastMarketplaceSyncAt: tz('last_marketplace_sync_at'),
  placedAt: tz('placed_at').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  subtotalMinor: minor('subtotal_minor').notNull().default(0),
  taxMinor: minor('tax_minor').notNull().default(0),
  shippingMinor: minor('shipping_minor').notNull().default(0),
  discountMinor: minor('discount_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull().default(0),
  /** buyer PII: encrypted at the application layer where marketplace policy requires it */
  buyer: jsonb('buyer').$type<Record<string, unknown>>().notNull().default({}),
  shippingAddress: jsonb('shipping_address').$type<Record<string, unknown>>().notNull().default({}),
  /** original marketplace payload, kept for audit/reprocessing */
  rawPayload: jsonb('raw_payload'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('orders_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('orders_account_external_uq').on(t.marketplaceAccountId, t.externalOrderId),
  /** an order is unique per (vendor, marketplace, marketplace order id): the ingestion duplicate guard */
  uniqueIndex('orders_vendor_marketplace_external_uq').on(t.vendorId, t.marketplace, t.externalOrderId),
  uniqueIndex('orders_vendor_number_uq').on(t.vendorId, t.orderNumber),
  index('orders_vendor_attention_idx').on(t.vendorId, t.placedAt.desc()).where(sql`${t.attentionReason} IS NOT NULL`),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'orders_warehouse_fk' }),
  index('orders_vendor_status_placed_idx').on(t.vendorId, t.status, t.placedAt.desc(), t.id),
  index('orders_vendor_placed_idx').on(t.vendorId, t.placedAt.desc(), t.id),
  index('orders_vendor_warehouse_idx').on(t.vendorId, t.warehouseId, t.placedAt.desc()),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'orders_account_fk' }),
  check('orders_status_chk', inList('status', ORDER_STATUSES)),
  check('orders_payment_method_chk', inList('payment_method', PAYMENT_METHODS)),
  check('orders_inventory_status_chk', inList('inventory_status', ORDER_INVENTORY_STATUSES)),
]);

export const orderItems = pgTable('order_items', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  externalItemId: text('external_item_id').notNull(),
  variantId: uuid('variant_id'),
  listingId: uuid('listing_id'),
  sku: text('sku').notNull(),
  title: text('title').notNull(),
  quantity: integer('quantity').notNull(),
  /** how many units are held in inventory for this line (< quantity = short) */
  reservedQuantity: integer('reserved_quantity').notNull().default(0),
  externalListingId: text('external_listing_id'),
  unitPriceMinor: minor('unit_price_minor').notNull(),
  taxMinor: minor('tax_minor').notNull().default(0),
  discountMinor: minor('discount_minor').notNull().default(0),
  status: text('status').notNull().default('new'),
  ...timestamps(),
}, (t) => [
  unique('order_items_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('order_items_order_external_uq').on(t.orderId, t.externalItemId),
  index('order_items_vendor_order_idx').on(t.vendorId, t.orderId),
  index('order_items_vendor_variant_idx').on(t.vendorId, t.variantId),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'order_items_order_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'order_items_variant_fk' }),
  foreignKey({ columns: [t.vendorId, t.listingId], foreignColumns: [marketplaceListings.vendorId, marketplaceListings.id], name: 'order_items_listing_fk' }),
  check('order_items_qty_chk', sql`quantity > 0 AND reserved_quantity >= 0 AND reserved_quantity <= quantity`),
  check('order_items_status_chk', inList('status', ORDER_ITEM_STATUSES)),
]);
