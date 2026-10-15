import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, minor, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { orders, warehouses } from './operations';
import { fulfillments } from './fulfillment-ops';

/**
 * Shipping is an abstraction: a vendor enables one or more PROVIDERS (a courier integration, the sandbox courier, or
 * "manual" where staff type the AWB). Shipments, tracking, manifests and NDR/RTO are provider-neutral.
 */
export const SHIPMENT_STATUSES = [
  'created', 'label_ready', 'manifested', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered',
  'delivery_failed', 'rto_initiated', 'rto_in_transit', 'rto_delivered', 'cancelled',
] as const;
export const MANIFEST_STATUSES = ['open', 'closed', 'dispatched', 'cancelled'] as const;
export const NDR_STATUSES = ['open', 'action_requested', 'resolved', 'rto'] as const;
export const NDR_ACTIONS = ['reattempt', 'rto', 'update_address', 'contact_customer'] as const;

export const vendorShippingProviders = pgTable('vendor_shipping_providers', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  providerCode: text('provider_code').notNull(),
  label: text('label').notNull(),
  status: text('status').notNull().default('active'),
  isDefault: boolean('is_default').notNull().default(false),
  /** non-secret provider settings (service defaults, pickup location ids ...). Credentials will be stored encrypted when a real courier is added. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('vendor_shipping_providers_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('vendor_shipping_providers_uq').on(t.vendorId, t.providerCode),
  uniqueIndex('vendor_shipping_providers_default_uq').on(t.vendorId).where(sql`${t.isDefault}`),
  check('vendor_shipping_providers_status_chk', inList('status', ['active', 'disabled'])),
]);

export const manifests = pgTable('manifests', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  providerCode: text('provider_code').notNull(),
  status: text('status').notNull().default('open'),
  providerRef: text('provider_ref'),
  documentKey: text('document_key'),
  closedAt: tz('closed_at'),
  dispatchedAt: tz('dispatched_at'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('manifests_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('manifests_number_uq').on(t.vendorId, t.number),
  index('manifests_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'manifests_warehouse_fk' }),
  check('manifests_status_chk', inList('status', MANIFEST_STATUSES)),
]);

export const shipments = pgTable('shipments', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  fulfillmentId: uuid('fulfillment_id').notNull(),
  orderId: uuid('order_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  providerCode: text('provider_code').notNull(),
  service: text('service'),
  carrier: text('carrier'),
  /** air waybill / tracking number */
  awb: text('awb'),
  trackingUrl: text('tracking_url'),
  /** object-storage key of the shipping label */
  labelKey: text('label_key'),
  status: text('status').notNull().default('created'),
  costMinor: minor('cost_minor'),
  codAmountMinor: minor('cod_amount_minor'),
  weightGrams: integer('weight_grams'),
  manifestId: uuid('manifest_id'),
  attempts: integer('attempts').notNull().default(0),
  isRto: boolean('is_rto').notNull().default(false),
  estimatedDeliveryAt: tz('estimated_delivery_at'),
  dispatchedAt: tz('dispatched_at'),
  deliveredAt: tz('delivered_at'),
  rtoDeliveredAt: tz('rto_delivered_at'),
  cancelledAt: tz('cancelled_at'),
  lastTrackedAt: tz('last_tracked_at'),
  /** provider-specific reference data, never interpreted by core */
  providerData: jsonb('provider_data').$type<Record<string, unknown>>().notNull().default({}),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('shipments_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('shipments_number_uq').on(t.vendorId, t.number),
  /** per TENANT: a vendor-typed AWB ("manual" provider) must neither collide with, nor reveal, another tenant's */
  uniqueIndex('shipments_provider_awb_uq').on(t.vendorId, t.providerCode, t.awb).where(sql`${t.awb} IS NOT NULL`),
  index('shipments_vendor_warehouse_idx').on(t.vendorId, t.warehouseId, t.createdAt.desc()),
  /** one live shipment per fulfillment */
  uniqueIndex('shipments_active_fulfillment_uq').on(t.fulfillmentId).where(sql`${t.status} <> 'cancelled'`),
  index('shipments_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  index('shipments_vendor_order_idx').on(t.vendorId, t.orderId),
  index('shipments_tracking_idx').on(t.status, t.lastTrackedAt).where(sql`${t.status} IN ('dispatched','in_transit','out_for_delivery','delivery_failed','rto_initiated','rto_in_transit')`),
  foreignKey({ columns: [t.vendorId, t.fulfillmentId], foreignColumns: [fulfillments.vendorId, fulfillments.id], name: 'shipments_fulfillment_fk' }),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'shipments_order_fk' }),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'shipments_warehouse_fk' }),
  foreignKey({ columns: [t.vendorId, t.manifestId], foreignColumns: [manifests.vendorId, manifests.id], name: 'shipments_manifest_fk' }),
  check('shipments_status_chk', inList('status', SHIPMENT_STATUSES)),
]);

/** Append-only. (shipment, provider_event_id) is unique so a re-polled event is never applied twice. */
export const shipmentTrackingEvents = pgTable('shipment_tracking_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  shipmentId: uuid('shipment_id').notNull(),
  status: text('status').notNull(),
  rawStatus: text('raw_status'),
  location: text('location'),
  note: text('note'),
  providerEventId: text('provider_event_id').notNull(),
  source: text('source').notNull().default('provider'),
  occurredAt: tz('occurred_at').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('shipment_tracking_events_uq').on(t.shipmentId, t.providerEventId),
  index('shipment_tracking_events_vendor_idx').on(t.vendorId, t.shipmentId, t.occurredAt),
  foreignKey({ columns: [t.vendorId, t.shipmentId], foreignColumns: [shipments.vendorId, shipments.id], name: 'shipment_tracking_events_shipment_fk' }).onDelete('cascade'),
  check('shipment_tracking_events_status_chk', inList('status', SHIPMENT_STATUSES)),
]);

/** Non-Delivery Report: a delivery attempt failed and the courier asks what to do. */
export const ndrCases = pgTable('ndr_cases', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  shipmentId: uuid('shipment_id').notNull(),
  orderId: uuid('order_id').notNull(),
  attemptNo: integer('attempt_no').notNull(),
  reasonCode: text('reason_code').notNull(),
  reasonText: text('reason_text'),
  status: text('status').notNull().default('open'),
  action: text('action'),
  actionBy: text('action_by'),
  nextAttemptAt: tz('next_attempt_at'),
  resolvedAt: tz('resolved_at'),
  ...timestamps(),
}, (t) => [
  unique('ndr_cases_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('ndr_cases_attempt_uq').on(t.shipmentId, t.attemptNo),
  index('ndr_cases_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.shipmentId], foreignColumns: [shipments.vendorId, shipments.id], name: 'ndr_cases_shipment_fk' }).onDelete('cascade'),
  check('ndr_cases_status_chk', inList('status', NDR_STATUSES)),
]);
