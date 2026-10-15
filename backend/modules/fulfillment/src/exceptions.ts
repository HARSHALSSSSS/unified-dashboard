import { and, eq, inArray, keyset, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { clearAttention } from '@oms/mod-orders';
import { effects, type OpCtx } from '@oms/module-kit';
import { getFulfillment, moveFulfillment, cancelFulfillment, holdFulfillment, type Work } from './core';

const X = schema.fulfillmentExceptions;
export type ExceptionRow = typeof X.$inferSelect;
type Kind = (typeof schema.EXCEPTION_KINDS)[number];

export const toExceptionDto = (x: ExceptionRow) => ({
  id: x.id, fulfillmentId: x.fulfillmentId, pickTaskId: x.pickTaskId, kind: x.kind as Kind, status: x.status as (typeof schema.EXCEPTION_STATUSES)[number], details: x.details, resolution: x.resolution,
  raisedBy: x.raisedBy, resolvedBy: x.resolvedBy, resolvedAt: x.resolvedAt ? x.resolvedAt.toISOString() : null, createdAt: x.createdAt.toISOString(),
});

/** Record something that stops a fulfillment flowing. Alerts the vendor through the `fulfillment.exception_raised` event. */
export async function raiseException(tx: Tx, ctx: OpCtx, fulfillmentId: string, kind: Kind, details: Record<string, unknown> = {}, pickTaskId?: string | null): Promise<ExceptionRow> {
  const f = await getFulfillment(tx, ctx.vendorId, fulfillmentId);
  const [x] = await tx.insert(X).values({ vendorId: ctx.vendorId, fulfillmentId, pickTaskId: pickTaskId ?? null, kind, details, raisedBy: ctx.actor.id }).returning();
  const fx = effects(tx, ctx);
  await fx.event({ type: 'fulfillment.exception_raised', aggregateType: 'fulfillment', aggregateId: fulfillmentId, payload: { number: f.number, orderId: f.orderId, warehouseId: f.warehouseId, exceptionId: x!.id, kind, details } });
  await fx.audit({ action: 'fulfillment.exception_raised', resourceType: 'fulfillment', resourceId: fulfillmentId, after: { exceptionId: x!.id, kind } });
  return x!;
}

export async function getException(tx: Tx, vendorId: string, id: string): Promise<ExceptionRow> {
  const [x] = await tx.select().from(X).where(and(eq(X.id, id), eq(X.vendorId, vendorId)));
  if (!x) throw Errors.notFound('Exception', id);
  return x;
}

export async function listExceptions(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; kind?: string; fulfillmentId?: string; allowedWarehouses?: string[] | null }) {
  const ks = keyset<ExceptionRow>({ sorts: { createdAt: { column: X.createdAt, kind: 'timestamp' } }, idColumn: X.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select({ x: X }).from(X).innerJoin(schema.fulfillments, and(eq(schema.fulfillments.id, X.fulfillmentId), eq(schema.fulfillments.vendorId, X.vendorId)))
    .where(and(eq(X.vendorId, vendorId), q.status ? eq(X.status, q.status) : undefined, q.kind ? eq(X.kind, q.kind) : undefined, q.fulfillmentId ? eq(X.fulfillmentId, q.fulfillmentId) : undefined,
      q.allowedWarehouses ? (q.allowedWarehouses.length ? inArray(schema.fulfillments.warehouseId, q.allowedWarehouses) : sql`false`) : undefined, ks.where))
    .orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows.map((r) => r.x), (r) => ({ sortValue: r.createdAt, id: r.id }));
}

/**
 * Close an exception. `action` is what the operator decided: `none` (just acknowledge), `hold` (park the fulfillment until sorted out)
 * or `cancel_fulfillment` (give up on this warehouse's part; the reservation stays with the order for re-routing).
 */
export async function resolveException(tx: Tx, ctx: OpCtx, w: Work, id: string, input: { status: 'resolved' | 'dismissed'; note?: string | null; action?: 'none' | 'hold' | 'cancel_fulfillment' }): Promise<ExceptionRow> {
  const x = await getException(tx, ctx.vendorId, id);
  if (x.status !== 'open') throw new AppError('INVALID_STATE', `This exception is already ${x.status}`, { details: { status: x.status } });
  const action = input.action ?? 'none';
  const [after] = await tx.update(X).set({ status: input.status, resolvedAt: new Date(), resolvedBy: ctx.actor.id, resolution: { note: input.note ?? null, action } }).where(eq(X.id, id)).returning();
  await effects(tx, ctx).audit({ action: 'fulfillment.exception_resolved', resourceType: 'fulfillment', resourceId: x.fulfillmentId, before: { status: 'open' }, after: { exceptionId: id, status: input.status, action } });
  if (x.kind === 'pick_short') {
    // the flag belongs to the ORDER: clear it only when no fulfillment of that order still has an open short pick
    const orderId = (await getFulfillment(tx, ctx.vendorId, x.fulfillmentId)).orderId;
    const [still] = await tx.select({ id: X.id }).from(X).innerJoin(schema.fulfillments, and(eq(schema.fulfillments.id, X.fulfillmentId), eq(schema.fulfillments.vendorId, X.vendorId)))
      .where(and(eq(X.vendorId, ctx.vendorId), eq(X.kind, 'pick_short'), eq(X.status, 'open'), eq(schema.fulfillments.orderId, orderId)));
    if (!still) await clearAttention(tx, ctx, orderId, 'short_pick');
  }
  if (action === 'hold') await holdFulfillment(tx, ctx, w, x.fulfillmentId, input.note ?? `exception ${x.kind}`);
  if (action === 'cancel_fulfillment') await cancelFulfillment(tx, ctx, w, x.fulfillmentId, input.note ?? `exception ${x.kind}`);
  return after!;
}

export { moveFulfillment };
