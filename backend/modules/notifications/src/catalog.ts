import type { schema } from '@oms/database';

/**
 * Which domain events become notifications, and how. A notification type is a stable string users can set preferences for;
 * the event is just where it comes from. Adding an alert = adding a line here (and the event in the module's `consumes`).
 */
type Severity = (typeof schema.NOTIFICATION_SEVERITIES)[number];
type Channel = (typeof schema.NOTIFICATION_CHANNELS)[number];
type P = Record<string, unknown>;
const s = (v: unknown, d = ''): string => (v === undefined || v === null || v === '' ? d : String(v));
const money = (minor: unknown, currency = 'INR'): string => (typeof minor === 'number' ? `${currency} ${(minor / 100).toFixed(2)}` : '');

export interface Spec {
  type: string;
  label: string;
  severity: Severity;
  title: (p: P) => string;
  body?: (p: P) => string;
  entity?: (aggregateId: string, p: P) => { type: string; id: string } | null;
  /** same key + same recipient while the previous one is unread = one notification (alert storms collapse) */
  dedupe?: (aggregateId: string, p: P) => string | null;
}

export const DEFAULT_CHANNELS: Record<Severity, Channel[]> = { info: ['in_app'], warning: ['in_app', 'email'], critical: ['in_app', 'email', 'push'] };

export const SPECS: Record<string, Spec> = {
  'order.created': { type: 'order.new', label: 'New order received', severity: 'info', title: (p) => `New order ${s(p.orderNumber)}`, body: (p) => [s(p.marketplace), money(p.totalMinor)].filter(Boolean).join(' · '), entity: (id) => ({ type: 'order', id }) },
  'order.needs_attention': { type: 'order.attention', label: 'An order needs attention', severity: 'warning', title: (p) => `Order needs attention: ${s(p.reason, 'check the order')}`, entity: (id) => ({ type: 'order', id }), dedupe: (id, p) => `order-attention:${id}:${s(p.reason)}` },
  'order.cancellation_requested': { type: 'order.cancellation_requested', label: 'A cancellation was requested', severity: 'warning', title: (p) => `Cancellation requested for ${s(p.orderNumber)}`, body: (p) => `By ${s(p.initiator)}: ${s(p.reasonCode)}`, entity: (id) => ({ type: 'order', id }) },
  'inventory.low_stock': { type: 'inventory.low_stock', label: 'Low stock', severity: 'warning', title: (p) => `Low stock: ${s(p.available)} left (reorder level ${s(p.reorderLevel)})`, entity: (_id, p) => (p.variantId ? { type: 'variant', id: s(p.variantId) } : null), dedupe: (_id, p) => `low-stock:${s(p.variantId)}:${s(p.warehouseId)}` },
  'sync.failed': { type: 'sync.failed', label: 'A marketplace sync failed', severity: 'warning', title: (p) => `${s(p.type, 'Sync')} sync failed`, body: (p) => s(p.error), entity: (id) => ({ type: 'sync_job', id }), dedupe: (_id, p) => `sync-failed:${s(p.accountId)}:${s(p.type)}` },
  'sync.dead_lettered': { type: 'sync.dead_lettered', label: 'A marketplace sync gave up', severity: 'critical', title: (p) => `${s(p.type, 'Sync')} sync gave up after ${s(p.attempts, 'several')} attempts`, body: (p) => s(p.error), entity: (id) => ({ type: 'sync_job', id }), dedupe: (_id, p) => `sync-dead:${s(p.accountId)}:${s(p.type)}` },
  'listing.failed': { type: 'listing.rejected', label: 'A listing was rejected', severity: 'warning', title: (p) => `Listing ${s(p.sku ?? p.externalSku, '')} was rejected`.replace('  ', ' '), body: (p) => s(p.reason ?? p.error), entity: (id) => ({ type: 'listing', id }) },
  'return.received': { type: 'return.received', label: 'A return arrived', severity: 'info', title: (p) => `Return ${s(p.number)} received (${s(p.units)} unit(s))`, body: () => 'Inspect it to restock or write it off.', entity: (id) => ({ type: 'return', id }) },
  'marketplace_account.authorization_expired': { type: 'marketplace.authorization_expired', label: 'A marketplace authorisation expired', severity: 'critical', title: () => 'A marketplace authorisation expired: reconnect it', entity: (id) => ({ type: 'marketplace_account', id }), dedupe: (id) => `auth-expired:${id}` },
  'marketplace_account.disconnected': { type: 'marketplace.disconnected', label: 'A marketplace was disconnected', severity: 'critical', title: () => 'A marketplace account was disconnected', body: () => 'Orders and stock are no longer synchronised for it.', entity: (id) => ({ type: 'marketplace_account', id }), dedupe: (id) => `disconnected:${id}` },
  'fulfillment.exception_raised': { type: 'fulfillment.exception', label: 'A warehouse exception', severity: 'warning', title: (p) => `Warehouse exception on ${s(p.number)}: ${s(p.kind)}`, entity: (id) => ({ type: 'fulfillment', id }) },
  'shipment.ndr_raised': { type: 'shipment.ndr', label: 'A delivery attempt failed (NDR)', severity: 'warning', title: (p) => `Delivery failed for ${s(p.number)} (attempt ${s(p.attemptNo)})`, body: (p) => s(p.reason), entity: (id) => ({ type: 'shipment', id }), dedupe: (id, p) => `ndr:${id}:${s(p.attemptNo)}` },
  'shipment.rto_started': { type: 'shipment.rto', label: 'A shipment is returning to origin', severity: 'warning', title: (p) => `Shipment ${s(p.number)} is returning to origin (RTO)`, entity: (id) => ({ type: 'shipment', id }) },
  'webhook.dead_lettered': { type: 'webhook.dead_lettered', label: 'A marketplace webhook could not be processed', severity: 'warning', title: () => 'A marketplace webhook could not be processed', entity: (id) => ({ type: 'webhook', id }) },
};

export const TYPE_CATALOG = Object.entries(SPECS).map(([event, sp]) => ({ type: sp.type, label: sp.label, event, severity: sp.severity, defaultChannels: DEFAULT_CHANNELS[sp.severity] }));
export const NOTIFICATION_TYPES = TYPE_CATALOG.map((t) => t.type);
