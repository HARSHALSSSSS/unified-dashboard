import { bigserial, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, pk, tenantId, timestamps, tz } from './_helpers';
import { vendors } from './identity';
import { marketplaceAccounts } from './marketplace';
import { orders } from './operations';
import { syncJobs } from './platform';

export const STATUS_EVENT_SOURCES = ['marketplace', 'user', 'system', 'webhook', 'sync'] as const;
/** requested -> sent -> successful | failed | retrying | skipped (nothing to tell the marketplace) */
export const ORDER_STATUS_UPDATE_STATES = ['requested', 'sent', 'successful', 'failed', 'retrying', 'skipped'] as const;

/** Order timeline: append-only, one row per status change we recorded (including ignored marketplace regressions). */
export const orderStatusEvents = pgTable('order_status_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  marketplaceStatus: text('marketplace_status'),
  source: text('source').notNull(),
  /** false when a marketplace report was recorded but NOT applied (late / out of order / not allowed) */
  applied: boolean('applied').notNull().default(true),
  note: text('note'),
  actorId: text('actor_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('order_status_events_vendor_order_idx').on(t.vendorId, t.orderId, t.id),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'order_status_events_order_fk' }).onDelete('cascade'),
  check('order_status_events_source_chk', inList('source', STATUS_EVENT_SOURCES)),
]);

/** Our system -> connector -> marketplace: one row per status we asked a marketplace to apply. */
export const orderStatusUpdates = pgTable('order_status_updates', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  marketplaceAccountId: uuid('marketplace_account_id').notNull(),
  requestedStatus: text('requested_status').notNull(),
  status: text('status').notNull().default('requested'),
  /** (order, requested status) — asking twice returns the same row */
  idempotencyKey: text('idempotency_key').notNull(),
  attempts: integer('attempts').notNull().default(0),
  marketplaceStatus: text('marketplace_status'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  tracking: jsonb('tracking').$type<{ number?: string; carrier?: string }>(),
  syncJobId: uuid('sync_job_id'),
  requestedBy: uuid('requested_by'),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  sentAt: tz('sent_at'),
  completedAt: tz('completed_at'),
  ...timestamps(),
}, (t) => [
  unique('order_status_updates_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('order_status_updates_idem_uq').on(t.vendorId, t.idempotencyKey),
  index('order_status_updates_vendor_order_idx').on(t.vendorId, t.orderId, t.requestedAt.desc()),
  foreignKey({ columns: [t.vendorId, t.orderId], foreignColumns: [orders.vendorId, orders.id], name: 'order_status_updates_order_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'order_status_updates_account_fk' }),
  foreignKey({ columns: [t.vendorId, t.syncJobId], foreignColumns: [syncJobs.vendorId, syncJobs.id], name: 'order_status_updates_job_fk' }),
  check('order_status_updates_status_chk', inList('status', ORDER_STATUS_UPDATE_STATES)),
]);

