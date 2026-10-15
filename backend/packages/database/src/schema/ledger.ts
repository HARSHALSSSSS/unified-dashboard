import { sql } from 'drizzle-orm';
import { bigserial, check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { productVariants } from './catalog';
import { orderItems, orders, warehouses } from './operations';

/**
 * Inventory ledger. `inventory` rows are a cache of this table: every stock change inserts a movement in the SAME
 * transaction (service layer), movements are append-only (trigger), and `inventory_ledger_drift()` proves the cache
 * equals the sum of the ledger. Nothing overwrites a quantity without leaving a movement behind.
 */
export const MOVEMENT_TYPES = [
  'receive', 'adjust', 'reserve', 'release', 'commit', 'return_in', 'return_restock', 'damage', 'undamage',
  'incoming_add', 'incoming_receive', 'transfer_out', 'transfer_in', 'count',
] as const;
export const RESERVATION_STATUSES = ['active', 'committed', 'released'] as const;
export const TRANSFER_STATUSES = ['draft', 'in_transit', 'received', 'cancelled'] as const;

export const inventoryMovements = pgTable('inventory_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  type: text('type').notNull(),
  /** signed change per bucket */
  deltaOnHand: integer('delta_on_hand').notNull().default(0),
  deltaReserved: integer('delta_reserved').notNull().default(0),
  deltaIncoming: integer('delta_incoming').notNull().default(0),
  deltaDamaged: integer('delta_damaged').notNull().default(0),
  deltaReturned: integer('delta_returned').notNull().default(0),
  /** balances AFTER this movement (auditable running totals) */
  onHandAfter: integer('on_hand_after').notNull(),
  reservedAfter: integer('reserved_after').notNull(),
  reason: text('reason'),
  /** order | adjustment | transfer | reservation | return | manual | import */
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  /** same key + same vendor = the movement already happened (safe retries) */
  idempotencyKey: text('idempotency_key'),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  createdAt: createdAt(),
}, (t) => [
  index('inventory_movements_vendor_variant_idx').on(t.vendorId, t.variantId, t.id.desc()),
  index('inventory_movements_vendor_warehouse_idx').on(t.vendorId, t.warehouseId, t.id.desc()),
  index('inventory_movements_reference_idx').on(t.vendorId, t.referenceType, t.referenceId),
  uniqueIndex('inventory_movements_idem_uq').on(t.vendorId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'inventory_movements_variant_fk' }),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'inventory_movements_warehouse_fk' }),
  check('inventory_movements_type_chk', inList('type', MOVEMENT_TYPES)),
  check('inventory_movements_nonzero_chk', sql`delta_on_hand <> 0 OR delta_reserved <> 0 OR delta_incoming <> 0 OR delta_damaged <> 0 OR delta_returned <> 0`),
]);

/** Stock held for an order line in one warehouse. One active row per (order item, warehouse). */
export const inventoryReservations = pgTable('inventory_reservations', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  orderItemId: uuid('order_item_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  quantity: integer('quantity').notNull(),
  status: text('status').notNull().default('active'),
  releasedAt: tz('released_at'),
  committedAt: tz('committed_at'),
  ...timestamps(),
}, (t) => [
  unique('inventory_reservations_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('inventory_reservations_item_warehouse_uq').on(t.orderItemId, t.warehouseId),
  index('inventory_reservations_vendor_order_idx').on(t.vendorId, t.orderId),
  index('inventory_reservations_vendor_variant_idx').on(t.vendorId, t.variantId, t.status),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'inventory_reservations_order_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.orderItemId], foreignColumns: [orderItems.vendorId, orderItems.id], name: 'inventory_reservations_item_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'inventory_reservations_variant_fk' }),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'inventory_reservations_warehouse_fk' }),
  check('inventory_reservations_qty_chk', sql`quantity > 0`),
  check('inventory_reservations_status_chk', inList('status', RESERVATION_STATUSES)),
]);

export const stockTransfers = pgTable('stock_transfers', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  fromWarehouseId: uuid('from_warehouse_id').notNull(),
  toWarehouseId: uuid('to_warehouse_id').notNull(),
  status: text('status').notNull().default('draft'),
  notes: text('notes'),
  shippedAt: tz('shipped_at'),
  receivedAt: tz('received_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('stock_transfers_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('stock_transfers_vendor_number_uq').on(t.vendorId, t.number),
  index('stock_transfers_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.fromWarehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'stock_transfers_from_fk' }),
  foreignKey({ columns: [t.vendorId, t.toWarehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'stock_transfers_to_fk' }),
  check('stock_transfers_status_chk', inList('status', TRANSFER_STATUSES)),
  check('stock_transfers_distinct_chk', sql`from_warehouse_id <> to_warehouse_id`),
]);

export const stockTransferItems = pgTable('stock_transfer_items', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  transferId: uuid('transfer_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantity: integer('quantity').notNull(),
  receivedQuantity: integer('received_quantity').notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('stock_transfer_items_uq').on(t.transferId, t.variantId),
  index('stock_transfer_items_vendor_transfer_idx').on(t.vendorId, t.transferId),
  foreignKey({ columns: [t.vendorId, t.transferId], foreignColumns: [stockTransfers.vendorId, stockTransfers.id], name: 'stock_transfer_items_transfer_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'stock_transfer_items_variant_fk' }),
  check('stock_transfer_items_qty_chk', sql`quantity > 0 AND received_quantity >= 0 AND received_quantity <= quantity`),
]);

/** Per-vendor counters (order numbers, transfer numbers): atomic increment, no gaps-by-race. */
export const vendorCounters = pgTable('vendor_counters', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  value: integer('value').notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('vendor_counters_uq').on(t.vendorId, t.name),
]);

