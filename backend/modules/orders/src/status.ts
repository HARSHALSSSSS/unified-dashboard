import { and, eq, inArray, schema, sql, type Tx } from '@oms/database';
import { canManualTransition, type InternalOrderStatus } from '@oms/marketplace-core';
import { AppError, Errors } from '@oms/shared';
import { commitOrder, releaseOrder } from '@oms/mod-inventory';
import { createSyncJob, type SyncJobRow } from '@oms/mod-sync';
import { effects, type OpCtx } from '@oms/module-kit';
import { itemStatusFor } from './domain';

const O = schema.orders;
const OI = schema.orderItems;
const UPD = schema.orderStatusUpdates;
export type OrderRow = typeof O.$inferSelect;
export type StatusUpdateRow = typeof UPD.$inferSelect;
type Source = (typeof schema.STATUS_EVENT_SOURCES)[number];

/** `lock`: SELECT ... FOR UPDATE, so two concurrent state changes of one order run one after the other (the second sees the first's result) */
export async function getOrderRow(tx: Tx, vendorId: string, id: string, lock = false): Promise<OrderRow> {
  const q = tx.select().from(O).where(and(eq(O.id, id), eq(O.vendorId, vendorId)));
  const [o] = await (lock ? q.for('update') : q);
  if (!o) throw Errors.notFound('Order', id);
  return o;
}

export interface TransitionOptions {
  source: Source;
  marketplaceStatus?: string | null;
  note?: string | null;
  tracking?: { number?: string; carrier?: string };
  cancelReason?: string | null;
  /** set ONLY by the fulfillment module: it owns the picking..delivered statuses of an order that is being fulfilled */
  viaFulfillment?: boolean;
  /** who asked for the cancellation (derived from the source when omitted) and the machine-readable reason */
  initiator?: (typeof schema.CANCELLATION_INITIATORS)[number];
  reasonCode?: string;
}

/**
 * THE state change of an order (manual, marketplace-reported or webhook-driven all come through here), together with its
 * inventory consequence:
 *   cancelled                       -> held stock goes back to available
 *   dispatched / in_transit / delivered -> the reservation is consumed (stock leaves the warehouse)
 * plus the timeline entry, the item statuses and the domain events. One transaction: the state and the stock cannot disagree.
 */
export async function performTransition(tx: Tx, ctx: OpCtx, order: OrderRow, to: InternalOrderStatus, opts: TransitionOptions): Promise<OrderRow> {
  const { vendorId } = ctx;
  const from = order.status as InternalOrderStatus;
  const now = new Date();
  const set: Partial<typeof O.$inferInsert> = { status: to, statusChangedAt: now };
  if (opts.marketplaceStatus !== undefined) set.marketplaceStatus = opts.marketplaceStatus;
  if (opts.tracking?.number) set.trackingNumber = opts.tracking.number;
  if (opts.tracking?.carrier) set.carrier = opts.tracking.carrier;
  const left = to === 'dispatched' || to === 'in_transit' || to === 'delivered';
  if (left && !order.dispatchedAt) set.dispatchedAt = now;
  if (to === 'delivered') set.deliveredAt = now;

  let stockNote: string | null = null;
  if (to === 'cancelled') {
    set.cancelledAt = now;
    set.cancelReason = opts.cancelReason ?? opts.note ?? null;
    const released = await releaseOrder(tx, vendorId, order.id, `order ${order.orderNumber} cancelled`, ctx.actor);
    if (released > 0 || order.inventoryStatus !== 'pending') set.inventoryStatus = 'released';
    stockNote = released > 0 ? `released ${released} unit(s)` : null;
    await closeCancellation(tx, ctx, order, opts, released);
  } else if (left && order.inventoryStatus !== 'committed') {
    const committed = await commitOrder(tx, vendorId, order.id, ctx.actor);
    if (committed > 0) { set.inventoryStatus = 'committed'; stockNote = `committed ${committed} unit(s)`; }
  }

  const [updated] = await tx.update(O).set({ ...set, version: sql`${O.version} + 1` }).where(eq(O.id, order.id)).returning();
  const items = await tx.select({ id: OI.id, reserved: OI.reservedQuantity }).from(OI).where(and(eq(OI.vendorId, vendorId), eq(OI.orderId, order.id)));
  for (const it of items) await tx.update(OI).set({ status: itemStatusFor(to, it.reserved > 0) }).where(eq(OI.id, it.id));

  await tx.insert(schema.orderStatusEvents).values({
    vendorId, orderId: order.id, fromStatus: from, toStatus: to, marketplaceStatus: opts.marketplaceStatus ?? null, source: opts.source, applied: true,
    note: [opts.note, stockNote].filter(Boolean).join(' | ') || null, actorId: ctx.actor.id, metadata: opts.tracking ? { tracking: opts.tracking } : {},
  });

  const f = effects(tx, ctx);
  const payload = { orderNumber: order.orderNumber, from, to, marketplace: order.marketplaceAccountId ? order.marketplace : order.marketplace, accountId: order.marketplaceAccountId, source: opts.source, ...(to === 'cancelled' ? { initiator: opts.initiator ?? initiatorFor(opts.source), reasonCode: opts.reasonCode ?? 'other' } : {}) };
  await f.event({ type: 'order.status_changed', aggregateType: 'order', aggregateId: order.id, payload });
  const specific = { cancelled: 'order.cancelled', dispatched: 'order.dispatched', delivered: 'order.delivered', returned: 'order.returned' } as Partial<Record<InternalOrderStatus, string>>;
  if (specific[to]) await f.event({ type: specific[to]!, aggregateType: 'order', aggregateId: order.id, payload });
  await f.audit({ action: `order.${to}`, resourceType: 'order', resourceId: order.id, before: { status: from }, after: { status: to, source: opts.source }, metadata: { orderNumber: order.orderNumber } });
  return updated!;
}

/** a marketplace report we recorded but did NOT apply (late, out of order, or a step that makes no sense from here) */
export async function recordIgnored(tx: Tx, ctx: OpCtx, order: OrderRow, reported: InternalOrderStatus, marketplaceStatus: string): Promise<void> {
  await tx.insert(schema.orderStatusEvents).values({
    vendorId: ctx.vendorId, orderId: order.id, fromStatus: order.status, toStatus: reported, marketplaceStatus, source: ctx.actor.type === 'webhook' ? 'webhook' : 'marketplace', applied: false,
    note: `ignored: ${reported} is not a valid step from ${order.status}`, actorId: ctx.actor.id, metadata: {},
  });
}

const initiatorFor = (source: Source): (typeof schema.CANCELLATION_INITIATORS)[number] => (source === 'marketplace' || source === 'webhook' || source === 'sync' ? 'marketplace' : source === 'user' ? 'seller' : 'system');

/** One cancellation record per cancelled order: an accepted request is completed, otherwise a completed record is written. */
async function closeCancellation(tx: Tx, ctx: OpCtx, order: OrderRow, opts: TransitionOptions, released: number): Promise<void> {
  const C = schema.orderCancellations;
  const [open] = await tx.select().from(C).where(and(eq(C.vendorId, ctx.vendorId), eq(C.orderId, order.id), inArray(C.status, ['requested', 'accepted'])));
  if (open) {
    await tx.update(C).set({ status: 'completed', releasedUnits: released, decidedBy: open.decidedBy ?? ctx.actor.id, decidedAt: open.decidedAt ?? new Date() }).where(eq(C.id, open.id));
    return;
  }
  await tx.insert(C).values({
    vendorId: ctx.vendorId, orderId: order.id, initiator: opts.initiator ?? initiatorFor(opts.source), reasonCode: opts.reasonCode ?? 'other', reasonText: opts.cancelReason ?? opts.note ?? null,
    status: 'completed', orderStatusAtRequest: order.status, requestedBy: ctx.actor.id, decidedBy: ctx.actor.id, decidedAt: new Date(), releasedUnits: released,
  });
}

// ------------------------------------------------------------------------------------------------
// manual transition (an operator moves the order along)
// ------------------------------------------------------------------------------------------------
export async function manualTransition(tx: Tx, ctx: OpCtx, id: string, to: InternalOrderStatus, opts: Omit<TransitionOptions, 'source'> & { version?: number }): Promise<OrderRow> {
  const order = await getOrderRow(tx, ctx.vendorId, id, true);
  if (opts.version !== undefined && opts.version !== order.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: order.version } });
  const from = order.status as InternalOrderStatus;
  if (from === to) throw new AppError('INVALID_STATE', `The order is already ${to}`, { details: { status: from } });
  if (!opts.viaFulfillment && FULFILLMENT_OWNED.includes(to)) {
    const [live] = await tx.select({ id: schema.fulfillments.id }).from(schema.fulfillments).where(and(eq(schema.fulfillments.vendorId, ctx.vendorId), eq(schema.fulfillments.orderId, id), sql`${schema.fulfillments.status} <> 'cancelled'`)).limit(1);
    if (live) throw new AppError('CONFLICT', 'This order is being fulfilled: its status follows the warehouse work (pick, pack, ship) and cannot be set by hand', { details: { rule: 'managed_by_fulfillment', fulfillmentId: live.id } });
  }
  if (!canManualTransition(from, to)) throw new AppError('INVALID_STATE', `An order cannot move from ${from} to ${to}`, { details: { from, to, allowed: ALLOWED[from] } });
  return performTransition(tx, ctx, order, to, { ...opts, source: ctx.actor.type === 'user' || ctx.actor.type === 'api_key' ? 'user' : 'system' });
}
/** statuses the warehouse / shipping flow drives once an order has a fulfillment */
const FULFILLMENT_OWNED: InternalOrderStatus[] = ['picking', 'packed', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered'];
const ALLOWED: Record<InternalOrderStatus, InternalOrderStatus[]> = {
  new: ['confirmed', 'cancelled'], confirmed: ['picking', 'cancelled'], picking: ['packed', 'cancelled'], packed: ['ready_to_dispatch', 'cancelled'], ready_to_dispatch: ['dispatched', 'cancelled'],
  dispatched: ['in_transit', 'delivered', 'returned'], in_transit: ['delivered', 'returned'], delivered: ['returned'], cancelled: [], returned: [],
};

// ------------------------------------------------------------------------------------------------
// outbound: our system -> connector -> marketplace   (requested -> sent -> successful | failed | retrying | skipped)
// ------------------------------------------------------------------------------------------------
export const toStatusUpdateDto = (u: StatusUpdateRow) => ({
  id: u.id, orderId: u.orderId, marketplaceAccountId: u.marketplaceAccountId, requestedStatus: u.requestedStatus as InternalOrderStatus, status: u.status as (typeof schema.ORDER_STATUS_UPDATE_STATES)[number],
  attempts: u.attempts, marketplaceStatus: u.marketplaceStatus, errorCode: u.errorCode, errorMessage: u.errorMessage, tracking: u.tracking, syncJobId: u.syncJobId,
  requestedAt: u.requestedAt.toISOString(), sentAt: u.sentAt ? u.sentAt.toISOString() : null, completedAt: u.completedAt ? u.completedAt.toISOString() : null,
});

/**
 * Asks for the marketplace to learn about a status we just set. Idempotent per (order, status): asking twice returns the
 * same record. When the connector cannot take this status (not every marketplace lets a seller set every status) the
 * request is recorded as `skipped` with the reason, so the history shows it was a conscious no-op.
 */
export async function requestMarketplaceStatus(tx: Tx, ctx: OpCtx, order: OrderRow, status: InternalOrderStatus, tracking?: { number?: string; carrier?: string }): Promise<{ update: StatusUpdateRow; job: SyncJobRow | null }> {
  const key = `${order.id}:${status}`;
  const [have] = await tx.select().from(UPD).where(and(eq(UPD.vendorId, ctx.vendorId), eq(UPD.idempotencyKey, key)));
  if (have) return { update: have, job: null };

  const [acc] = await tx.select().from(schema.marketplaceAccounts).where(and(eq(schema.marketplaceAccounts.id, order.marketplaceAccountId), eq(schema.marketplaceAccounts.vendorId, ctx.vendorId)));
  const connector = acc ? ctx.c.connectors.get(acc.marketplace) : null;
  const can = Boolean(connector?.capabilities.orders.updateStatus && connector.updateOrderStatus && (connector.canRequestOrderStatus?.(status) ?? true)) && acc?.status === 'active';
  const base = { vendorId: ctx.vendorId, orderId: order.id, marketplaceAccountId: order.marketplaceAccountId, requestedStatus: status, idempotencyKey: key, tracking: tracking ?? null, requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : null };
  if (!can) {
    const reason = !connector?.capabilities.orders.updateStatus ? `${connector?.displayName ?? 'the marketplace'} does not let sellers update order status through the API`
      : acc?.status !== 'active' ? 'the marketplace account is not connected' : `${connector.displayName} cannot be told "${status}"`;
    const [u] = await tx.insert(UPD).values({ ...base, status: 'skipped', errorMessage: reason, completedAt: new Date() }).returning();
    return { update: u!, job: null };
  }
  const [u] = await tx.insert(UPD).values({ ...base, status: 'requested' }).returning();
  const { job } = await createSyncJob(tx, ctx.c, { vendorId: ctx.vendorId, accountId: order.marketplaceAccountId, type: 'order_status', trigger: ctx.actor.type === 'user' ? 'manual' : 'event', idempotencyKey: `order-status:${u!.id}:0`, payload: { updateId: u!.id }, requestedBy: base.requestedBy });
  await tx.update(UPD).set({ syncJobId: job.id }).where(eq(UPD.id, u!.id));
  return { update: { ...u!, syncJobId: job.id }, job };
}

/** operator retry of a failed update: back to `requested` with a fresh job */
export async function retryStatusUpdate(tx: Tx, ctx: OpCtx, orderId: string, updateId: string): Promise<{ update: StatusUpdateRow; job: SyncJobRow }> {
  const [u] = await tx.select().from(UPD).where(and(eq(UPD.id, updateId), eq(UPD.orderId, orderId), eq(UPD.vendorId, ctx.vendorId)));
  if (!u) throw Errors.notFound('Status update', updateId);
  if (u.status !== 'failed') throw new AppError('INVALID_STATE', `Only a failed update can be retried (this one is ${u.status})`, { details: { status: u.status } });
  const [next] = await tx.update(UPD).set({ status: 'requested', errorCode: null, errorMessage: null, completedAt: null }).where(eq(UPD.id, u.id)).returning();
  const { job } = await createSyncJob(tx, ctx.c, { vendorId: ctx.vendorId, accountId: u.marketplaceAccountId, type: 'order_status', trigger: 'manual', idempotencyKey: `order-status:${u.id}:${Date.now()}`, payload: { updateId: u.id }, requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : null });
  await tx.update(UPD).set({ syncJobId: job.id }).where(eq(UPD.id, u.id));
  await effects(tx, ctx).audit({ action: 'order.status_update_retry', resourceType: 'order', resourceId: orderId, metadata: { updateId, status: u.requestedStatus } });
  return { update: { ...next!, syncJobId: job.id }, job };
}
