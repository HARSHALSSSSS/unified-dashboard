import { and, desc, eq, schema, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { effects, type OpCtx } from '@oms/module-kit';
import { PRE_DISPATCH } from './domain';
import { transitionWithin } from './service';
import { getOrderRow } from './status';

const C = schema.orderCancellations;

/** machine-readable reasons (the free text goes next to it) */
export const CANCELLATION_REASONS = [
  { code: 'customer_changed_mind', label: 'Customer changed their mind', initiators: ['customer'] },
  { code: 'ordered_by_mistake', label: 'Ordered by mistake', initiators: ['customer'] },
  { code: 'found_cheaper', label: 'Found a cheaper price', initiators: ['customer'] },
  { code: 'delivery_too_slow', label: 'Delivery would take too long', initiators: ['customer', 'marketplace'] },
  { code: 'address_issue', label: 'Address problem', initiators: ['customer', 'seller', 'marketplace'] },
  { code: 'payment_failed', label: 'Payment failed / not received', initiators: ['marketplace', 'system'] },
  { code: 'out_of_stock', label: 'Out of stock', initiators: ['seller'] },
  { code: 'quality_issue', label: 'Quality issue found before dispatch', initiators: ['seller'] },
  { code: 'fraud_suspected', label: 'Suspected fraud', initiators: ['seller', 'marketplace', 'system'] },
  { code: 'seller_unable_to_ship', label: 'Seller cannot ship', initiators: ['seller'] },
  { code: 'marketplace_cancelled', label: 'Cancelled by the marketplace', initiators: ['marketplace'] },
  { code: 'other', label: 'Other', initiators: ['customer', 'seller', 'marketplace', 'system'] },
] as const;
export const REASON_CODES = CANCELLATION_REASONS.map((r) => r.code) as unknown as [string, ...string[]];

export type CancellationRow = typeof C.$inferSelect;
export const toCancellationDto = (c: CancellationRow) => ({
  id: c.id, orderId: c.orderId, initiator: c.initiator as (typeof schema.CANCELLATION_INITIATORS)[number], reasonCode: c.reasonCode, reasonText: c.reasonText, status: c.status as (typeof schema.CANCELLATION_STATUSES)[number],
  orderStatusAtRequest: c.orderStatusAtRequest, requestedBy: c.requestedBy, decidedBy: c.decidedBy, decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null, decisionNote: c.decisionNote, releasedUnits: c.releasedUnits,
  createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
});

export async function listCancellations(tx: Tx, vendorId: string, orderId: string) {
  await getOrderRow(tx, vendorId, orderId);
  return (await tx.select().from(C).where(and(eq(C.vendorId, vendorId), eq(C.orderId, orderId))).orderBy(desc(C.createdAt))).map(toCancellationDto);
}

/** Someone asks for the order to be cancelled (typically the customer, through the marketplace). The seller decides. */
export async function requestCancellation(tx: Tx, ctx: OpCtx, orderId: string, input: { initiator: (typeof schema.CANCELLATION_INITIATORS)[number]; reasonCode: string; reasonText?: string | null }) {
  const order = await getOrderRow(tx, ctx.vendorId, orderId);
  if (!(PRE_DISPATCH as readonly string[]).includes(order.status)) throw new AppError('INVALID_STATE', `An order that is ${order.status} can no longer be cancelled`, { details: { status: order.status } });
  const [open] = await tx.select({ id: C.id }).from(C).where(and(eq(C.vendorId, ctx.vendorId), eq(C.orderId, orderId), eq(C.status, 'requested')));
  if (open) throw new AppError('CONFLICT', 'A cancellation request is already waiting for a decision', { details: { cancellationId: open.id } });
  const [row] = await tx.insert(C).values({ vendorId: ctx.vendorId, orderId, initiator: input.initiator, reasonCode: input.reasonCode, reasonText: input.reasonText ?? null, status: 'requested', orderStatusAtRequest: order.status, requestedBy: ctx.actor.id }).returning();
  const f = effects(tx, ctx);
  await f.event({ type: 'order.cancellation_requested', aggregateType: 'order', aggregateId: orderId, payload: { orderNumber: order.orderNumber, cancellationId: row!.id, initiator: input.initiator, reasonCode: input.reasonCode, orderStatus: order.status } });
  await f.audit({ action: 'order.cancellation_requested', resourceType: 'order', resourceId: orderId, after: { cancellationId: row!.id, initiator: input.initiator, reasonCode: input.reasonCode } });
  return toCancellationDto(row!);
}

/** Accept = the order is cancelled and held stock released (through the normal order transition); reject = the order carries on. */
export async function decideCancellation(tx: Tx, ctx: OpCtx, orderId: string, cancellationId: string, decision: 'accept' | 'reject', note?: string | null) {
  const [c] = await tx.select().from(C).where(and(eq(C.id, cancellationId), eq(C.orderId, orderId), eq(C.vendorId, ctx.vendorId)));
  if (!c) throw Errors.notFound('Cancellation request', cancellationId);
  if (c.status !== 'requested') throw new AppError('INVALID_STATE', `This cancellation request is already ${c.status}`, { details: { status: c.status } });
  if (decision === 'reject') {
    const [row] = await tx.update(C).set({ status: 'rejected', decidedBy: ctx.actor.id, decidedAt: new Date(), decisionNote: note ?? null }).where(eq(C.id, c.id)).returning();
    await effects(tx, ctx).audit({ action: 'order.cancellation_rejected', resourceType: 'order', resourceId: orderId, before: { status: 'requested' }, after: { status: 'rejected', note: note ?? null } });
    return { cancellation: toCancellationDto(row!), order: null, sync: null };
  }
  // the request stays open until the order transition completes it (one record per cancellation, with the released units)
  await tx.update(C).set({ decidedBy: ctx.actor.id, decidedAt: new Date(), decisionNote: note ?? null }).where(eq(C.id, c.id));
  const res = await transitionWithin(tx, ctx, orderId, 'cancelled', { cancelReason: c.reasonText ?? c.reasonCode, note: note ?? undefined, initiator: c.initiator as never, reasonCode: c.reasonCode });
  const [done] = await tx.select().from(C).where(eq(C.id, c.id));
  return { cancellation: toCancellationDto(done!), order: res.order, sync: res.sync };
}
