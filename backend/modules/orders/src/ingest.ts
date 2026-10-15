import { and, eq, inArray, pgError, PG, schema, sql, type Tx } from '@oms/database';
import { marketplaceTransition, ORDER_STATUSES, type InternalOrderStatus, type NormalizedOrder } from '@oms/marketplace-core';
import { AppError } from '@oms/shared';
import { nextCounter, reserveForOrderItem } from '@oms/mod-inventory';
import { effects, type OpCtx } from '@oms/module-kit';
import { z } from 'zod';
import { inventoryStatusFor, itemStatusFor, orderNumber, PRE_DISPATCH } from './domain';
import { performTransition, recordIgnored, type OrderRow } from './status';

const O = schema.orders;
const OI = schema.orderItems;
const L = schema.marketplaceListings;
const V = schema.productVariants;
export type AccountRow = typeof schema.marketplaceAccounts.$inferSelect;

/** What a connector must hand over. Anything else is rejected BEFORE it touches the database. */
const IncomingSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(100),
  status: z.enum(ORDER_STATUSES),
  marketplaceStatus: z.string().max(100),
  placedAt: z.coerce.date(),
  currency: z.string().trim().length(3),
  totalMinor: z.number().int().min(0),
  taxMinor: z.number().int().min(0).optional(),
  shippingMinor: z.number().int().min(0).optional(),
  discountMinor: z.number().int().min(0).optional(),
  items: z.array(z.object({
    externalItemId: z.string().trim().min(1).max(100), externalListingId: z.string().max(100).optional(), sku: z.string().trim().min(1).max(100), title: z.string().max(500),
    quantity: z.number().int().min(1).max(100_000), unitPriceMinor: z.number().int().min(0), taxMinor: z.number().int().min(0), discountMinor: z.number().int().min(0),
  })).min(1).max(500),
});

export interface ImportResult {
  orderId: string;
  orderNumber: string;
  created: boolean;
  /** this marketplace order already existed (a re-delivery / re-poll): nothing was duplicated */
  duplicate: boolean;
  statusChanged: boolean;
  status: InternalOrderStatus;
  needsAttention: boolean;
}

/**
 * Normalise -> validate -> save -> reserve inventory -> (downstream via events).
 * Uniqueness is (vendor, marketplace, marketplace order id): importing the same order twice - by poll, webhook, retry or a
 * race between them - yields ONE order; a repeat only applies a newer marketplace status.
 */
export async function importNormalizedOrder(tx: Tx, ctx: OpCtx, account: AccountRow, incoming: NormalizedOrder): Promise<ImportResult> {
  const parsed = IncomingSchema.safeParse(incoming);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The marketplace order is not valid', { details: { externalOrderId: incoming?.externalOrderId, issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  const { vendorId } = ctx;
  const existing = await findOrder(tx, vendorId, account.marketplace, incoming.externalOrderId);
  if (existing) return applyMarketplaceUpdate(tx, ctx, existing, incoming);

  try {
    // savepoint: a lost race on the unique key must not poison the surrounding transaction
    return await tx.transaction(async (sp) => createOrder(sp, ctx, account, incoming));
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === PG.UNIQUE_VIOLATION && pg.constraint && /^orders_/.test(pg.constraint)) {
      const won = await findOrder(tx, vendorId, account.marketplace, incoming.externalOrderId);
      if (won) return applyMarketplaceUpdate(tx, ctx, won, incoming);
    }
    throw e;
  }
}

export async function findOrder(tx: Tx, vendorId: string, marketplace: string, externalOrderId: string): Promise<OrderRow | null> {
  const [o] = await tx.select().from(O).where(and(eq(O.vendorId, vendorId), eq(O.marketplace, marketplace), eq(O.externalOrderId, externalOrderId)));
  return o ?? null;
}

async function createOrder(tx: Tx, ctx: OpCtx, account: AccountRow, inc: NormalizedOrder): Promise<ImportResult> {
  const { vendorId } = ctx;
  const f = effects(tx, ctx);
  const skus = [...new Set(inc.items.map((i) => i.sku))];

  // marketplace SKU -> our variant: the tracked listing first, then a master SKU match
  const listings = await tx.select({ id: L.id, sku: L.externalSku, variantId: L.variantId }).from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, account.id), inArray(L.externalSku, skus)));
  const variants = await tx.select({ id: V.id, sku: V.sku }).from(V).where(and(eq(V.vendorId, vendorId), inArray(V.sku, skus), sql`${V.deletedAt} IS NULL`));
  const listingBySku = new Map(listings.map((l) => [l.sku, l]));
  const variantBySku = new Map(variants.map((v) => [v.sku, v.id]));
  const resolve = (sku: string) => ({ variantId: listingBySku.get(sku)?.variantId ?? variantBySku.get(sku) ?? null, listingId: listingBySku.get(sku)?.id ?? null });

  const subtotal = inc.items.reduce((n, i) => n + i.unitPriceMinor * i.quantity, 0);
  const tax = inc.taxMinor ?? inc.items.reduce((n, i) => n + i.taxMinor, 0);
  const discount = inc.discountMinor ?? inc.items.reduce((n, i) => n + i.discountMinor, 0);
  const shipping = inc.shippingMinor ?? Math.max(0, inc.totalMinor - (subtotal + tax - discount));
  const number = orderNumber(await nextCounter(tx, vendorId, 'order'));
  const pay = inc.payment ?? { method: 'unknown' as const };

  const [order] = await tx
    .insert(O)
    .values({
      vendorId, marketplaceAccountId: account.id, marketplace: account.marketplace, externalOrderId: inc.externalOrderId, orderNumber: number, status: inc.status, marketplaceStatus: inc.marketplaceStatus,
      placedAt: inc.placedAt, currency: inc.currency.toUpperCase(), subtotalMinor: subtotal, taxMinor: tax, shippingMinor: shipping, discountMinor: discount, totalMinor: inc.totalMinor,
      buyer: (inc.buyer ?? {}) as Record<string, unknown>, shippingAddress: (inc.shippingAddress ?? {}) as Record<string, unknown>, rawPayload: inc.raw as never,
      paymentMethod: pay.method, paymentStatus: pay.status ?? (pay.method === 'prepaid' ? 'paid' : pay.method === 'cod' ? 'pending' : 'unknown'), codAmountMinor: pay.method === 'cod' ? pay.codAmountMinor ?? inc.totalMinor : null,
      inventoryStatus: 'pending', lastMarketplaceSyncAt: new Date(), cancelledAt: inc.status === 'cancelled' ? new Date() : null,
    })
    .returning();

  const items = await tx
    .insert(OI)
    .values(inc.items.map((i) => ({
      vendorId, orderId: order!.id, externalItemId: i.externalItemId, externalListingId: i.externalListingId ?? null, variantId: resolve(i.sku).variantId, listingId: resolve(i.sku).listingId,
      sku: i.sku, title: i.title, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, taxMinor: i.taxMinor, discountMinor: i.discountMinor, status: itemStatusFor(inc.status, false),
    })))
    .returning();

  await tx.insert(schema.orderStatusEvents).values({ vendorId, orderId: order!.id, fromStatus: null, toStatus: inc.status, marketplaceStatus: inc.marketplaceStatus, source: ctx.actor.type === 'webhook' ? 'webhook' : 'marketplace', applied: true, note: `imported from ${account.marketplace}`, metadata: { accountId: account.id } });

  // ---- inventory: hold stock for orders that still have to be fulfilled
  let inventoryStatus: 'reserved' | 'partial' | 'unallocated' | 'released' = 'released';
  const reasons: string[] = [];
  if (PRE_DISPATCH.includes(inc.status)) {
    let reservedUnits = 0;
    let mappedUnits = 0;
    const unmapped: string[] = [];
    for (const it of items) {
      if (!it.variantId) { unmapped.push(it.sku); continue; }
      mappedUnits += it.quantity;
      const res = await reserveForOrderItem(tx, { vendorId, orderId: order!.id, orderItemId: it.id, variantId: it.variantId, quantity: it.quantity, actor: ctx.actor });
      reservedUnits += res.reserved;
      if (res.reserved > 0) await tx.update(OI).set({ reservedQuantity: res.reserved, status: res.reserved === it.quantity ? 'allocated' : 'new' }).where(eq(OI.id, it.id));
    }
    // never oversell: whatever could not be held is reported (and the order flagged), not forced
    inventoryStatus = inventoryStatusFor(mappedUnits, reservedUnits);
    if (unmapped.length) reasons.push(`unmapped_sku:${unmapped.join(',')}`);
    if (reservedUnits < mappedUnits) reasons.push('insufficient_stock');
  }
  const attention = reasons.length ? reasons.join(';') : null;
  await tx.update(O).set({ inventoryStatus, attentionReason: attention }).where(eq(O.id, order!.id));

  await f.event({ type: 'order.created', aggregateType: 'order', aggregateId: order!.id, payload: { orderNumber: number, marketplace: account.marketplace, accountId: account.id, externalOrderId: inc.externalOrderId, status: inc.status, totalMinor: inc.totalMinor, inventoryStatus } });
  if (attention) await f.event({ type: 'order.needs_attention', aggregateType: 'order', aggregateId: order!.id, payload: { reason: attention } });
  await f.audit({ action: 'order.import', resourceType: 'order', resourceId: order!.id, after: { orderNumber: number, marketplace: account.marketplace, externalOrderId: inc.externalOrderId, status: inc.status, inventoryStatus, items: items.length } });
  return { orderId: order!.id, orderNumber: number, created: true, duplicate: false, statusChanged: false, status: inc.status, needsAttention: attention !== null };
}

/** The order exists: take the marketplace's newer state if (and only if) it is a legitimate step forward. */
export async function applyMarketplaceUpdate(tx: Tx, ctx: OpCtx, existing: OrderRow, incoming: Pick<NormalizedOrder, 'status' | 'marketplaceStatus'>): Promise<ImportResult> {
  const base = { orderId: existing.id, orderNumber: existing.orderNumber, created: false, duplicate: true, needsAttention: existing.attentionReason !== null };
  const from = existing.status as InternalOrderStatus;
  const to = incoming.status;
  await tx.update(O).set({ marketplaceStatus: incoming.marketplaceStatus, lastMarketplaceSyncAt: new Date() }).where(eq(O.id, existing.id));
  if (from === to) return { ...base, statusChanged: false, status: from };
  if (marketplaceTransition(from, to) === 'apply') {
    const o = await performTransition(tx, ctx, existing, to, { source: ctx.actor.type === 'webhook' ? 'webhook' : 'marketplace', marketplaceStatus: incoming.marketplaceStatus });
    return { ...base, statusChanged: true, status: o.status as InternalOrderStatus };
  }
  await recordIgnored(tx, ctx, existing, to, incoming.marketplaceStatus);
  return { ...base, statusChanged: false, status: from };
}
