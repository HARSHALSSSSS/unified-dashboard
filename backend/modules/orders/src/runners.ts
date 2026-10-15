import { and, asc, eq, inArray, schema, sql, withVendor } from '@oms/database';
import { requireCapability, type InternalOrderStatus } from '@oms/marketplace-core';
import { AppError } from '@oms/shared';
import { classifyFailure, executeSyncJob, enqueueSyncJob, type SyncRunner } from '@oms/mod-sync';
import { systemOpCtx, type EventConsumer, type JobHandler, type OpCtx } from '@oms/module-kit';
import { importNormalizedOrder } from './ingest';
import { allocateOrder } from './service';

const A = schema.marketplaceAccounts;
const O = schema.orders;
const OI = schema.orderItems;
const UPD = schema.orderStatusUpdates;

// ------------------------------------------------------------------------------------------------
// import: poll the marketplace for orders changed since the watermark
// ------------------------------------------------------------------------------------------------
const ordersRunner: SyncRunner = async (ctx) => {
  const { c, vendorId, accountId, host } = ctx;
  if (!accountId) throw new AppError('BAD_REQUEST', 'order sync needs an account');
  const db = c.database.db;
  const account = await withVendor(db, vendorId, async (tx) => (await tx.select().from(A).where(and(eq(A.id, accountId), eq(A.vendorId, vendorId))))[0]);
  if (!account) throw new AppError('NOT_FOUND', 'Marketplace account not found', { details: { resource: 'marketplace_account', id: accountId } });
  const connector = c.connectors.get(account.marketplace);
  requireCapability(connector, 'orders.fetch');

  const plan = connector.polling?.orders ?? { intervalSeconds: 300, lookbackMinutes: 24 * 60, overlapMinutes: 15 };
  const state = account.syncState as { ordersSince?: string };
  const explicit = typeof ctx.payload.since === 'string' ? new Date(ctx.payload.since) : null;
  const maxLookbackMs = (connector.capabilities.orders.maxLookbackDays ?? 30) * 24 * 3600_000;
  const startedAt = new Date();
  const earliest = new Date(startedAt.getTime() - maxLookbackMs);
  const since = new Date(Math.max((explicit ?? (state.ordersSince ? new Date(state.ordersSince) : new Date(startedAt.getTime() - plan.lookbackMinutes * 60_000))).getTime(), earliest.getTime()));
  const opctx: OpCtx = systemOpCtx(c, vendorId, 'order-sync');
  const stats = { fetched: 0, created: 0, duplicates: 0, statusChanges: 0, failed: 0 };
  let cursor: string | null = ((ctx.job.cursor as { cursor?: string | null } | null)?.cursor) ?? null;
  await ctx.log('info', `fetching orders changed since ${since.toISOString()}`);

  do {
    const page = await host.run(vendorId, accountId, (conn, cctx) => conn.fetchOrders!(cctx, { since, cursor }));
    for (const order of page.items) {
      stats.fetched++;
      try {
        const res = await withVendor(db, vendorId, (tx) => importNormalizedOrder(tx, opctx, account, order));
        if (res.created) stats.created++; else stats.duplicates++;
        if (res.statusChanged) stats.statusChanges++;
      } catch (e) {
        // one bad order must not block the rest; infrastructure errors (not AppError) abort and the job retries
        if (!(e instanceof AppError)) throw e;
        stats.failed++;
        ctx.addFailure({ ref: order.externalOrderId, code: e.code, message: e.message });
      }
    }
    cursor = page.nextCursor;
    await ctx.setCursor(cursor ? { cursor } : null);
    await ctx.progress({ done: stats.fetched, failed: stats.failed });
  } while (cursor);

  // advance the watermark only when every order was handled: failed ones are re-fetched by the overlap window next time
  if (stats.failed === 0) {
    const next = new Date(startedAt.getTime() - plan.overlapMinutes * 60_000);
    await withVendor(db, vendorId, (tx) => tx.update(A).set({ syncState: sql`${A.syncState} || ${JSON.stringify({ ordersSince: next.toISOString() })}::jsonb` }).where(eq(A.id, accountId)));
  }
  return { stats };
};

// ------------------------------------------------------------------------------------------------
// outbound status: our system -> connector -> marketplace
// ------------------------------------------------------------------------------------------------
const statusRunner: SyncRunner = async (ctx): Promise<{ stats: Record<string, number> }> => {
  const { c, vendorId, host } = ctx;
  const db = c.database.db;
  const updateId = String(ctx.payload.updateId ?? '');
  const loaded = await withVendor(db, vendorId, async (tx) => {
    const [u] = await tx.select().from(UPD).where(and(eq(UPD.id, updateId), eq(UPD.vendorId, vendorId)));
    if (!u) return null;
    const [o] = await tx.select().from(O).where(eq(O.id, u.orderId));
    const items = await tx.select().from(OI).where(eq(OI.orderId, u.orderId));
    return { u, o: o!, items };
  });
  if (!loaded) throw new AppError('NOT_FOUND', 'Order status update not found', { details: { resource: 'order_status_update', id: updateId } });
  const { u, o, items } = loaded;
  if (u.status === 'successful' || u.status === 'skipped') return { stats: { alreadyDone: 1 } };

  await withVendor(db, vendorId, (tx) => tx.update(UPD).set({ status: 'sent', sentAt: new Date(), attempts: sql`${UPD.attempts} + 1`, syncJobId: ctx.job.id }).where(eq(UPD.id, u.id)));
  try {
    const result = await host.run(vendorId, u.marketplaceAccountId, async (conn, cctx) => {
      requireCapability(conn, 'orders.updateStatus');
      if (conn.canRequestOrderStatus && !conn.canRequestOrderStatus(u.requestedStatus as InternalOrderStatus)) return { ok: false as const, errorCode: 'UNSUPPORTED_STATUS', message: `${conn.displayName} cannot be told "${u.requestedStatus}"`, skip: true };
      const track = u.tracking ?? { number: o.trackingNumber ?? undefined, carrier: o.carrier ?? undefined };
      return conn.updateOrderStatus!(cctx, {
        externalOrderId: o.externalOrderId, status: u.requestedStatus as InternalOrderStatus,
        items: items.map((i) => ({ externalItemId: i.externalItemId, sku: i.sku, quantity: i.quantity })),
        ...(track.number ? { tracking: { number: track.number, carrier: track.carrier ?? 'Other' } } : {}),
      });
    });
    await withVendor(db, vendorId, async (tx) => {
      if (result.ok) {
        await tx.update(UPD).set({ status: 'successful', completedAt: new Date(), marketplaceStatus: (result as { marketplaceStatus?: string }).marketplaceStatus ?? null, errorCode: null, errorMessage: null }).where(eq(UPD.id, u.id));
        await tx.update(O).set({ lastMarketplaceSyncAt: new Date(), ...((result as { marketplaceStatus?: string }).marketplaceStatus ? { marketplaceStatus: (result as { marketplaceStatus?: string }).marketplaceStatus } : {}) }).where(eq(O.id, o.id));
      } else if ('skip' in result && result.skip) {
        await tx.update(UPD).set({ status: 'skipped', completedAt: new Date(), errorCode: result.errorCode, errorMessage: result.message }).where(eq(UPD.id, u.id));
      } else {
        // the marketplace answered and said no: a permanent rejection (retrying the same request will not change it)
        await tx.update(UPD).set({ status: 'failed', completedAt: new Date(), errorCode: result.errorCode ?? 'REJECTED', errorMessage: (result.message ?? 'The marketplace rejected the status change').slice(0, 300) }).where(eq(UPD.id, u.id));
      }
    });
    if (!result.ok && !('skip' in result && result.skip)) ctx.addFailure({ ref: o.externalOrderId, code: result.errorCode, message: result.message ?? 'rejected' });
    return { stats: { sent: result.ok ? 1 : 0, rejected: result.ok || ('skip' in result && result.skip) ? 0 : 1 } };
  } catch (e) {
    const f = classifyFailure(e);
    const willRetry = f.retryable && !ctx.isLastAttempt;
    await withVendor(db, vendorId, (tx) => tx.update(UPD).set({ status: willRetry ? 'retrying' : 'failed', errorCode: f.code, errorMessage: f.message.slice(0, 300), completedAt: willRetry ? null : new Date() }).where(eq(UPD.id, u.id)));
    throw e;
  }
};

const wrap = (name: string, queue: 'syncMarketplace' | 'marketplacePush', runner: SyncRunner): JobHandler => ({ queue, name, handle: (env, c) => executeSyncJob(c, env, runner) });
export const orderJobHandlers: JobHandler[] = [wrap('sync.orders', 'syncMarketplace', ordersRunner), wrap('sync.order_status', 'marketplacePush', statusRunner)];

export async function requestOrderSync(c: OpCtx['c'], vendorId: string, accountId: string, o: { requestedBy?: string | null; since?: string } = {}) {
  return enqueueSyncJob(c, { vendorId, accountId, type: 'orders', trigger: o.requestedBy ? 'manual' : 'event', coalesce: true, idempotencyKey: `orders:${accountId}:${Date.now()}`, payload: o.since ? { since: o.since } : {}, requestedBy: o.requestedBy ?? null });
}

// ------------------------------------------------------------------------------------------------
// backorders: stock came back (received / another order cancelled) -> hold it for orders that were short
// ------------------------------------------------------------------------------------------------
const reallocate = (event: string, name: string): EventConsumer => ({
  event,
  name,
  async handle(e, c) {
    const vendorId = e.vendorId;
    const variantId = (e.payload as { variantId?: string } | null)?.variantId;
    const after = (e.payload as { availableAfter?: number; availableBefore?: number } | null) ?? {};
    if (!vendorId || !variantId || !((after.availableAfter ?? 0) > (after.availableBefore ?? 0))) return; // only when stock INCREASED
    const ctx = systemOpCtx(c, vendorId, 'order-backorder');
    const short = await withVendor(c.database.db, vendorId, (tx) =>
      tx.selectDistinct({ id: O.id, placedAt: O.placedAt }).from(O).innerJoin(OI, and(eq(OI.orderId, O.id), eq(OI.vendorId, O.vendorId)))
        .where(and(eq(O.vendorId, vendorId), inArray(O.inventoryStatus, ['partial', 'unallocated']), eq(OI.variantId, variantId), inArray(O.status, ['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch']))).orderBy(asc(O.placedAt)).limit(100),
    );
    for (const o of short) {
      try { await withVendor(c.database.db, vendorId, (tx) => allocateOrder(tx, ctx, o.id)); }
      catch (err) { c.logger.warn({ orderId: o.id, err: (err as Error).message }, 'backorder allocation failed'); }
    }
  },
});
export const orderConsumers: EventConsumer[] = [reallocate('inventory.adjusted', 'orders.backorder-adjusted'), reallocate('inventory.released', 'orders.backorder-released')];
