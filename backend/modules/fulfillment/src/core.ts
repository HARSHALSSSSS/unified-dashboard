import { and, eq, inArray, keyset, schema, sql, type Tx } from '@oms/database';
import type { InternalOrderStatus } from '@oms/marketplace-core';
import { AppError, Errors } from '@oms/shared';
import { nextCounter } from '@oms/mod-inventory';
import { getOrderRow, transitionWithin } from '@oms/mod-orders';
import { dispatchSyncJob, type SyncJobRow } from '@oms/mod-sync';
import { effects, type Container, type OpCtx } from '@oms/module-kit';
import { canHold, canResumeTo, canTransition, deriveOrderStatus, orderPath, type FulfillmentStatus } from './domain';

export const F = schema.fulfillments;
export const FI = schema.fulfillmentItems;
export type FulfillmentRow = typeof F.$inferSelect;
export type FulfillmentItemRow = typeof FI.$inferSelect;

/** Work to do AFTER the transaction commits (marketplace status pushes are queued jobs; they must not start before the data exists). */
export class Work {
  readonly jobs: SyncJobRow[] = [];
  add(job: SyncJobRow | null | undefined): void { if (job) this.jobs.push(job); }
  async flush(c: Container): Promise<void> { for (const j of this.jobs) await dispatchSyncJob(c, j); this.jobs.length = 0; }
}

/** `lock`: SELECT ... FOR UPDATE, so concurrent changes to one fulfillment (cancel vs the last pick, two pick lists...) are serialised */
export async function getFulfillment(tx: Tx, vendorId: string, id: string, lock = false): Promise<FulfillmentRow> {
  const q = tx.select().from(F).where(and(eq(F.id, id), eq(F.vendorId, vendorId)));
  const [f] = await (lock ? q.for('update') : q);
  if (!f) throw Errors.notFound('Fulfillment', id);
  return f;
}

export async function itemsOf(tx: Tx, vendorId: string, fulfillmentId: string): Promise<FulfillmentItemRow[]> {
  return tx.select().from(FI).where(and(eq(FI.vendorId, vendorId), eq(FI.fulfillmentId, fulfillmentId))).orderBy(FI.createdAt, FI.id);
}

export const numberFor = async (tx: Tx, vendorId: string, kind: 'fulfillment' | 'pick_list' | 'package'): Promise<string> =>
  `${{ fulfillment: 'FUL', pick_list: 'PL', package: 'PKG' }[kind]}-${String(await nextCounter(tx, vendorId, kind)).padStart(6, '0')}`;

export async function recordEvent(tx: Tx, ctx: OpCtx, f: Pick<FulfillmentRow, 'id'>, from: string | null, to: string, note?: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
  await tx.insert(schema.fulfillmentEvents).values({ vendorId: ctx.vendorId, fulfillmentId: f.id, fromStatus: from, toStatus: to, actorId: ctx.actor.id, note: note ?? null, metadata });
}

const STAMP: Partial<Record<FulfillmentStatus, keyof typeof F.$inferInsert>> = { picked: 'pickedAt', packed: 'packedAt', ready_to_ship: 'readyAt', shipped: 'shippedAt', delivered: 'deliveredAt', cancelled: 'cancelledAt' };
const EVENT: Partial<Record<FulfillmentStatus, string>> = { picked: 'fulfillment.picked', packed: 'fulfillment.packed', ready_to_ship: 'fulfillment.ready', shipped: 'fulfillment.shipped', delivered: 'fulfillment.delivered', cancelled: 'fulfillment.cancelled' };

/**
 * THE fulfillment state change. Validates the transition, stamps it, writes the timeline + audit + event and then brings the
 * ORDER status in line (stepping through every intermediate order status so the marketplace sees them in order).
 */
export async function moveFulfillment(tx: Tx, ctx: OpCtx, w: Work, id: string, to: FulfillmentStatus, opts: { note?: string | null; metadata?: Record<string, unknown>; tracking?: { number?: string; carrier?: string }; force?: boolean } = {}): Promise<FulfillmentRow> {
  const f = await getFulfillment(tx, ctx.vendorId, id, true);
  const from = f.status as FulfillmentStatus;
  if (from === to) return f;
  if (!opts.force && !canTransition(from, to)) throw new AppError('INVALID_STATE', `A fulfillment cannot move from ${from} to ${to}`, { details: { from, to, allowed: [...(await import('./domain')).TRANSITIONS[from]] } });
  const stamp = STAMP[to];
  const [after] = await tx.update(F).set({ status: to, ...(stamp ? { [stamp]: new Date() } : {}), ...(to === 'on_hold' ? { holdFrom: from } : { holdFrom: null }), version: sql`${F.version} + 1` }).where(eq(F.id, id)).returning();
  await recordEvent(tx, ctx, f, from, to, opts.note, opts.metadata);
  const fx = effects(tx, ctx);
  const payload = { number: f.number, orderId: f.orderId, warehouseId: f.warehouseId, from, to };
  if (EVENT[to]) await fx.event({ type: EVENT[to]!, aggregateType: 'fulfillment', aggregateId: id, payload });
  await fx.audit({ action: `fulfillment.${to}`, resourceType: 'fulfillment', resourceId: id, before: { status: from }, after: { status: to }, metadata: { number: f.number, orderId: f.orderId, ...(opts.note ? { note: opts.note } : {}) } });
  await syncOrderStatus(tx, ctx, w, f.orderId, { tracking: opts.tracking });
  return after!;
}

/** Walk the order forward, one valid step at a time, to the status its fulfillments imply. Never moves an order backwards. */
export async function syncOrderStatus(tx: Tx, ctx: OpCtx, w: Work, orderId: string, opts: { tracking?: { number?: string; carrier?: string } } = {}): Promise<void> {
  const order = await getOrderRow(tx, ctx.vendorId, orderId);
  if (order.status === 'cancelled' || order.status === 'returned') return;
  const statuses = (await tx.select({ s: F.status }).from(F).where(and(eq(F.vendorId, ctx.vendorId), eq(F.orderId, orderId)))).map((r) => r.s as FulfillmentStatus);
  const target = deriveOrderStatus(statuses);
  if (!target) return;
  let steps: InternalOrderStatus[];
  if (target === 'returned') steps = ['returned'];
  else steps = orderPath(order.status as InternalOrderStatus, target);
  for (const step of steps) {
    const res = await transitionWithin(tx, ctx, orderId, step, { viaFulfillment: true, note: 'fulfillment', ...(step === 'dispatched' && opts.tracking ? { tracking: opts.tracking } : {}) });
    w.add(res.sync.job);
  }
}

// ------------------------------------------------------------------------------------------------
// hold / resume / cancel
// ------------------------------------------------------------------------------------------------
export async function holdFulfillment(tx: Tx, ctx: OpCtx, w: Work, id: string, reason: string): Promise<FulfillmentRow> {
  const f = await getFulfillment(tx, ctx.vendorId, id);
  if (!canHold(f.status as FulfillmentStatus)) throw new AppError('INVALID_STATE', `A ${f.status} fulfillment cannot be put on hold`, { details: { status: f.status } });
  return moveFulfillment(tx, ctx, w, id, 'on_hold', { note: reason });
}

export async function resumeFulfillment(tx: Tx, ctx: OpCtx, w: Work, id: string): Promise<FulfillmentRow> {
  const f = await getFulfillment(tx, ctx.vendorId, id);
  if (f.status !== 'on_hold' || !canResumeTo(f.holdFrom)) throw new AppError('INVALID_STATE', 'Only a fulfillment on hold can be resumed', { details: { status: f.status } });
  const back = f.holdFrom as FulfillmentStatus;
  const [after] = await tx.update(F).set({ status: back, holdFrom: null, version: sql`${F.version} + 1` }).where(eq(F.id, id)).returning();
  await recordEvent(tx, ctx, f, 'on_hold', back, 'resumed');
  await effects(tx, ctx).audit({ action: 'fulfillment.resumed', resourceType: 'fulfillment', resourceId: id, before: { status: 'on_hold' }, after: { status: back } });
  await syncOrderStatus(tx, ctx, w, f.orderId);
  return after!;
}

/**
 * Cancel the warehouse work for a fulfillment: open pick tasks are cancelled, units already picked from bins go back to the
 * bin they came from, packages are voided, open exceptions are dismissed. Stock RESERVATIONS are not touched here (the order
 * cancellation releases them; a re-route moves them).
 */
export async function cancelFulfillment(tx: Tx, ctx: OpCtx, w: Work, id: string, reason: string): Promise<FulfillmentRow> {
  const f = await getFulfillment(tx, ctx.vendorId, id);
  const status = f.status as FulfillmentStatus;
  if (!(['confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'on_hold'] as string[]).includes(status)) throw new AppError('INVALID_STATE', `A ${status} fulfillment cannot be cancelled`, { details: { status } });
  const { addToBin } = await import('@oms/mod-inventory');
  const tasks = await tx.select().from(schema.pickTasks).where(and(eq(schema.pickTasks.vendorId, ctx.vendorId), eq(schema.pickTasks.fulfillmentId, id)));
  for (const t of tasks) {
    if (t.pickedQuantity > 0 && t.binId) await addToBin(tx, { vendorId: ctx.vendorId, variantId: t.variantId, warehouseId: f.warehouseId, binId: t.binId, quantity: t.pickedQuantity }).catch(() => undefined); // the bin may be gone/blocked: units become unbinned, stock is unaffected
    if (t.status !== 'cancelled') await tx.update(schema.pickTasks).set({ status: 'cancelled' }).where(eq(schema.pickTasks.id, t.id));
  }
  await tx.update(schema.packages).set({ status: 'cancelled' }).where(and(eq(schema.packages.vendorId, ctx.vendorId), eq(schema.packages.fulfillmentId, id), inArray(schema.packages.status, ['open', 'packed'])));
  await tx.update(schema.fulfillmentExceptions).set({ status: 'dismissed', resolvedAt: new Date(), resolvedBy: ctx.actor.id, resolution: { reason: 'fulfillment cancelled' } }).where(and(eq(schema.fulfillmentExceptions.vendorId, ctx.vendorId), eq(schema.fulfillmentExceptions.fulfillmentId, id), eq(schema.fulfillmentExceptions.status, 'open')));
  await closeFinishedPickLists(tx, ctx.vendorId);
  return moveFulfillment(tx, ctx, w, id, 'cancelled', { note: reason, force: status === 'on_hold' });
}

/** a pick list whose every task is finished (picked / short / cancelled) is completed; one with only cancelled tasks is cancelled */
export async function closeFinishedPickLists(tx: Tx, vendorId: string): Promise<void> {
  const PL = schema.pickLists;
  const PT = schema.pickTasks;
  const open = await tx.select().from(PL).where(and(eq(PL.vendorId, vendorId), inArray(PL.status, ['open', 'in_progress'])));
  for (const l of open) {
    const tasks = await tx.select({ s: PT.status }).from(PT).where(and(eq(PT.vendorId, vendorId), eq(PT.pickListId, l.id)));
    if (tasks.length === 0) continue;
    if (tasks.every((t) => t.s === 'cancelled')) await tx.update(PL).set({ status: 'cancelled', completedAt: new Date() }).where(eq(PL.id, l.id));
    else if (tasks.every((t) => ['picked', 'short', 'cancelled'].includes(t.s))) await tx.update(PL).set({ status: 'completed', completedAt: new Date() }).where(eq(PL.id, l.id));
  }
}

// ------------------------------------------------------------------------------------------------
// reads
// ------------------------------------------------------------------------------------------------
export interface FulfillmentFilter { limit: number; cursor?: string; status?: string; warehouseId?: string; orderId?: string; priority?: string; allowedWarehouses?: string[] | null }

export async function listFulfillments(tx: Tx, vendorId: string, q: FulfillmentFilter) {
  const ks = keyset<FulfillmentRow>({ sorts: { createdAt: { column: F.createdAt, kind: 'timestamp' } }, idColumn: F.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(F).where(and(
    eq(F.vendorId, vendorId), q.status ? eq(F.status, q.status) : undefined, q.warehouseId ? eq(F.warehouseId, q.warehouseId) : undefined, q.orderId ? eq(F.orderId, q.orderId) : undefined,
    q.priority ? eq(F.priority, q.priority) : undefined, q.allowedWarehouses ? inArray(F.warehouseId, q.allowedWarehouses.length ? q.allowedWarehouses : ['00000000-0000-0000-0000-000000000000']) : undefined, ks.where,
  )).orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}

export async function fulfillmentTimeline(tx: Tx, vendorId: string, id: string) {
  await getFulfillment(tx, vendorId, id);
  const E = schema.fulfillmentEvents;
  return (await tx.select().from(E).where(and(eq(E.vendorId, vendorId), eq(E.fulfillmentId, id))).orderBy(E.id)).map((e) => ({ id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, actorId: e.actorId, note: e.note, metadata: e.metadata, createdAt: e.createdAt.toISOString() }));
}

export async function fulfillmentDetail(tx: Tx, vendorId: string, id: string) {
  const f = await getFulfillment(tx, vendorId, id);
  const items = await tx.select({ i: FI, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode }).from(FI).innerJoin(schema.productVariants, and(eq(schema.productVariants.id, FI.variantId), eq(schema.productVariants.vendorId, FI.vendorId))).where(and(eq(FI.vendorId, vendorId), eq(FI.fulfillmentId, id)));
  const pkgs = await tx.select().from(schema.packages).where(and(eq(schema.packages.vendorId, vendorId), eq(schema.packages.fulfillmentId, id))).orderBy(schema.packages.createdAt);
  const pkgItems = pkgs.length ? await tx.select().from(schema.packageItems).where(and(eq(schema.packageItems.vendorId, vendorId), inArray(schema.packageItems.packageId, pkgs.map((p) => p.id)))) : [];
  const [openEx] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.fulfillmentExceptions).where(and(eq(schema.fulfillmentExceptions.vendorId, vendorId), eq(schema.fulfillmentExceptions.fulfillmentId, id), eq(schema.fulfillmentExceptions.status, 'open')));
  const [order] = await tx.select({ orderNumber: schema.orders.orderNumber, marketplace: schema.orders.marketplace, externalOrderId: schema.orders.externalOrderId, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, f.orderId));
  return toFulfillmentDto(f, items, pkgs, pkgItems, openEx?.n ?? 0, order);
}

export const toFulfillmentDto = (
  f: FulfillmentRow, items: Array<{ i: FulfillmentItemRow; sku: string; barcode: string | null }>, pkgs: Array<typeof schema.packages.$inferSelect>, pkgItems: Array<typeof schema.packageItems.$inferSelect>, openExceptions: number,
  order?: { orderNumber: string; marketplace: string; externalOrderId: string; status: string },
) => ({
  id: f.id, number: f.number, orderId: f.orderId, order: order ?? null, warehouseId: f.warehouseId, status: f.status as FulfillmentStatus, holdFrom: f.holdFrom, priority: f.priority as (typeof schema.FULFILLMENT_PRIORITIES)[number],
  routing: f.routing, openExceptions,
  items: items.map(({ i, sku, barcode }) => ({ id: i.id, orderItemId: i.orderItemId, variantId: i.variantId, sku, barcode, quantity: i.quantity, pickedQuantity: i.pickedQuantity, packedQuantity: i.packedQuantity, shortQuantity: i.shortQuantity })),
  packages: pkgs.map((p) => ({
    id: p.id, number: p.number, barcode: p.barcode, status: p.status as (typeof schema.PACKAGE_STATUSES)[number], boxType: p.boxType, weightGrams: p.weightGrams, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm,
    shipmentId: p.shipmentId, items: pkgItems.filter((x) => x.packageId === p.id).map((x) => ({ fulfillmentItemId: x.fulfillmentItemId, variantId: x.variantId, quantity: x.quantity, verified: x.verified })),
  })),
  pickedAt: f.pickedAt ? f.pickedAt.toISOString() : null, packedAt: f.packedAt ? f.packedAt.toISOString() : null, readyAt: f.readyAt ? f.readyAt.toISOString() : null,
  shippedAt: f.shippedAt ? f.shippedAt.toISOString() : null, deliveredAt: f.deliveredAt ? f.deliveredAt.toISOString() : null, cancelledAt: f.cancelledAt ? f.cancelledAt.toISOString() : null,
  version: f.version, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(),
});
