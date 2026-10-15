import { and, eq, inArray, schema, sql, type Tx } from '@oms/database';
import { AppError } from '@oms/shared';
import { availabilityByWarehouse, moveReservation, reservationsForOrder, reserveForOrderItem } from '@oms/mod-inventory';
import { getOrderRow, transitionWithin } from '@oms/mod-orders';
import { evaluateRules, recordExecutions } from '@oms/mod-rules';
import { allocationOrder } from '@oms/mod-warehouses';
import { effects, type OpCtx } from '@oms/module-kit';
import { planRouting, type RouteLine, type RoutingPlan, type Strategy } from './domain';
import { F, FI, numberFor, recordEvent, syncOrderStatus, type FulfillmentRow, type Work } from './core';

export interface StartInput {
  warehouseIds?: string[];
  strategy?: Strategy;
  allowSplit?: boolean;
  priority?: (typeof schema.FULFILLMENT_PRIORITIES)[number];
}

const LIVE = ['confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped', 'in_transit', 'on_hold', 'delivery_failed', 'delivered'];

/** order lines that still need a home: quantity minus what live fulfillments already carry */
async function openLines(tx: Tx, vendorId: string, orderId: string): Promise<{ lines: RouteLine[]; unmapped: string[] }> {
  const items = await tx.select().from(schema.orderItems).where(and(eq(schema.orderItems.vendorId, vendorId), eq(schema.orderItems.orderId, orderId))).orderBy(schema.orderItems.createdAt, schema.orderItems.id);
  const taken = await tx
    .select({ orderItemId: FI.orderItemId, q: sql<number>`coalesce(sum(${FI.quantity}), 0)::int` })
    .from(FI).innerJoin(F, and(eq(F.id, FI.fulfillmentId), eq(F.vendorId, FI.vendorId)))
    .where(and(eq(FI.vendorId, vendorId), eq(F.orderId, orderId), inArray(F.status, LIVE)))
    .groupBy(FI.orderItemId);
  const by = new Map(taken.map((t) => [t.orderItemId, t.q]));
  const lines: RouteLine[] = [];
  const unmapped: string[] = [];
  for (const it of items) {
    if (it.status === 'cancelled') continue;
    if (!it.variantId) { unmapped.push(it.sku); continue; }
    const q = it.quantity - (by.get(it.id) ?? 0);
    if (q > 0) lines.push({ orderItemId: it.id, variantId: it.variantId, quantity: q });
  }
  return { lines, unmapped };
}

/** Preview where an order would be fulfilled, without changing anything. */
export async function previewRouting(tx: Tx, ctx: OpCtx, orderId: string, input: StartInput = {}): Promise<{ plan: RoutingPlan; ruleIds: string[]; priority: string; unmapped: string[] }> {
  const order = await getOrderRow(tx, ctx.vendorId, orderId);
  const { lines, unmapped } = await openLines(tx, ctx.vendorId, orderId);
  const dest = order.shippingAddress as Record<string, unknown>;
  const state = typeof dest.state === 'string' ? dest.state : null;
  const pincode = typeof (dest.pincode ?? dest.postalCode) === 'string' ? String(dest.pincode ?? dest.postalCode) : null;
  const matched = await evaluateRules(tx, ctx.vendorId, 'fulfillment', {
    marketplace: order.marketplace, accountId: order.marketplaceAccountId, paymentMethod: order.paymentMethod, destinationState: state, destinationPincode: pincode, orderValueMinor: order.totalMinor, itemCount: lines.reduce((n, l) => n + l.quantity, 0),
  });
  let pref: { warehouseIds?: string[]; strategy?: Strategy; allowSplit?: boolean } = {};
  let priority: string = input.priority ?? 'normal';
  const ruleIds: string[] = [];
  for (const m of matched) {
    if (m.action.type === 'route') {
      const p = m.action.params as typeof pref;
      pref = { warehouseIds: pref.warehouseIds ?? p.warehouseIds, strategy: pref.strategy ?? p.strategy, allowSplit: pref.allowSplit ?? p.allowSplit };
      ruleIds.push(m.rule.id);
    } else if (m.action.type === 'set_priority' && !input.priority) { priority = String((m.action.params as { priority: string }).priority); ruleIds.push(m.rule.id); }
  }
  // an explicit instruction from the operator beats the rules
  if (input.warehouseIds?.length) pref.warehouseIds = input.warehouseIds;
  if (input.strategy) pref.strategy = input.strategy;
  if (input.allowSplit !== undefined) pref.allowSplit = input.allowSplit;
  const wh = await allocationOrder(tx, ctx.vendorId);
  const availability = await availabilityByWarehouse(tx, ctx.vendorId, [...new Set(lines.map((l) => l.variantId))], orderId);
  const plan = planRouting({
    lines, availability, destination: { state, pincode }, preference: pref,
    warehouses: wh.map((w) => { const a = w.address as Record<string, unknown>; return { id: w.id, code: w.code, priority: w.priority, isDefault: w.isDefault, state: typeof a.state === 'string' ? a.state : null, pincode: typeof (a.pincode ?? a.postalCode) === 'string' ? String(a.pincode ?? a.postalCode) : null }; }),
  });
  return { plan, ruleIds, priority, unmapped };
}

/** make sure the order holds `quantity` units of the line in `warehouseId`: move surplus from other warehouses, else reserve fresh */
async function ensureReserved(tx: Tx, ctx: OpCtx, orderId: string, line: RouteLine, warehouseId: string): Promise<void> {
  const rows = (await reservationsForOrder(tx, ctx.vendorId, orderId)).filter((r) => r.orderItemId === line.orderItemId && r.status === 'active');
  const heldHere = rows.find((r) => r.warehouseId === warehouseId)?.quantity ?? 0;
  let need = line.quantity - heldHere;
  if (need <= 0) return;
  // units reserved elsewhere that no fulfillment has claimed yet are free to move
  const claimed = await tx.select({ w: F.warehouseId, q: sql<number>`coalesce(sum(${FI.quantity}), 0)::int` }).from(FI).innerJoin(F, and(eq(F.id, FI.fulfillmentId), eq(F.vendorId, FI.vendorId)))
    .where(and(eq(FI.vendorId, ctx.vendorId), eq(FI.orderItemId, line.orderItemId), inArray(F.status, LIVE))).groupBy(F.warehouseId);
  for (const r of rows) {
    if (need <= 0) break;
    if (r.warehouseId === warehouseId) continue;
    const free = r.quantity - (claimed.find((c) => c.w === r.warehouseId)?.q ?? 0);
    const take = Math.min(free, need);
    if (take <= 0) continue;
    await moveReservation(tx, { vendorId: ctx.vendorId, orderId, orderItemId: line.orderItemId, variantId: line.variantId, fromWarehouseId: r.warehouseId, toWarehouseId: warehouseId, quantity: take, actor: ctx.actor });
    need -= take;
  }
  if (need > 0) {
    const total = (await reservationsForOrder(tx, ctx.vendorId, orderId)).filter((r) => r.orderItemId === line.orderItemId && r.status === 'active').reduce((n, r) => n + r.quantity, 0);
    const res = await reserveForOrderItem(tx, { vendorId: ctx.vendorId, orderId, orderItemId: line.orderItemId, variantId: line.variantId, quantity: total + need, warehouseIds: [warehouseId], actor: ctx.actor });
    if (res.reserved < total + need) throw new AppError('INSUFFICIENT_STOCK', 'The warehouse cannot cover this order line', { details: { warehouseId, orderItemId: line.orderItemId, short: res.short } });
    await tx.update(schema.orderItems).set({ reservedQuantity: res.reserved, status: 'allocated' }).where(eq(schema.orderItems.id, line.orderItemId));
  }
}

/**
 * Turn a confirmed order into warehouse work: choose the warehouse(s) (routing rules + availability + priority), make the
 * stock reservation follow that choice, and create one fulfillment per warehouse. An order that is still `new` is confirmed
 * first. Lines with no stock anywhere are reported as `unallocated` (the order keeps its attention flag), never oversold.
 */
export async function startFulfillment(tx: Tx, ctx: OpCtx, w: Work, orderId: string, input: StartInput = {}): Promise<{ fulfillments: FulfillmentRow[]; plan: RoutingPlan }> {
  let order = await getOrderRow(tx, ctx.vendorId, orderId, true); // two concurrent starts for one order must not both route the same lines
  if (!(['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch'] as string[]).includes(order.status)) throw new AppError('INVALID_STATE', `A ${order.status} order cannot be fulfilled`, { details: { status: order.status } });
  const prev = await previewRouting(tx, ctx, orderId, input);
  if (prev.unmapped.length) throw new AppError('CONFLICT', 'Some lines are not mapped to a product variant yet', { details: { rule: 'unmapped_sku', skus: prev.unmapped } });
  if (prev.plan.allocations.length === 0) {
    if (prev.plan.unallocated.length === 0) throw new AppError('CONFLICT', 'Every line of this order is already in a fulfillment', { details: { rule: 'already_fulfilling' } });
    throw new AppError('INSUFFICIENT_STOCK', 'No warehouse has stock for this order', { details: { reasons: prev.plan.reasons, unallocated: prev.plan.unallocated } });
  }
  if (order.status === 'new') {
    const res = await transitionWithin(tx, ctx, orderId, 'confirmed', { note: 'confirmed to start fulfillment' });
    w.add(res.sync.job);
    order = await getOrderRow(tx, ctx.vendorId, orderId);
  }
  const fx = effects(tx, ctx);
  const created: FulfillmentRow[] = [];
  for (const alloc of prev.plan.allocations) {
    for (const line of alloc.lines) await ensureReserved(tx, ctx, orderId, line, alloc.warehouseId);
    const number = await numberFor(tx, ctx.vendorId, 'fulfillment');
    const [f] = await tx.insert(F).values({
      vendorId: ctx.vendorId, number, orderId, warehouseId: alloc.warehouseId, status: 'confirmed', priority: prev.priority,
      routing: { strategy: prev.plan.strategy, ruleIds: prev.ruleIds, reasons: prev.plan.reasons, candidates: prev.plan.candidates, manual: Boolean(input.warehouseIds?.length || input.strategy) },
    }).returning();
    await tx.insert(FI).values(alloc.lines.map((l) => ({ vendorId: ctx.vendorId, fulfillmentId: f!.id, orderItemId: l.orderItemId, variantId: l.variantId, quantity: l.quantity })));
    await recordEvent(tx, ctx, f!, null, 'confirmed', 'fulfillment created', { warehouseId: alloc.warehouseId });
    await fx.event({ type: 'fulfillment.created', aggregateType: 'fulfillment', aggregateId: f!.id, payload: { number, orderId, orderNumber: order.orderNumber, warehouseId: alloc.warehouseId, lines: alloc.lines.length } });
    await fx.audit({ action: 'fulfillment.created', resourceType: 'fulfillment', resourceId: f!.id, after: { number, orderId, warehouseId: alloc.warehouseId, reasons: prev.plan.reasons } });
    created.push(f!);
  }
  if (prev.ruleIds.length) await recordExecutions(tx, ctx.vendorId, 'fulfillment', 'order', orderId, prev.ruleIds.map((ruleId) => ({ ruleId, outcome: { warehouses: prev.plan.allocations.map((a) => a.warehouseId) } })));
  if (order.warehouseId === null) await tx.update(schema.orders).set({ warehouseId: prev.plan.allocations[0]!.warehouseId }).where(eq(schema.orders.id, orderId));
  if (prev.plan.unallocated.length) {
    const sku = prev.plan.unallocated.length;
    await tx.update(schema.orders).set({ attentionReason: `insufficient_stock:${sku}_line(s)_unrouted` }).where(eq(schema.orders.id, orderId));
  }
  await syncOrderStatus(tx, ctx, w, orderId);
  return { fulfillments: created, plan: prev.plan };
}
