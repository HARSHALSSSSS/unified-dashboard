import { sql } from 'drizzle-orm';
import { bigserial, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, minor, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { productVariants } from './catalog';
import { orderItems, orders, warehouses } from './operations';

/**
 * Returns: customer returns, marketplace returns, RTO (courier brought it back) and seller-initiated returns all become a
 * RETURN ORDER with items. Receiving puts units into the `returned` bucket; inspection decides each unit's fate
 * (restock / damaged / dispose / ...) and moves it through the inventory engine, so stock is always right.
 */
export const RETURN_SOURCES = ['customer', 'marketplace', 'rto', 'seller'] as const;
export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'in_transit', 'received', 'inspecting', 'completed', 'cancelled'] as const;
export const PICKUP_STATUSES = ['not_required', 'requested', 'scheduled', 'picked_up', 'failed'] as const;
export const REFUND_STATUSES = ['not_applicable', 'pending', 'processed', 'failed'] as const;
export const RETURN_CONDITIONS = ['sellable', 'damaged', 'defective', 'wrong_item', 'missing'] as const;
export const RETURN_DISPOSITIONS = ['restock', 'damaged', 'dispose', 'return_to_vendor', 'quarantine'] as const;
export const CANCELLATION_INITIATORS = ['customer', 'seller', 'marketplace', 'system'] as const;
export const CANCELLATION_STATUSES = ['requested', 'accepted', 'rejected', 'completed'] as const;

export const returnOrders = pgTable('return_orders', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  orderId: uuid('order_id').notNull(),
  warehouseId: uuid('warehouse_id'),
  source: text('source').notNull(),
  status: text('status').notNull().default('requested'),
  reasonCode: text('reason_code').notNull(),
  reasonText: text('reason_text'),
  /** the marketplace's own return id (idempotency for imported returns) */
  marketplaceReturnId: text('marketplace_return_id'),
  /** the shipment that is bringing it back, for RTO */
  shipmentId: uuid('shipment_id'),
  pickupStatus: text('pickup_status').notNull().default('not_required'),
  pickupAwb: text('pickup_awb'),
  pickupScheduledAt: tz('pickup_scheduled_at'),
  refundStatus: text('refund_status').notNull().default('not_applicable'),
  refundAmountMinor: minor('refund_amount_minor'),
  refundReference: text('refund_reference'),
  refundedAt: tz('refunded_at'),
  receivedAt: tz('received_at'),
  inspectedAt: tz('inspected_at'),
  completedAt: tz('completed_at'),
  notes: text('notes'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('return_orders_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('return_orders_number_uq').on(t.vendorId, t.number),
  uniqueIndex('return_orders_marketplace_uq').on(t.vendorId, t.marketplaceReturnId).where(sql`${t.marketplaceReturnId} IS NOT NULL`),
  /** an RTO produces exactly one return order per shipment */
  uniqueIndex('return_orders_shipment_uq').on(t.vendorId, t.shipmentId).where(sql`${t.shipmentId} IS NOT NULL`),
  index('return_orders_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  index('return_orders_vendor_order_idx').on(t.vendorId, t.orderId),
  index('return_orders_vendor_warehouse_idx').on(t.vendorId, t.warehouseId, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'return_orders_order_fk' }),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'return_orders_warehouse_fk' }),
  check('return_orders_source_chk', inList('source', RETURN_SOURCES)),
  check('return_orders_status_chk', inList('status', RETURN_STATUSES)),
  check('return_orders_pickup_chk', inList('pickup_status', PICKUP_STATUSES)),
  check('return_orders_refund_chk', inList('refund_status', REFUND_STATUSES)),
]);

export const returnItems = pgTable('return_items', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  returnOrderId: uuid('return_order_id').notNull(),
  orderItemId: uuid('order_item_id').notNull(),
  variantId: uuid('variant_id'),
  quantity: integer('quantity').notNull(),
  receivedQuantity: integer('received_quantity').notNull().default(0),
  /** units already given their final disposition */
  dispositionedQuantity: integer('dispositioned_quantity').notNull().default(0),
  restockedQuantity: integer('restocked_quantity').notNull().default(0),
  condition: text('condition'),
  disposition: text('disposition'),
  inspectedBy: text('inspected_by'),
  inspectedAt: tz('inspected_at'),
  notes: text('notes'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('return_items_uq').on(t.returnOrderId, t.orderItemId),
  index('return_items_vendor_return_idx').on(t.vendorId, t.returnOrderId),
  foreignKey({ columns: [t.vendorId, t.returnOrderId], foreignColumns: [returnOrders.vendorId, returnOrders.id], name: 'return_items_return_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.orderItemId], foreignColumns: [orderItems.vendorId, orderItems.id], name: 'return_items_order_item_fk' }),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'return_items_variant_fk' }),
  check('return_items_qty_chk', sql`quantity > 0 AND received_quantity >= 0 AND received_quantity <= quantity AND dispositioned_quantity >= 0 AND dispositioned_quantity <= received_quantity AND restocked_quantity >= 0 AND restocked_quantity <= dispositioned_quantity`),
  check('return_items_condition_chk', sql`condition IS NULL OR ${inList('condition', RETURN_CONDITIONS)}`),
  check('return_items_disposition_chk', sql`disposition IS NULL OR ${inList('disposition', RETURN_DISPOSITIONS)}`),
]);

export const returnEvents = pgTable('return_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  returnOrderId: uuid('return_order_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorId: text('actor_id'),
  note: text('note'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('return_events_vendor_idx').on(t.vendorId, t.returnOrderId, t.id),
  foreignKey({ columns: [t.vendorId, t.returnOrderId], foreignColumns: [returnOrders.vendorId, returnOrders.id], name: 'return_events_return_fk' }).onDelete('cascade'),
]);

/** Why and by whom an order was cancelled (or asked to be). The status change itself lives on the order + its timeline. */
export const orderCancellations = pgTable('order_cancellations', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  initiator: text('initiator').notNull(),
  reasonCode: text('reason_code').notNull(),
  reasonText: text('reason_text'),
  status: text('status').notNull().default('requested'),
  /** the order status when the cancellation was asked for: tells how far fulfilment had got */
  orderStatusAtRequest: text('order_status_at_request').notNull(),
  requestedBy: text('requested_by'),
  decidedBy: text('decided_by'),
  decidedAt: tz('decided_at'),
  decisionNote: text('decision_note'),
  releasedUnits: integer('released_units').notNull().default(0),
  ...timestamps(),
}, (t) => [
  unique('order_cancellations_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('order_cancellations_open_uq').on(t.orderId).where(sql`${t.status} = 'requested'`),
  index('order_cancellations_vendor_order_idx').on(t.vendorId, t.orderId, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'order_cancellations_order_fk' }).onDelete('cascade'),
  check('order_cancellations_initiator_chk', inList('initiator', CANCELLATION_INITIATORS)),
  check('order_cancellations_status_chk', inList('status', CANCELLATION_STATUSES)),
]);
