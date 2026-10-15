import { and, eq, inArray, isNull, schema, sql, withVendor } from '@oms/database';
import type { EventConsumer } from '@oms/module-kit';
import { markDirty, requestInventorySync, requestPriceSync } from './channel';

const L = schema.marketplaceListings;

/** payload of the inventory events written by the ledger */
const variantOf = (e: { payload: unknown }): string | null => ((e.payload as { variantId?: string } | null)?.variantId) ?? null;

/**
 * Central stock changed -> every live listing of that variant may now show the wrong quantity. Flag them (cheap, one
 * UPDATE) and ask for ONE coalesced inventory job per affected account; the job recomputes each channel's own sellable
 * quantity (buffer / allocation / cap) and pushes only what changed.
 */
const onStockChanged = (event: string, name: string): EventConsumer => ({
  event,
  name,
  async handle(e, c) {
    const vendorId = e.vendorId;
    const variantId = variantOf(e);
    if (!vendorId || !variantId) return;
    const accounts = await withVendor(c.database.db, vendorId, (tx) => markDirty(tx, vendorId, { variantId }));
    for (const accountId of accounts) {
      const paused = await withVendor(c.database.db, vendorId, async (tx) => {
        const [p] = await tx.select({ mode: schema.channelInventoryPolicies.mode }).from(schema.channelInventoryPolicies).where(and(eq(schema.channelInventoryPolicies.vendorId, vendorId), eq(schema.channelInventoryPolicies.marketplaceAccountId, accountId)));
        return p?.mode === 'paused';
      });
      if (!paused) await requestInventorySync(c, vendorId, accountId, 'event');
    }
  },
});

export const listingConsumers: EventConsumer[] = [
  onStockChanged('inventory.adjusted', 'listings.inventory-adjusted'),
  onStockChanged('inventory.reserved', 'listings.inventory-reserved'),
  onStockChanged('inventory.released', 'listings.inventory-released'),
  {
    event: 'variant.price_changed',
    name: 'listings.variant-price-changed',
    async handle(e, c) {
      const vendorId = e.vendorId;
      if (!vendorId) return;
      const variantId = e.aggregateId;
      // only listings that FOLLOW the variant price (no price override) are affected
      const rows = await withVendor(c.database.db, vendorId, (tx) =>
        tx.select({ id: L.id, accountId: L.marketplaceAccountId }).from(L).where(and(eq(L.vendorId, vendorId), eq(L.variantId, variantId), eq(L.status, 'active'), isNull(L.priceMinor))),
      );
      const byAccount = new Map<string, string[]>();
      for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r.id]);
      for (const [accountId, ids] of byAccount) await requestPriceSync(c, vendorId, accountId, ids);
    },
  },
  {
    event: 'marketplace_account.disconnected',
    name: 'listings.account-disconnected',
    async handle(e, c) {
      const vendorId = e.vendorId;
      if (!vendorId) return;
      // a disconnected account cannot be pushed to: drop pending quantity work (a reconnect marks everything dirty again)
      await withVendor(c.database.db, vendorId, (tx) => tx.update(L).set({ quantityDirty: false }).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, e.aggregateId), inArray(L.status, ['active', 'pending']))));
    },
  },
  {
    event: 'marketplace_account.connected',
    name: 'listings.account-connected',
    async handle(e, c) {
      const vendorId = e.vendorId;
      if (!vendorId) return;
      // (re)connected: every live listing may be out of date after the gap
      const accounts = await withVendor(c.database.db, vendorId, (tx) => markDirty(tx, vendorId, { accountId: e.aggregateId }));
      for (const accountId of accounts) await requestInventorySync(c, vendorId, accountId, 'event');
    },
  },
];

export { sql };
