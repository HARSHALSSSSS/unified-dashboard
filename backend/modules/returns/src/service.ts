import { and, eq, inArray, keyset, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { addToBin, disposeReturned, nextCounter, receiveReturn, resolveReturned } from '@oms/mod-inventory';
import { getOrderRow } from '@oms/mod-orders';
import { getWarehouseRow } from '@oms/mod-warehouses';
import { effects, type OpCtx } from '@oms/module-kit';
import { ACTIVE, RECEIVABLE, canMove, refundFor, stockEffect, validateDecision, type Disposition, type ReturnStatus } from './domain';

const R = schema.returnOrders;
const RI = schema.returnItems;
const RE = schema.returnEvents;
export type ReturnRow = typeof R.$inferSelect;
export type ReturnItemRow = typeof RI.$inferSelect;

export const toItemDto = (i: ReturnItemRow, sku: string | null) => ({
  id: i.id, orderItemId: i.orderItemId, variantId: i.variantId, sku, quantity: i.quantity, receivedQuantity: i.receivedQuantity, dispositionedQuantity: i.dispositionedQuantity, restockedQuantity: i.restockedQuantity,
  condition: i.condition as (typeof schema.RETURN_CONDITIONS)[number] | null, disposition: i.disposition as (typeof schema.RETURN_DISPOSITIONS)[number] | null, notes: i.notes,
  inspectedAt: i.inspectedAt ? i.inspectedAt.toISOString() : null,
});
export const toReturnDto = (r: ReturnRow, items: Array<{ i: ReturnItemRow; sku: string | null }> = []) => ({
  id: r.id, number: r.number, orderId: r.orderId, warehouseId: r.warehouseId, source: r.source as (typeof schema.RETURN_SOURCES)[number], status: r.status as ReturnStatus, reasonCode: r.reasonCode, reasonText: r.reasonText,
  marketplaceReturnId: r.marketplaceReturnId, shipmentId: r.shipmentId,
  pickup: { status: r.pickupStatus as (typeof schema.PICKUP_STATUSES)[number], awb: r.pickupAwb, scheduledAt: r.pickupScheduledAt ? r.pickupScheduledAt.toISOString() : null },
  refund: { status: r.refundStatus as (typeof schema.REFUND_STATUSES)[number], amountMinor: r.refundAmountMinor, reference: r.refundReference, refundedAt: r.refundedAt ? r.refundedAt.toISOString() : null },
  receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null, inspectedAt: r.inspectedAt ? r.inspectedAt.toISOString() : null, completedAt: r.completedAt ? r.completedAt.toISOString() : null, notes: r.notes,
  items: items.map(({ i, sku }) => toItemDto(i, sku)), version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

async function itemsWithSku(tx: Tx, vendorId: string, returnId: string) {
  return tx.select({ i: RI, sku: schema.productVariants.sku }).from(RI).leftJoin(schema.productVariants, and(eq(schema.productVariants.id, RI.variantId), eq(schema.productVariants.vendorId, RI.vendorId))).where(and(eq(RI.vendorId, vendorId), eq(RI.returnOrderId, returnId))).orderBy(RI.createdAt, RI.id);
}
/** `lock`: FOR UPDATE: receive / inspect / complete / refund of ONE return run one after the other (no double receipt, no double refund) */
export async function getReturnRow(tx: Tx, vendorId: string, id: string, lock = false): Promise<ReturnRow> {
  const q = tx.select().from(R).where(and(eq(R.id, id), eq(R.vendorId, vendorId)));
  const [r] = await (lock ? q.for('update') : q);
  if (!r) throw Errors.notFound('Return', id);
  return r;
}
export async function returnDetail(tx: Tx, vendorId: string, id: string) {
  return toReturnDto(await getReturnRow(tx, vendorId, id), await itemsWithSku(tx, vendorId, id));
}
export async function returnTimeline(tx: Tx, vendorId: string, id: string) {
  await getReturnRow(tx, vendorId, id);
  return (await tx.select().from(RE).where(and(eq(RE.vendorId, vendorId), eq(RE.returnOrderId, id))).orderBy(RE.id)).map((e) => ({ id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, actorId: e.actorId, note: e.note, metadata: e.metadata, createdAt: e.createdAt.toISOString() }));
}

export async function listReturns(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; orderId?: string; source?: string; refundStatus?: string; warehouseId?: string }) {
  const ks = keyset<ReturnRow>({ sorts: { createdAt: { column: R.createdAt, kind: 'timestamp' } }, idColumn: R.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(R).where(and(eq(R.vendorId, vendorId), q.status ? eq(R.status, q.status) : undefined, q.orderId ? eq(R.orderId, q.orderId) : undefined, q.source ? eq(R.source, q.source) : undefined,
    q.refundStatus ? eq(R.refundStatus, q.refundStatus) : undefined, q.warehouseId ? eq(R.warehouseId, q.warehouseId) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
  const ids = page.items.map((r) => r.id);
  const items = ids.length ? await tx.select({ i: RI, sku: schema.productVariants.sku }).from(RI).leftJoin(schema.productVariants, and(eq(schema.productVariants.id, RI.variantId), eq(schema.productVariants.vendorId, RI.vendorId))).where(and(eq(RI.vendorId, vendorId), inArray(RI.returnOrderId, ids))) : [];
  return { items: page.items.map((r) => toReturnDto(r, items.filter((x) => x.i.returnOrderId === r.id))), nextCursor: page.nextCursor };
}

async function move(tx: Tx, ctx: OpCtx, r: ReturnRow, to: ReturnStatus, patch: Partial<typeof R.$inferInsert> = {}, note?: string | null, metadata: Record<string, unknown> = {}): Promise<ReturnRow> {
  const from = r.status as ReturnStatus;
  if (from !== to && !canMove(from, to)) throw new AppError('INVALID_STATE', `A return cannot move from ${from} to ${to}`, { details: { from, to } });
  const [after] = await tx.update(R).set({ ...patch, status: to, version: sql`${R.version} + 1` }).where(eq(R.id, r.id)).returning();
  if (from !== to) await tx.insert(RE).values({ vendorId: ctx.vendorId, returnOrderId: r.id, fromStatus: from, toStatus: to, actorId: ctx.actor.id, note: note ?? null, metadata });
  await effects(tx, ctx).audit({ action: `return.${to}`, resourceType: 'return', resourceId: r.id, before: { status: from }, after: { status: to }, metadata: { number: r.number, ...(note ? { note } : {}) } });
  return after!;
}

// ------------------------------------------------------------------------------------------------
// create
// ------------------------------------------------------------------------------------------------
export interface CreateReturnInput {
  orderId: string; source: (typeof schema.RETURN_SOURCES)[number]; reasonCode: string; reasonText?: string | null; marketplaceReturnId?: string | null; warehouseId?: string | null;
  items: Array<{ orderItemId: string; quantity: number }>; pickupRequired?: boolean; notes?: string | null; shipmentId?: string | null; autoApprove?: boolean;
}

/** units of an order line that are already part of a live return */
async function alreadyReturned(tx: Tx, vendorId: string, orderItemId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${RI.quantity}), 0)::int` }).from(RI).innerJoin(R, and(eq(R.id, RI.returnOrderId), eq(R.vendorId, RI.vendorId))).where(and(eq(RI.vendorId, vendorId), eq(RI.orderItemId, orderItemId), inArray(R.status, [...ACTIVE])));
  return r?.n ?? 0;
}

/**
 * A return is requested for an order that has left the warehouse. Quantities are bounded by what was sold and what is not
 * already being returned; the refund due is computed from what the customer paid. Idempotent per marketplace return id.
 */
export async function createReturn(tx: Tx, ctx: OpCtx, input: CreateReturnInput): Promise<ReturnRow> {
  if (input.marketplaceReturnId) {
    const [dup] = await tx.select().from(R).where(and(eq(R.vendorId, ctx.vendorId), eq(R.marketplaceReturnId, input.marketplaceReturnId)));
    if (dup) return dup;
  }
  const order = await getOrderRow(tx, ctx.vendorId, input.orderId, true);
  if (!(['dispatched', 'in_transit', 'delivered', 'returned'] as string[]).includes(order.status)) throw new AppError('INVALID_STATE', `A ${order.status} order has not reached the customer; cancel it instead of returning it`, { details: { status: order.status } });
  if (input.warehouseId) await getWarehouseRow(tx, ctx.vendorId, input.warehouseId);
  const orderItems = await tx.select().from(schema.orderItems).where(and(eq(schema.orderItems.vendorId, ctx.vendorId), eq(schema.orderItems.orderId, input.orderId)));
  const lines: Array<{ item: typeof orderItems[number]; quantity: number }> = [];
  for (const l of input.items) {
    const item = orderItems.find((o) => o.id === l.orderItemId);
    if (!item) throw new AppError('BAD_REQUEST', 'The item does not belong to this order', { details: { orderItemId: l.orderItemId } });
    const used = await alreadyReturned(tx, ctx.vendorId, item.id);
    if (l.quantity > item.quantity - used) throw new AppError('BAD_REQUEST', 'More units than were sold and not already being returned', { details: { orderItemId: item.id, sold: item.quantity, alreadyReturning: used, requested: l.quantity } });
    lines.push({ item, quantity: l.quantity });
  }
  const refundable = order.paymentMethod === 'prepaid' || order.paymentStatus === 'paid' || order.status === 'delivered';
  const refundDue = input.source === 'rto' ? order.paymentMethod === 'prepaid' : input.source === 'seller' ? false : refundable || order.paymentMethod === 'prepaid';
  const refund = !refundDue ? null : refundFor(lines.map((l) => ({ quantity: l.item.quantity, returned: l.quantity, unitPriceMinor: l.item.unitPriceMinor, taxMinor: l.item.taxMinor, discountMinor: l.item.discountMinor })));
  const number = `RET-${String(await nextCounter(tx, ctx.vendorId, 'return')).padStart(6, '0')}`;
  const [r] = await tx.insert(R).values({
    vendorId: ctx.vendorId, number, orderId: input.orderId, warehouseId: input.warehouseId ?? null, source: input.source, status: 'requested', reasonCode: input.reasonCode, reasonText: input.reasonText ?? null,
    marketplaceReturnId: input.marketplaceReturnId ?? null, shipmentId: input.shipmentId ?? null, pickupStatus: input.pickupRequired ? 'requested' : 'not_required',
    refundStatus: refund && refund > 0 ? 'pending' : 'not_applicable', refundAmountMinor: refund, notes: input.notes ?? null,
  }).returning();
  await tx.insert(RI).values(lines.map((l) => ({ vendorId: ctx.vendorId, returnOrderId: r!.id, orderItemId: l.item.id, variantId: l.item.variantId, quantity: l.quantity })));
  await tx.insert(RE).values({ vendorId: ctx.vendorId, returnOrderId: r!.id, fromStatus: null, toStatus: 'requested', actorId: ctx.actor.id, note: input.reasonText ?? input.reasonCode });
  const fx = effects(tx, ctx);
  await fx.event({ type: 'return.created', aggregateType: 'return', aggregateId: r!.id, payload: { number, orderId: input.orderId, orderNumber: order.orderNumber, source: input.source, reasonCode: input.reasonCode, units: lines.reduce((n, l) => n + l.quantity, 0) } });
  await fx.audit({ action: 'return.created', resourceType: 'return', resourceId: r!.id, after: { number, orderId: input.orderId, source: input.source, reasonCode: input.reasonCode } });
  return input.autoApprove ? move(tx, ctx, r!, 'approved', {}, 'auto-approved') : r!;
}

// ------------------------------------------------------------------------------------------------
// decision + pickup
// ------------------------------------------------------------------------------------------------
export async function decideReturn(tx: Tx, ctx: OpCtx, id: string, decision: 'approve' | 'reject', note?: string | null, warehouseId?: string | null): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (warehouseId) await getWarehouseRow(tx, ctx.vendorId, warehouseId);
  if (decision === 'reject') return move(tx, ctx, r, 'rejected', { refundStatus: 'not_applicable', pickupStatus: 'not_required', notes: note ?? r.notes }, note);
  return move(tx, ctx, r, 'approved', { warehouseId: warehouseId ?? r.warehouseId }, note);
}

export async function schedulePickup(tx: Tx, ctx: OpCtx, id: string, input: { scheduledAt?: Date | null; awb?: string | null; warehouseId?: string | null }): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (r.pickupStatus === 'not_required') throw new AppError('CONFLICT', 'This return does not need a pickup', { details: { rule: 'pickup_not_required' } });
  if (input.warehouseId) await getWarehouseRow(tx, ctx.vendorId, input.warehouseId);
  return move(tx, ctx, r, 'pickup_scheduled', { pickupStatus: 'scheduled', pickupAwb: input.awb ?? r.pickupAwb, pickupScheduledAt: input.scheduledAt ?? r.pickupScheduledAt, warehouseId: input.warehouseId ?? r.warehouseId }, 'pickup scheduled');
}

/** pickup progress reported by whoever collects it: picked_up | in_transit | failed (back to approved so it can be rescheduled) */
export async function recordPickup(tx: Tx, ctx: OpCtx, id: string, outcome: 'picked_up' | 'in_transit' | 'failed', note?: string | null): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (outcome === 'failed') return move(tx, ctx, r, 'approved', { pickupStatus: 'failed' }, note ?? 'pickup failed');
  if (outcome === 'picked_up') return move(tx, ctx, r, 'picked_up', { pickupStatus: 'picked_up' }, note);
  return move(tx, ctx, r, 'in_transit', {}, note);
}

export async function cancelReturn(tx: Tx, ctx: OpCtx, id: string, note?: string | null): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  return move(tx, ctx, r, 'cancelled', { refundStatus: 'not_applicable' }, note);
}

// ------------------------------------------------------------------------------------------------
// receive -> inventory `returned` bucket
// ------------------------------------------------------------------------------------------------
/**
 * Goods physically arrive at a warehouse. Units go into the `returned` bucket of that warehouse (not sellable yet: they must be
 * inspected). Partial receipts are fine; over-receipt is refused.
 */
export async function receiveReturnGoods(tx: Tx, ctx: OpCtx, id: string, input: { warehouseId: string; items: Array<{ returnItemId: string; quantity: number }>; note?: string | null }): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (!(RECEIVABLE as readonly string[]).includes(r.status)) throw new AppError('INVALID_STATE', `Goods cannot be received for a ${r.status} return`, { details: { status: r.status } });
  await getWarehouseRow(tx, ctx.vendorId, input.warehouseId);
  if (r.warehouseId && r.warehouseId !== input.warehouseId && r.receivedAt) throw new AppError('CONFLICT', 'This return is already being received in another warehouse', { details: { warehouseId: r.warehouseId } });
  const items = await tx.select().from(RI).where(and(eq(RI.vendorId, ctx.vendorId), eq(RI.returnOrderId, id)));
  for (const l of input.items) {
    const it = items.find((x) => x.id === l.returnItemId);
    if (!it) throw new AppError('BAD_REQUEST', 'The item does not belong to this return', { details: { returnItemId: l.returnItemId } });
    if (!it.variantId) throw new AppError('CONFLICT', 'This line is not mapped to a product variant; map it before receiving', { details: { rule: 'unmapped_sku', returnItemId: it.id } });
    if (it.receivedQuantity + l.quantity > it.quantity) throw new AppError('BAD_REQUEST', 'More units than the return expects', { details: { expected: it.quantity, alreadyReceived: it.receivedQuantity, received: l.quantity } });
    await receiveReturn(tx, { vendorId: ctx.vendorId, variantId: it.variantId, warehouseId: input.warehouseId, quantity: l.quantity, disposition: 'hold', referenceType: 'return', referenceId: id, reason: `return ${r.number} received`, actor: ctx.actor });
    await tx.update(RI).set({ receivedQuantity: it.receivedQuantity + l.quantity }).where(eq(RI.id, it.id));
    it.receivedQuantity += l.quantity;
  }
  const after = await move(tx, ctx, r, 'received', { warehouseId: input.warehouseId, receivedAt: r.receivedAt ?? new Date(), pickupStatus: r.pickupStatus === 'not_required' ? 'not_required' : 'picked_up' }, input.note ?? 'goods received', { units: input.items.reduce((n, l) => n + l.quantity, 0) });
  await effects(tx, ctx).event({ type: 'return.received', aggregateType: 'return', aggregateId: id, payload: { number: r.number, orderId: r.orderId, warehouseId: input.warehouseId, units: input.items.reduce((n, l) => n + l.quantity, 0), source: r.source } });
  return after;
}

// ------------------------------------------------------------------------------------------------
// inspection + disposition -> inventory
// ------------------------------------------------------------------------------------------------
export interface InspectLine { returnItemId: string; quantity: number; condition: (typeof schema.RETURN_CONDITIONS)[number]; disposition: Disposition; binId?: string | null; notes?: string | null }

/**
 * Inspect received units and decide their fate. The stock effect goes through the inventory engine:
 *   restock -> returned -> on_hand (sellable again, optionally into a bin)      damaged -> returned -> damaged
 *   dispose / return_to_vendor -> leaves the books (returned -)                  quarantine -> stays in `returned`, decide later
 */
export async function inspectReturn(tx: Tx, ctx: OpCtx, id: string, lines: InspectLine[]): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (!['received', 'inspecting'].includes(r.status)) throw new AppError('INVALID_STATE', `A ${r.status} return cannot be inspected`, { details: { status: r.status } });
  if (!r.warehouseId) throw new AppError('INVALID_STATE', 'The return has no warehouse yet');
  const items = await tx.select().from(RI).where(and(eq(RI.vendorId, ctx.vendorId), eq(RI.returnOrderId, id)));
  let restocked = 0;
  for (const l of lines) {
    const it = items.find((x) => x.id === l.returnItemId);
    if (!it || !it.variantId) throw new AppError('BAD_REQUEST', 'The item does not belong to this return', { details: { returnItemId: l.returnItemId } });
    const problem = validateDecision(l.condition, l.disposition);
    if (problem) throw new AppError('BAD_REQUEST', problem, { details: { condition: l.condition, disposition: l.disposition } });
    const undecided = it.receivedQuantity - it.dispositionedQuantity;
    if (l.quantity > undecided) throw new AppError('BAD_REQUEST', 'More units than were received and not yet decided', { details: { received: it.receivedQuantity, decided: it.dispositionedQuantity, requested: l.quantity } });
    const eff = stockEffect(l.disposition);
    const base = { vendorId: ctx.vendorId, variantId: it.variantId, warehouseId: r.warehouseId, quantity: l.quantity, referenceType: 'return' as const, referenceId: id, actor: ctx.actor };
    if (eff.kind === 'to_onhand') {
      await resolveReturned(tx, { ...base, to: 'restock', reason: `return ${r.number}: restocked (${l.condition})` });
      if (l.binId) await addToBin(tx, { vendorId: ctx.vendorId, variantId: it.variantId, warehouseId: r.warehouseId, binId: l.binId, quantity: l.quantity });
      restocked += l.quantity;
    } else if (eff.kind === 'to_damaged') await resolveReturned(tx, { ...base, to: 'damaged', reason: `return ${r.number}: ${l.condition}` });
    else if (eff.kind === 'leave') await disposeReturned(tx, { ...base, reason: `return ${r.number}: ${l.disposition}` });
    await tx.update(RI).set({
      dispositionedQuantity: it.dispositionedQuantity + (eff.final ? l.quantity : 0), restockedQuantity: it.restockedQuantity + (eff.kind === 'to_onhand' ? l.quantity : 0),
      condition: l.condition, disposition: l.disposition, inspectedBy: ctx.actor.id, inspectedAt: new Date(), notes: l.notes ?? it.notes,
    }).where(eq(RI.id, it.id));
    it.dispositionedQuantity += eff.final ? l.quantity : 0; // keep the in-memory copy in step for repeated lines
    it.restockedQuantity += eff.kind === 'to_onhand' ? l.quantity : 0;
  }
  const after = await move(tx, ctx, r, 'inspecting', { inspectedAt: new Date() }, 'inspected', { restocked });
  await effects(tx, ctx).event({ type: 'return.inspected', aggregateType: 'return', aggregateId: id, payload: { number: r.number, orderId: r.orderId, warehouseId: r.warehouseId, restocked, lines: lines.length } });
  return after;
}

/** Close the return once every received unit has a final decision. Units that never arrived need `acceptShort`. */
export async function completeReturn(tx: Tx, ctx: OpCtx, id: string, input: { acceptShort?: boolean; note?: string | null } = {}): Promise<{ row: ReturnRow; fullyReturned: boolean }> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (!['received', 'inspecting'].includes(r.status)) throw new AppError('INVALID_STATE', `A ${r.status} return cannot be completed`, { details: { status: r.status } });
  const items = await tx.select().from(RI).where(and(eq(RI.vendorId, ctx.vendorId), eq(RI.returnOrderId, id)));
  const undecided = items.filter((i) => i.dispositionedQuantity < i.receivedQuantity);
  if (undecided.length) throw new AppError('CONFLICT', 'Some received units have no inspection decision yet', { details: { rule: 'undecided_units', items: undecided.map((i) => ({ returnItemId: i.id, undecided: i.receivedQuantity - i.dispositionedQuantity })) } });
  const short = items.filter((i) => i.receivedQuantity < i.quantity);
  if (short.length && !input.acceptShort) throw new AppError('CONFLICT', 'Some units never arrived; complete with acceptShort to close the return', { details: { rule: 'units_missing', missing: short.map((i) => ({ returnItemId: i.id, missing: i.quantity - i.receivedQuantity })) } });
  const row = await move(tx, ctx, r, 'completed', { completedAt: new Date() }, input.note ?? 'completed', { short: short.length });
  await effects(tx, ctx).event({ type: 'return.completed', aggregateType: 'return', aggregateId: id, payload: { number: r.number, orderId: r.orderId, restocked: items.reduce((n, i) => n + i.restockedQuantity, 0), refundAmountMinor: r.refundAmountMinor } });
  // the whole order came back?
  const order = await tx.select({ q: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)::int` }).from(schema.orderItems).where(and(eq(schema.orderItems.vendorId, ctx.vendorId), eq(schema.orderItems.orderId, r.orderId)));
  const [done] = await tx.select({ n: sql<number>`coalesce(sum(${RI.receivedQuantity}), 0)::int` }).from(RI).innerJoin(R, and(eq(R.id, RI.returnOrderId), eq(R.vendorId, RI.vendorId))).where(and(eq(RI.vendorId, ctx.vendorId), eq(R.orderId, r.orderId), eq(R.status, 'completed')));
  return { row, fullyReturned: (order[0]?.q ?? 0) > 0 && (done?.n ?? 0) >= (order[0]?.q ?? 0) };
}

// ------------------------------------------------------------------------------------------------
// refund tracking (the money moves in the marketplace / payment system; we record the outcome)
// ------------------------------------------------------------------------------------------------
export async function recordRefund(tx: Tx, ctx: OpCtx, id: string, input: { status: 'processed' | 'failed' | 'pending'; amountMinor?: number | null; reference?: string | null }): Promise<ReturnRow> {
  const r = await getReturnRow(tx, ctx.vendorId, id, true);
  if (r.refundStatus === 'not_applicable') throw new AppError('CONFLICT', 'No refund is due for this return', { details: { rule: 'refund_not_applicable' } });
  if (r.refundStatus === 'processed') throw new AppError('INVALID_STATE', 'The refund is already processed', { details: { status: r.refundStatus } });
  if (input.amountMinor != null) {
    const [o] = await tx.select({ total: schema.orders.totalMinor }).from(schema.orders).where(eq(schema.orders.id, r.orderId));
    if (input.amountMinor > (o?.total ?? 0)) throw new AppError('BAD_REQUEST', 'A refund cannot exceed what the customer paid for the order', { details: { rule: 'refund_above_order_total', orderTotalMinor: o?.total ?? 0 } });
  }
  if (input.status === 'processed' && ['requested', 'rejected', 'cancelled'].includes(r.status)) throw new AppError('INVALID_STATE', `A ${r.status} return cannot be refunded`, { details: { status: r.status } });
  const [after] = await tx.update(R).set({ refundStatus: input.status, refundAmountMinor: input.amountMinor ?? r.refundAmountMinor, refundReference: input.reference ?? r.refundReference, refundedAt: input.status === 'processed' ? new Date() : null, version: sql`${R.version} + 1` }).where(eq(R.id, id)).returning();
  const fx = effects(tx, ctx);
  await fx.audit({ action: `return.refund_${input.status}`, resourceType: 'return', resourceId: id, before: { status: r.refundStatus, amountMinor: r.refundAmountMinor }, after: { status: input.status, amountMinor: after!.refundAmountMinor, reference: input.reference ?? null } });
  if (input.status === 'processed') await fx.event({ type: 'return.refunded', aggregateType: 'return', aggregateId: id, payload: { number: r.number, orderId: r.orderId, amountMinor: after!.refundAmountMinor } });
  return after!;
}

// ------------------------------------------------------------------------------------------------
// RTO: the courier brought a parcel back
// ------------------------------------------------------------------------------------------------
/** one return order per RTO shipment, created already approved and received into the `returned` bucket; staff inspect it as usual */
export async function createRtoReturn(tx: Tx, ctx: OpCtx, p: { shipmentId: string; orderId: string; warehouseId: string; items: Array<{ orderItemId: string; quantity: number }>; awb?: string | null }): Promise<ReturnRow | null> {
  const [dup] = await tx.select().from(R).where(and(eq(R.vendorId, ctx.vendorId), eq(R.shipmentId, p.shipmentId)));
  if (dup) return dup;
  if (p.items.length === 0) return null;
  const r = await createReturn(tx, ctx, { orderId: p.orderId, source: 'rto', reasonCode: 'undeliverable', reasonText: `Returned to origin${p.awb ? ` (AWB ${p.awb})` : ''}`, items: p.items, warehouseId: p.warehouseId, shipmentId: p.shipmentId, autoApprove: true });
  const items = await tx.select().from(RI).where(and(eq(RI.vendorId, ctx.vendorId), eq(RI.returnOrderId, r.id)));
  const fresh = await getReturnRow(tx, ctx.vendorId, r.id);
  return receiveReturnGoods(tx, ctx, fresh.id, { warehouseId: p.warehouseId, items: items.filter((i) => i.variantId).map((i) => ({ returnItemId: i.id, quantity: i.quantity })), note: 'RTO delivered to warehouse' });
}
