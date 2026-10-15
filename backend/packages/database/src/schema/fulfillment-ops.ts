import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { productVariants } from './catalog';
import { orderItems, orders, warehouses } from './operations';
import { warehouseBins } from './warehouse-ops';

/**
 * Fulfillment: what happens in a warehouse after an order is confirmed. One fulfillment per (order, warehouse): an order
 * that has to ship from two warehouses has two. Order status is DERIVED from its fulfillments (see fulfillment/domain).
 */
export const FULFILLMENT_STATUSES = [
  'confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered',
  'on_hold', 'cancelled', 'delivery_failed', 'rto_in_transit', 'rto_received',
] as const;
export const FULFILLMENT_PRIORITIES = ['normal', 'high', 'urgent'] as const;
export const PICK_LIST_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export const PICK_TASK_STATUSES = ['pending', 'partial', 'picked', 'short', 'exception', 'cancelled'] as const;
export const EXCEPTION_KINDS = ['pick_short', 'damaged', 'wrong_item', 'pack_issue', 'insufficient_stock', 'address_issue', 'ndr', 'rto', 'other'] as const;
export const EXCEPTION_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export const PACKAGE_STATUSES = ['open', 'packed', 'shipped', 'cancelled'] as const;

export const fulfillments = pgTable('fulfillments', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  orderId: uuid('order_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  status: text('status').notNull().default('confirmed'),
  /** where it was before `on_hold`, so resume returns to the right step */
  holdFrom: text('hold_from'),
  priority: text('priority').notNull().default('normal'),
  /** why this warehouse: { strategy, ruleId, reasons[], candidates[] } (explainable routing) */
  routing: jsonb('routing').$type<Record<string, unknown>>().notNull().default({}),
  pickedAt: tz('picked_at'),
  packedAt: tz('packed_at'),
  readyAt: tz('ready_at'),
  shippedAt: tz('shipped_at'),
  deliveredAt: tz('delivered_at'),
  cancelledAt: tz('cancelled_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('fulfillments_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('fulfillments_number_uq').on(t.vendorId, t.number),
  /** one LIVE fulfillment per (order, warehouse); a cancelled one may be replaced */
  uniqueIndex('fulfillments_order_warehouse_uq').on(t.orderId, t.warehouseId).where(sql`${t.status} <> 'cancelled'`),
  index('fulfillments_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  index('fulfillments_vendor_order_idx').on(t.vendorId, t.orderId),
  index('fulfillments_vendor_warehouse_idx').on(t.vendorId, t.warehouseId, t.status),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'fulfillments_order_fk' }),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'fulfillments_warehouse_fk' }),
  check('fulfillments_status_chk', inList('status', FULFILLMENT_STATUSES)),
  check('fulfillments_priority_chk', inList('priority', FULFILLMENT_PRIORITIES)),
]);

export const fulfillmentItems = pgTable('fulfillment_items', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  fulfillmentId: uuid('fulfillment_id').notNull(),
  orderItemId: uuid('order_item_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantity: integer('quantity').notNull(),
  pickedQuantity: integer('picked_quantity').notNull().default(0),
  packedQuantity: integer('packed_quantity').notNull().default(0),
  /** units that could not be picked and were accepted as short */
  shortQuantity: integer('short_quantity').notNull().default(0),
  ...timestamps(),
}, (t) => [
  unique('fulfillment_items_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('fulfillment_items_uq').on(t.fulfillmentId, t.orderItemId),
  index('fulfillment_items_vendor_fulfillment_idx').on(t.vendorId, t.fulfillmentId),
  foreignKey({ columns: [t.vendorId, t.fulfillmentId], foreignColumns: [fulfillments.vendorId, fulfillments.id], name: 'fulfillment_items_fulfillment_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.orderItemId], foreignColumns: [orderItems.vendorId, orderItems.id], name: 'fulfillment_items_order_item_fk' }),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'fulfillment_items_variant_fk' }),
  check('fulfillment_items_qty_chk', sql`quantity > 0 AND picked_quantity >= 0 AND packed_quantity >= 0 AND short_quantity >= 0 AND picked_quantity + short_quantity <= quantity AND packed_quantity <= picked_quantity`),
]);

/** Append-only timeline of a fulfillment. */
export const fulfillmentEvents = pgTable('fulfillment_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  fulfillmentId: uuid('fulfillment_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorId: text('actor_id'),
  note: text('note'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('fulfillment_events_vendor_idx').on(t.vendorId, t.fulfillmentId, t.id),
  foreignKey({ columns: [t.vendorId, t.fulfillmentId], foreignColumns: [fulfillments.vendorId, fulfillments.id], name: 'fulfillment_events_fulfillment_fk' }).onDelete('cascade'),
]);

export const pickLists = pgTable('pick_lists', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  status: text('status').notNull().default('open'),
  assignedTo: uuid('assigned_to'),
  startedAt: tz('started_at'),
  completedAt: tz('completed_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('pick_lists_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('pick_lists_number_uq').on(t.vendorId, t.number),
  index('pick_lists_vendor_status_idx').on(t.vendorId, t.warehouseId, t.status),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'pick_lists_warehouse_fk' }),
  check('pick_lists_status_chk', inList('status', PICK_LIST_STATUSES)),
]);

export const pickTasks = pgTable('pick_tasks', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  pickListId: uuid('pick_list_id').notNull(),
  fulfillmentId: uuid('fulfillment_id').notNull(),
  fulfillmentItemId: uuid('fulfillment_item_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  /** suggested source bin (null = stock is not binned) */
  binId: uuid('bin_id'),
  sequence: integer('sequence').notNull().default(0),
  quantity: integer('quantity').notNull(),
  pickedQuantity: integer('picked_quantity').notNull().default(0),
  status: text('status').notNull().default('pending'),
  /** true once a barcode scan confirmed the item (and bin) */
  verified: boolean('verified').notNull().default(false),
  pickedBy: uuid('picked_by'),
  pickedAt: tz('picked_at'),
  notes: text('notes'),
  ...timestamps(),
}, (t) => [
  unique('pick_tasks_vendor_id_id_uq').on(t.vendorId, t.id),
  index('pick_tasks_vendor_list_idx').on(t.vendorId, t.pickListId, t.sequence),
  index('pick_tasks_vendor_fulfillment_idx').on(t.vendorId, t.fulfillmentId),
  foreignKey({ columns: [t.vendorId, t.pickListId], foreignColumns: [pickLists.vendorId, pickLists.id], name: 'pick_tasks_list_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.fulfillmentId], foreignColumns: [fulfillments.vendorId, fulfillments.id], name: 'pick_tasks_fulfillment_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.fulfillmentItemId], foreignColumns: [fulfillmentItems.vendorId, fulfillmentItems.id], name: 'pick_tasks_item_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.binId], foreignColumns: [warehouseBins.vendorId, warehouseBins.id], name: 'pick_tasks_bin_fk' }),
  check('pick_tasks_status_chk', inList('status', PICK_TASK_STATUSES)),
  check('pick_tasks_qty_chk', sql`quantity > 0 AND picked_quantity >= 0 AND picked_quantity <= quantity`),
]);

/** Anything that stops a fulfillment from flowing: short pick, damaged item, wrong item, pack problem, NDR, RTO... */
export const fulfillmentExceptions = pgTable('fulfillment_exceptions', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  fulfillmentId: uuid('fulfillment_id').notNull(),
  pickTaskId: uuid('pick_task_id'),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('open'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  resolution: jsonb('resolution').$type<Record<string, unknown>>(),
  raisedBy: text('raised_by'),
  resolvedBy: text('resolved_by'),
  resolvedAt: tz('resolved_at'),
  ...timestamps(),
}, (t) => [
  unique('fulfillment_exceptions_vendor_id_id_uq').on(t.vendorId, t.id),
  index('fulfillment_exceptions_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  index('fulfillment_exceptions_vendor_fulfillment_idx').on(t.vendorId, t.fulfillmentId),
  foreignKey({ columns: [t.vendorId, t.fulfillmentId], foreignColumns: [fulfillments.vendorId, fulfillments.id], name: 'fulfillment_exceptions_fulfillment_fk' }).onDelete('cascade'),
  check('fulfillment_exceptions_kind_chk', inList('kind', EXCEPTION_KINDS)),
  check('fulfillment_exceptions_status_chk', inList('status', EXCEPTION_STATUSES)),
]);

export const packages = pgTable('packages', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  fulfillmentId: uuid('fulfillment_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  status: text('status').notNull().default('open'),
  /** printed on the package, scanned at dispatch */
  barcode: text('barcode').notNull(),
  boxType: text('box_type'),
  weightGrams: integer('weight_grams'),
  lengthMm: integer('length_mm'),
  widthMm: integer('width_mm'),
  heightMm: integer('height_mm'),
  packedBy: uuid('packed_by'),
  packedAt: tz('packed_at'),
  shipmentId: uuid('shipment_id'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('packages_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('packages_number_uq').on(t.vendorId, t.number),
  uniqueIndex('packages_barcode_uq').on(t.vendorId, t.barcode),
  index('packages_vendor_fulfillment_idx').on(t.vendorId, t.fulfillmentId),
  foreignKey({ columns: [t.vendorId, t.fulfillmentId], foreignColumns: [fulfillments.vendorId, fulfillments.id], name: 'packages_fulfillment_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'packages_warehouse_fk' }),
  check('packages_status_chk', inList('status', PACKAGE_STATUSES)),
  check('packages_dims_chk', sql`(weight_grams IS NULL OR weight_grams > 0) AND (length_mm IS NULL OR length_mm > 0) AND (width_mm IS NULL OR width_mm > 0) AND (height_mm IS NULL OR height_mm > 0)`),
]);

export const packageItems = pgTable('package_items', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  packageId: uuid('package_id').notNull(),
  fulfillmentItemId: uuid('fulfillment_item_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantity: integer('quantity').notNull(),
  /** true when the item was confirmed by a barcode scan */
  verified: boolean('verified').notNull().default(false),
  ...timestamps(),
}, (t) => [
  uniqueIndex('package_items_uq').on(t.packageId, t.fulfillmentItemId),
  index('package_items_vendor_package_idx').on(t.vendorId, t.packageId),
  foreignKey({ columns: [t.vendorId, t.packageId], foreignColumns: [packages.vendorId, packages.id], name: 'package_items_package_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.fulfillmentItemId], foreignColumns: [fulfillmentItems.vendorId, fulfillmentItems.id], name: 'package_items_item_fk' }),
  check('package_items_qty_chk', sql`quantity > 0`),
]);
