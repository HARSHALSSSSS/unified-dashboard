import { and, desc, eq, escapeLike, gte, ilike, inArray, keyset, lte, or, schema, sql, withVendor, type Tx } from '@oms/database';
import type { InternalOrderStatus } from '@oms/marketplace-core';
import { AppError, Errors } from '@oms/shared';
import { reserveForOrderItem } from '@oms/mod-inventory';
import { dispatchSyncJob } from '@oms/mod-sync';
import { ConnectorHost } from '@oms/mod-marketplace-connectors';
import { effects, type OpCtx } from '@oms/module-kit';
import { inventoryStatusFor } from './domain';
import { importNormalizedOrder, type AccountRow, type ImportResult } from './ingest';
import { getOrderRow, manualTransition, requestMarketplaceStatus, toStatusUpdateDto, type OrderRow } from './status';

const O = schema.orders;
const OI = schema.orderItems;

// ------------------------------------------------------------------------------------------------
// DTOs
// ------------------------------------------------------------------------------------------------
export const toOrderDto = (o: OrderRow, items: Array<typeof OI.$inferSelect> = []) => ({
  id: o.id, orderNumber: o.orderNumber, marketplace: o.marketplace, marketplaceAccountId: o.marketplaceAccountId, externalOrderId: o.externalOrderId,
  status: o.status as InternalOrderStatus, marketplaceStatus: o.marketplaceStatus, statusChangedAt: o.statusChangedAt.toISOString(), placedAt: o.placedAt.toISOString(), currency: o.currency.trim(),
  subtotalMinor: o.subtotalMinor, taxMinor: o.taxMinor, shippingMinor: o.shippingMinor, discountMinor: o.discountMinor, totalMinor: o.totalMinor,
  customer: o.buyer as Record<string, unknown>, shippingAddress: o.shippingAddress as Record<string, unknown>,
  payment: { method: o.paymentMethod as 'prepaid' | 'cod' | 'unknown', status: o.paymentStatus, codAmountMinor: o.codAmountMinor },
  inventoryStatus: o.inventoryStatus as (typeof schema.ORDER_INVENTORY_STATUSES)[number], attentionReason: o.attentionReason, warehouseId: o.warehouseId,
  tracking: { number: o.trackingNumber, carrier: o.carrier }, dispatchedAt: o.dispatchedAt ? o.dispatchedAt.toISOString() : null, deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
  cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null, cancelReason: o.cancelReason, lastMarketplaceSyncAt: o.lastMarketplaceSyncAt ? o.lastMarketplaceSyncAt.toISOString() : null,
  items: items.map((i) => ({
    id: i.id, externalItemId: i.externalItemId, externalListingId: i.externalListingId, sku: i.sku, title: i.title, quantity: i.quantity, reservedQuantity: i.reservedQuantity, unitPriceMinor: i.unitPriceMinor,
    taxMinor: i.taxMinor, discountMinor: i.discountMinor, status: i.status as (typeof schema.ORDER_ITEM_STATUSES)[number], variantId: i.variantId, listingId: i.listingId,
  })),
  version: o.version, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
});

export async function getOrderDetail(tx: Tx, vendorId: string, id: string) {
  const o = await getOrderRow(tx, vendorId, id);
  const items = await tx.select().from(OI).where(and(eq(OI.vendorId, vendorId), eq(OI.orderId, id))).orderBy(OI.createdAt, OI.id);
  return toOrderDto(o, items);
}

export interface OrderFilter {
  limit: number; cursor?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }>; q?: string; status?: string; accountId?: string; marketplace?: string;
  from?: Date; to?: Date; attention?: boolean; inventoryStatus?: string; payment?: string;
}

export async function listOrders(tx: Tx, vendorId: string, f: OrderFilter) {
  const ks = keyset<OrderRow>({ sorts: { placedAt: { column: O.placedAt, kind: 'timestamp' }, updatedAt: { column: O.updatedAt, kind: 'timestamp' } }, idColumn: O.id, sort: f.sort, defaultSort: { field: 'placedAt', direction: 'desc' }, cursor: f.cursor, limit: f.limit });
  const field = f.sort?.[0]?.field ?? 'placedAt';
  const like = f.q ? `%${escapeLike(f.q)}%` : null;
  const rows = await tx
    .select().from(O)
    .where(and(
      eq(O.vendorId, vendorId), f.status ? eq(O.status, f.status) : undefined, f.accountId ? eq(O.marketplaceAccountId, f.accountId) : undefined, f.marketplace ? eq(O.marketplace, f.marketplace) : undefined,
      f.from ? gte(O.placedAt, f.from) : undefined, f.to ? lte(O.placedAt, f.to) : undefined, f.attention === true ? sql`${O.attentionReason} IS NOT NULL` : f.attention === false ? sql`${O.attentionReason} IS NULL` : undefined,
      f.inventoryStatus ? eq(O.inventoryStatus, f.inventoryStatus) : undefined, f.payment ? eq(O.paymentMethod, f.payment) : undefined,
      like ? or(ilike(O.orderNumber, like), ilike(O.externalOrderId, like), sql`${O.buyer}->>'name' ILIKE ${like}`, sql`${O.buyer}->>'email' ILIKE ${like}`) : undefined, ks.where,
    ))
    .orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: field === 'updatedAt' ? r.updatedAt : r.placedAt, id: r.id }));
  const ids = page.items.map((o) => o.id);
  const items = ids.length ? await tx.select().from(OI).where(and(eq(OI.vendorId, vendorId), inArray(OI.orderId, ids))) : [];
  return { items: page.items.map((o) => toOrderDto(o, items.filter((i) => i.orderId === o.id))), nextCursor: page.nextCursor };
}

export async function orderTimeline(tx: Tx, vendorId: string, id: string) {
  await getOrderRow(tx, vendorId, id);
  const E = schema.orderStatusEvents;
  const rows = await tx.select().from(E).where(and(eq(E.vendorId, vendorId), eq(E.orderId, id))).orderBy(E.id);
  return rows.map((e) => ({ id: e.id, fromStatus: e.fromStatus as InternalOrderStatus | null, toStatus: e.toStatus as InternalOrderStatus, marketplaceStatus: e.marketplaceStatus, source: e.source as (typeof schema.STATUS_EVENT_SOURCES)[number], applied: e.applied, note: e.note, actorId: e.actorId, metadata: e.metadata, createdAt: e.createdAt.toISOString() }));
}

export async function listStatusUpdates(tx: Tx, vendorId: string, orderId: string) {
  await getOrderRow(tx, vendorId, orderId);
  const U = schema.orderStatusUpdates;
  return (await tx.select().from(U).where(and(eq(U.vendorId, vendorId), eq(U.orderId, orderId))).orderBy(desc(U.requestedAt))).map(toStatusUpdateDto);
}

// ------------------------------------------------------------------------------------------------
// operator actions
// ------------------------------------------------------------------------------------------------
/**
 * Move an order along (or cancel it) inside the caller's transaction, and queue the marketplace status push.
 * The caller dispatches `sync.job` AFTER its transaction commits.
 */
export async function transitionWithin(tx: Tx, ctx: OpCtx, id: string, to: InternalOrderStatus, opts: { viaFulfillment?: boolean; note?: string | null; tracking?: { number?: string; carrier?: string }; cancelReason?: string | null; version?: number; initiator?: (typeof schema.CANCELLATION_INITIATORS)[number]; reasonCode?: string }) {
  const order = await manualTransition(tx, ctx, id, to, opts);
  // a transition requested by us is pushed to the marketplace (it did not originate there)
  const sync = await requestMarketplaceStatus(tx, ctx, order, to, opts.tracking ?? (order.trackingNumber ? { number: order.trackingNumber, carrier: order.carrier ?? undefined } : undefined));
  return { order: await getOrderDetail(tx, ctx.vendorId, id), sync };
}

/** Move an order along (or cancel it). The marketplace is told asynchronously where it supports that status. */
export async function transitionOrder(ctx: OpCtx, id: string, to: InternalOrderStatus, opts: Parameters<typeof transitionWithin>[4]) {
  const { c, vendorId } = ctx;
  const res = await withVendor(c.database.db, vendorId, (tx) => transitionWithin(tx, ctx, id, to, opts));
  if (res.sync.job) await dispatchSyncJob(c, res.sync.job);
  return { order: res.order, statusUpdate: toStatusUpdateDto(res.sync.update) };
}

/**
 * Hold stock for the lines that are still short (stock arrived later, another order was cancelled...). Idempotent:
 * lines that are fully held are left alone.
 */
export async function allocateOrder(tx: Tx, ctx: OpCtx, id: string): Promise<{ inventoryStatus: string; reserved: number; wanted: number }> {
  const o = await getOrderRow(tx, ctx.vendorId, id);
  if (!['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch'].includes(o.status)) throw new AppError('INVALID_STATE', `A ${o.status} order does not need stock`, { details: { status: o.status } });
  // a unit the warehouse could not find (short pick) is a human decision: never silently re-reserve it
  if ((o.attentionReason ?? '').split(';').includes('short_pick')) {
    const held = (await tx.select().from(OI).where(and(eq(OI.vendorId, ctx.vendorId), eq(OI.orderId, id)))).reduce((n, i) => n + i.reservedQuantity, 0);
    return { inventoryStatus: o.inventoryStatus, reserved: held, wanted: held };
  }
  const items = await tx.select().from(OI).where(and(eq(OI.vendorId, ctx.vendorId), eq(OI.orderId, id)));
  let wanted = 0;
  let reserved = 0;
  for (const it of items) {
    if (!it.variantId) continue;
    wanted += it.quantity;
    const res = await reserveForOrderItem(tx, { vendorId: ctx.vendorId, orderId: id, orderItemId: it.id, variantId: it.variantId, quantity: it.quantity, actor: ctx.actor });
    reserved += res.reserved;
    if (res.reserved !== it.reservedQuantity) await tx.update(OI).set({ reservedQuantity: res.reserved, status: res.reserved === it.quantity ? 'allocated' : it.status }).where(eq(OI.id, it.id));
  }
  const inventoryStatus = inventoryStatusFor(wanted, reserved);
  const unmapped = items.filter((i) => !i.variantId).map((i) => i.sku);
  const attention = [unmapped.length ? `unmapped_sku:${unmapped.join(',')}` : null, reserved < wanted ? 'insufficient_stock' : null].filter(Boolean).join(';') || null;
  const changed = inventoryStatus !== o.inventoryStatus || attention !== o.attentionReason;
  if (changed) {
    await tx.update(O).set({ inventoryStatus, attentionReason: attention, version: sql`${O.version} + 1` }).where(eq(O.id, id));
    await effects(tx, ctx).audit({ action: 'order.allocate', resourceType: 'order', resourceId: id, before: { inventoryStatus: o.inventoryStatus }, after: { inventoryStatus, reserved, wanted } });
  }
  return { inventoryStatus, reserved, wanted };
}

// ------------------------------------------------------------------------------------------------
// import helpers used by webhooks / polling
// ------------------------------------------------------------------------------------------------
export async function importOrderForAccount(ctx: OpCtx, account: AccountRow, order: Parameters<typeof importNormalizedOrder>[3]): Promise<ImportResult> {
  return withVendor(ctx.c.database.db, ctx.vendorId, (tx) => importNormalizedOrder(tx, ctx, account, order));
}

/** a webhook that carries only the order id: fetch the order from the marketplace, then import it (idempotent) */
export async function ingestOrderById(ctx: OpCtx, accountId: string, externalOrderId: string): Promise<ImportResult | null> {
  const { c, vendorId } = ctx;
  const account = await withVendor(c.database.db, vendorId, async (tx) => (await tx.select().from(schema.marketplaceAccounts).where(and(eq(schema.marketplaceAccounts.id, accountId), eq(schema.marketplaceAccounts.vendorId, vendorId))))[0]);
  if (!account) throw Errors.notFound('Marketplace account', accountId);
  const order = await new ConnectorHost(c).run(vendorId, accountId, async (connector, cctx) => {
    if (!connector.getOrder) throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} cannot fetch a single order`, { details: { capability: 'orders.getOrder' } });
    return connector.getOrder(cctx, { externalOrderId });
  });
  if (!order) return null;
  return importOrderForAccount(ctx, account, order);
}

// ------------------------------------------------------------------------------------------------
// the central dashboard numbers: every marketplace, one view
// ------------------------------------------------------------------------------------------------
export async function orderSummary(tx: Tx, vendorId: string, since: Date) {
  const rows = await tx
    .select({ marketplace: O.marketplace, status: O.status, n: sql<number>`count(*)::int`, revenue: sql<number>`coalesce(sum(${O.totalMinor}), 0)::bigint` })
    .from(O)
    .where(and(eq(O.vendorId, vendorId), gte(O.placedAt, since)))
    .groupBy(O.marketplace, O.status);
  const [attention] = await tx.select({ n: sql<number>`count(*)::int` }).from(O).where(and(eq(O.vendorId, vendorId), sql`${O.attentionReason} IS NOT NULL`, sql`${O.status} NOT IN ('cancelled','returned','delivered')`));
  const byStatus: Record<string, number> = {};
  const byMarketplace: Record<string, { orders: number; revenueMinor: number }> = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    const m = (byMarketplace[r.marketplace] ??= { orders: 0, revenueMinor: 0 });
    m.orders += r.n;
    if (r.status !== 'cancelled') m.revenueMinor += Number(r.revenue);
    total += r.n;
  }
  return { since: since.toISOString(), total, byStatus, byMarketplace, needsAttention: attention?.n ?? 0 };
}

/**
 * A warehouse could not supply units that were reserved for an order line (a short pick). The reservation for them must have
 * been released already; this keeps the ORDER honest: fewer units held, inventory status partial/unallocated, attention flag.
 */
export async function recordShortage(tx: Tx, ctx: OpCtx, orderItemId: string, quantity: number, note: string): Promise<void> {
  const [it] = await tx.select().from(OI).where(and(eq(OI.id, orderItemId), eq(OI.vendorId, ctx.vendorId)));
  if (!it) throw new AppError('NOT_FOUND', 'Order item not found', { details: { resource: 'order_item', id: orderItemId } });
  const reserved = Math.max(0, it.reservedQuantity - quantity);
  await tx.update(OI).set({ reservedQuantity: reserved, status: reserved >= it.quantity ? it.status : 'new' }).where(eq(OI.id, it.id));
  const items = await tx.select().from(OI).where(and(eq(OI.vendorId, ctx.vendorId), eq(OI.orderId, it.orderId)));
  const wanted = items.filter((i) => i.variantId).reduce((n, i) => n + i.quantity, 0);
  const held = items.filter((i) => i.variantId).reduce((n, i) => n + i.reservedQuantity, 0);
  const o = await getOrderRow(tx, ctx.vendorId, it.orderId);
  const reasons = new Set((o.attentionReason ?? '').split(';').filter(Boolean));
  reasons.add('short_pick');
  await tx.update(O).set({ inventoryStatus: inventoryStatusFor(wanted, held), attentionReason: [...reasons].join(';'), version: sql`${O.version} + 1` }).where(eq(O.id, o.id));
  await effects(tx, ctx).audit({ action: 'order.short_pick', resourceType: 'order', resourceId: o.id, metadata: { orderItemId, quantity, note } });
  await effects(tx, ctx).event({ type: 'order.needs_attention', aggregateType: 'order', aggregateId: o.id, payload: { reason: 'short_pick', orderItemId, quantity } });
}

/** a human resolved what an attention flag was about (e.g. a short pick): take that reason off the order */
export async function clearAttention(tx: Tx, ctx: OpCtx, orderId: string, reason: string): Promise<void> {
  const o = await getOrderRow(tx, ctx.vendorId, orderId);
  const rest = (o.attentionReason ?? '').split(';').filter((r) => r && r !== reason);
  if (rest.length === (o.attentionReason ?? '').split(';').filter(Boolean).length) return;
  await tx.update(O).set({ attentionReason: rest.join(';') || null, version: sql`${O.version} + 1` }).where(eq(O.id, orderId));
  await effects(tx, ctx).audit({ action: 'order.attention_cleared', resourceType: 'order', resourceId: orderId, before: { attentionReason: o.attentionReason }, after: { attentionReason: rest.join(';') || null }, metadata: { reason } });
}
