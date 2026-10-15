import { and, asc, eq, inArray, schema, sql, withVendor, type Tx } from '@oms/database';
import type { InventoryUpdate, OperationResult } from '@oms/marketplace-core';
import { requireCapability } from '@oms/marketplace-core';
import { AppError, Errors, newId } from '@oms/shared';
import { availabilityFor } from '@oms/mod-inventory';
import { enqueueSyncJob, type SyncRunner } from '@oms/mod-sync';
import type { Container } from '@oms/module-kit';
import type { Ctx } from './ctx';
import { fx } from './ctx';
import { computeSellable, DEFAULT_POLICY, type ChannelPolicy } from './domain';

const L = schema.marketplaceListings;
const POLICY = schema.channelInventoryPolicies;
const U = schema.channelStockUpdates;
const A = schema.marketplaceAccounts;
const V = schema.productVariants;

// ------------------------------------------------------------------------------------------------
// channel inventory policy (per marketplace account)
// ------------------------------------------------------------------------------------------------
export type PolicyRow = typeof POLICY.$inferSelect;

export const toPolicyDto = (accountId: string, p: PolicyRow | null) => ({
  marketplaceAccountId: accountId,
  mode: (p?.mode ?? DEFAULT_POLICY.mode) as 'sync' | 'paused',
  safetyBuffer: p?.safetyBuffer ?? DEFAULT_POLICY.safetyBuffer,
  allocationPercent: p?.allocationPercent ?? DEFAULT_POLICY.allocationPercent,
  maxQuantity: p ? p.maxQuantity : DEFAULT_POLICY.maxQuantity,
  warehouseIds: p?.warehouseIds ?? ([] as string[]),
  isDefault: !p,
  version: p?.version ?? 0,
  updatedAt: p ? p.updatedAt.toISOString() : null,
});

export async function getPolicy(tx: Tx, vendorId: string, accountId: string): Promise<PolicyRow | null> {
  const [p] = await tx.select().from(POLICY).where(and(eq(POLICY.vendorId, vendorId), eq(POLICY.marketplaceAccountId, accountId)));
  return p ?? null;
}
const asPolicy = (p: PolicyRow | null): ChannelPolicy => (p ? { mode: p.mode as ChannelPolicy['mode'], safetyBuffer: p.safetyBuffer, allocationPercent: p.allocationPercent, maxQuantity: p.maxQuantity } : DEFAULT_POLICY);

export async function assertAccount(tx: Tx, vendorId: string, accountId: string) {
  const [a] = await tx.select().from(A).where(and(eq(A.id, accountId), eq(A.vendorId, vendorId)));
  if (!a) throw Errors.notFound('Marketplace account', accountId);
  return a;
}

export interface PolicyInput { mode?: 'sync' | 'paused'; safetyBuffer?: number; allocationPercent?: number; maxQuantity?: number | null; warehouseIds?: string[] }

/** Changing the rules changes what every listing may sell: recompute them all (mark dirty + one coalesced inventory job). */
export async function savePolicy(ctx: Ctx, accountId: string, input: PolicyInput) {
  const { c, vendorId } = ctx;
  const out = await withVendor(c.database.db, vendorId, async (tx) => {
    await assertAccount(tx, vendorId, accountId);
    if (input.warehouseIds?.length) {
      const found = await tx.select({ id: schema.warehouses.id }).from(schema.warehouses).where(and(eq(schema.warehouses.vendorId, vendorId), inArray(schema.warehouses.id, input.warehouseIds)));
      if (found.length !== new Set(input.warehouseIds).size) throw Errors.notFound('Warehouse');
    }
    const cur = await getPolicy(tx, vendorId, accountId);
    const values = {
      mode: input.mode ?? cur?.mode ?? DEFAULT_POLICY.mode, safetyBuffer: input.safetyBuffer ?? cur?.safetyBuffer ?? DEFAULT_POLICY.safetyBuffer,
      allocationPercent: input.allocationPercent ?? cur?.allocationPercent ?? DEFAULT_POLICY.allocationPercent, maxQuantity: input.maxQuantity !== undefined ? input.maxQuantity : cur?.maxQuantity ?? DEFAULT_POLICY.maxQuantity,
      warehouseIds: input.warehouseIds ?? cur?.warehouseIds ?? [],
    };
    const [row] = await tx.insert(POLICY).values({ vendorId, marketplaceAccountId: accountId, ...values })
      .onConflictDoUpdate({ target: [POLICY.marketplaceAccountId], set: { ...values, version: sql`${POLICY.version} + 1` } }).returning();
    await fx(tx, ctx).audit({ action: 'channel_inventory.policy', resourceType: 'marketplace_account', resourceId: accountId, before: cur ? { mode: cur.mode, safetyBuffer: cur.safetyBuffer, allocationPercent: cur.allocationPercent, maxQuantity: cur.maxQuantity } : null, after: values });
    const resumed = values.mode === 'sync';
    const dirtied = resumed ? await markDirty(tx, vendorId, { accountId }) : [];
    return { row: row!, dirtied };
  });
  if (out.dirtied.length) await requestInventorySync(c, vendorId, accountId, 'manual');
  return toPolicyDto(accountId, out.row);
}

// ------------------------------------------------------------------------------------------------
// dirty tracking: "this listing's channel quantity may be stale"
// ------------------------------------------------------------------------------------------------
/** flags live listings; returns the distinct accounts affected */
export async function markDirty(tx: Tx, vendorId: string, f: { variantId?: string; accountId?: string; listingIds?: string[] }): Promise<string[]> {
  const rows = await tx
    .update(L)
    .set({ quantityDirty: true, quantityDirtyAt: new Date() })
    .where(and(eq(L.vendorId, vendorId), eq(L.status, 'active'), f.variantId ? eq(L.variantId, f.variantId) : undefined, f.accountId ? eq(L.marketplaceAccountId, f.accountId) : undefined, f.listingIds ? inArray(L.id, f.listingIds) : undefined))
    .returning({ accountId: L.marketplaceAccountId });
  return [...new Set(rows.map((r) => r.accountId))];
}

/** one coalesced inventory job per account, however many events asked for it */
export async function requestInventorySync(c: Container, vendorId: string, accountId: string, trigger: 'event' | 'manual' | 'schedule' = 'event', requestedBy: string | null = null) {
  return enqueueSyncJob(c, { vendorId, accountId, type: 'inventory', trigger, coalesce: true, idempotencyKey: `inventory:${accountId}:${newId()}`, requestedBy });
}

// ------------------------------------------------------------------------------------------------
// the inventory sync runner:  central stock -> available -> channel sellable -> push -> record result
// ------------------------------------------------------------------------------------------------
const BATCH = 100;
const MAX_ROUNDS = 50;

export const inventoryRunner: SyncRunner = async (ctx) => {
  const { c, vendorId, accountId, host } = ctx;
  if (!accountId) throw new AppError('BAD_REQUEST', 'inventory sync needs an account');
  const db = c.database.db;
  const setup = await withVendor(db, vendorId, async (tx) => ({ account: await assertAccount(tx, vendorId, accountId), policy: await getPolicy(tx, vendorId, accountId) }));
  const connector = c.connectors.get(setup.account.marketplace);
  const policy = asPolicy(setup.policy);
  const stats = { pushed: 0, unchanged: 0, failed: 0, batches: 0 };

  if (!connector.capabilities.inventory.push) {
    await ctx.log('warn', `${connector.displayName} does not accept inventory pushes; nothing to do`);
    await withVendor(db, vendorId, (tx) => tx.update(L).set({ quantityDirty: false }).where(and(eq(L.marketplaceAccountId, accountId), eq(L.vendorId, vendorId))));
    return { stats };
  }
  if (policy.mode === 'paused') {
    await ctx.log('info', 'channel inventory sync is paused for this account; quantities stay as they are');
    return { stats };
  }

  const total = await withVendor(db, vendorId, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, accountId), eq(L.status, 'active'), eq(L.quantityDirty, true))))[0]!.n);
  await ctx.progress({ total, done: 0, failed: 0 });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const batch = await withVendor(db, vendorId, async (tx) => {
      const dirty = await tx.select().from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, accountId), eq(L.status, 'active'), eq(L.quantityDirty, true))).orderBy(asc(L.quantityDirtyAt)).limit(BATCH);
      const av = await availabilityFor(tx, vendorId, [...new Set(dirty.map((l) => l.variantId))], setup.policy?.warehouseIds?.length ? setup.policy.warehouseIds : undefined);
      const items = dirty.map((l) => {
        const available = av.get(l.variantId)?.available ?? 0;
        return { listing: l, available, sellable: computeSellable(available, policy, { buffer: l.bufferOverride, max: l.maxQuantityOverride }) };
      });
      // nothing to tell the marketplace when it already shows this number
      const same = items.filter((i) => i.listing.pushedQuantity === i.sellable);
      for (const i of same) await tx.update(L).set({ sellableQuantity: i.sellable, quantityDirty: sql`(${L.quantityDirtyAt} IS DISTINCT FROM ${i.listing.quantityDirtyAt})` }).where(eq(L.id, i.listing.id));
      const todo = items.filter((i) => i.listing.pushedQuantity !== i.sellable);
      const ids = new Map<string, string>();
      for (const i of todo) {
        const [u] = await tx.insert(U).values({ vendorId, marketplaceAccountId: accountId, listingId: i.listing.id, syncJobId: ctx.job.id, externalSku: i.listing.externalSku, availableQuantity: i.available, requestedQuantity: i.sellable, status: 'pending' }).returning({ id: U.id });
        ids.set(i.listing.id, u!.id);
      }
      return { todo, ids, unchanged: same.length, fetched: dirty.length };
    });
    if (batch.fetched === 0) break;
    stats.unchanged += batch.unchanged;
    if (batch.todo.length > 0) {
      stats.batches++;
      const updates: InventoryUpdate[] = batch.todo.map((i) => ({ externalSku: i.listing.externalSku, quantity: i.sellable, externalListingId: i.listing.externalListingId ?? undefined }));
      let results: OperationResult[];
      try {
        results = await host.run(vendorId, accountId, async (conn, cctx) => {
          requireCapability(conn, 'inventory.push');
          return conn.pushInventory!(cctx, updates);
        });
      } catch (e) {
        // the whole call failed (auth / outage / rate limit): record it and let the job retry; flags stay dirty
        const msg = e instanceof Error ? e.message.slice(0, 300) : 'push failed';
        await withVendor(db, vendorId, (tx) => tx.update(U).set({ status: 'failed', errorCode: e instanceof AppError ? e.code : 'ERROR', errorMessage: msg, completedAt: new Date() }).where(inArray(U.id, [...batch.ids.values()])));
        throw e;
      }
      const bySku = new Map(results.map((r) => [r.externalSku, r]));
      await withVendor(db, vendorId, async (tx) => {
        for (const i of batch.todo) {
          const r = bySku.get(i.listing.externalSku);
          const updateId = batch.ids.get(i.listing.id)!;
          if (r?.ok) {
            await tx.update(U).set({ status: 'succeeded', completedAt: new Date() }).where(eq(U.id, updateId));
            await tx.update(L).set({ pushedQuantity: i.sellable, sellableQuantity: i.sellable, quantityPushedAt: new Date(), lastErrorCode: null, quantityDirty: sql`(${L.quantityDirtyAt} IS DISTINCT FROM ${i.listing.quantityDirtyAt})` }).where(eq(L.id, i.listing.id));
            stats.pushed++;
          } else {
            const code = r?.errorCode ?? 'NO_RESULT';
            const message = r?.message ?? 'The marketplace returned no result for this SKU';
            await tx.update(U).set({ status: 'failed', errorCode: code, errorMessage: message.slice(0, 300), completedAt: new Date() }).where(eq(U.id, updateId));
            await tx.update(L).set({ sellableQuantity: i.sellable, lastErrorCode: code, quantityDirty: false }).where(eq(L.id, i.listing.id));
            ctx.addFailure({ ref: i.listing.externalSku, code, message });
            stats.failed++;
          }
        }
      });
    }
    await ctx.progress({ done: stats.pushed + stats.unchanged + stats.failed, failed: stats.failed });
    if (batch.fetched < BATCH) {
      // a quantity may have changed while we were pushing: one more look
      const more = await withVendor(db, vendorId, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, accountId), eq(L.status, 'active'), eq(L.quantityDirty, true))))[0]!.n);
      if (more === 0) break;
    }
  }
  await withVendor(db, vendorId, (tx) => tx.update(A).set({ lastSyncedAt: new Date() }).where(eq(A.id, accountId)));
  return { stats };
};

// ------------------------------------------------------------------------------------------------
// prices
// ------------------------------------------------------------------------------------------------
export const pricesRunner: SyncRunner = async (ctx) => {
  const { c, vendorId, accountId, host } = ctx;
  if (!accountId) throw new AppError('BAD_REQUEST', 'price sync needs an account');
  const db = c.database.db;
  const ids = (ctx.payload.listingIds as string[] | undefined) ?? [];
  const rows = await withVendor(db, vendorId, (tx) =>
    tx.select({ l: L, price: V.sellingPriceMinor }).from(L).innerJoin(V, and(eq(V.id, L.variantId), eq(V.vendorId, L.vendorId)))
      .where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, accountId), eq(L.status, 'active'), ids.length ? inArray(L.id, ids) : undefined)).orderBy(L.id).limit(5000),
  );
  const updates = rows.map((r) => ({ externalSku: r.l.externalSku, priceMinor: r.l.priceMinor ?? r.price ?? 0, currency: r.l.currency.trim() })).filter((u) => u.priceMinor > 0);
  if (updates.length === 0) return { stats: { pushed: 0, failed: 0 } };
  await ctx.progress({ total: updates.length, done: 0, failed: 0 });
  // chunked: a bulk price change (up to thousands of listings) is pushed in full, in batches the marketplace accepts
  let failed = 0;
  let pushed = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    const results = await host.run(vendorId, accountId, async (conn, cctx) => {
      requireCapability(conn, 'pricing.push');
      return conn.pushPrices!(cctx, batch);
    });
    for (const r of results) if (!r.ok) { failed++; ctx.addFailure({ ref: r.externalSku ?? '?', code: r.errorCode, message: r.message ?? 'price rejected' }); } else pushed++;
    await ctx.progress({ done: pushed, failed });
  }
  return { stats: { pushed, failed } };
};

export async function requestPriceSync(c: Container, vendorId: string, accountId: string, listingIds: string[]) {
  return enqueueSyncJob(c, { vendorId, accountId, type: 'prices', trigger: 'event', idempotencyKey: `prices:${accountId}:${newId()}`, payload: { listingIds } });
}

export async function recentStockUpdates(tx: Tx, vendorId: string, listingId: string, limit = 50) {
  const rows = await tx.select().from(U).where(and(eq(U.vendorId, vendorId), eq(U.listingId, listingId))).orderBy(sql`${U.requestedAt} DESC`).limit(limit);
  return rows.map((u) => ({
    id: u.id, listingId: u.listingId, syncJobId: u.syncJobId, externalSku: u.externalSku, availableQuantity: u.availableQuantity, requestedQuantity: u.requestedQuantity, status: u.status as 'pending' | 'sent' | 'succeeded' | 'failed',
    errorCode: u.errorCode, errorMessage: u.errorMessage, requestedAt: u.requestedAt.toISOString(), completedAt: u.completedAt ? u.completedAt.toISOString() : null,
  }));
}

/**
 * The price a listing SHOWS on its marketplace (null = follow the variant's own selling price). Called by the pricing module,
 * which owns the decision; listings owns the row. The caller then asks for a price sync.
 */
export async function setListingPrice(tx: Tx, vendorId: string, variantId: string, accountId: string, price: { priceMinor: number | null; mrpMinor?: number | null }): Promise<Array<{ id: string; externalSku: string }>> {
  return tx.update(L).set({ priceMinor: price.priceMinor, ...(price.mrpMinor !== undefined ? { mrpMinor: price.mrpMinor } : {}), version: sql`${L.version} + 1` })
    .where(and(eq(L.vendorId, vendorId), eq(L.variantId, variantId), eq(L.marketplaceAccountId, accountId)))
    .returning({ id: L.id, externalSku: L.externalSku });
}
