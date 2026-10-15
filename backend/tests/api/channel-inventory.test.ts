import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, mockControl, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let wh: { id: string };

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
});
beforeEach(async () => {
  mockControl.reset();
  mockControl.configure({ seedOrders: false });
  admin = await c.registerVendor({ businessName: 'Channel Co' });
  wh = await c.makeWarehouse(admin);
});
afterAll(() => t.close());

/** create + validate + approve + publish + settle: a listing that is LIVE on the (mock) marketplace */
const goLive = async (acct: { id: string }, variantId: string) => {
  const l = (await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId, marketplaceCategoryId: 'mock-apparel' }, admin)).body.data;
  expect((await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin)).body.data.validation.ready).toBe(true);
  expect((await c.post(`/api/v1/listings/${l.id}/approve`, {}, admin)).status).toBe(200);
  expect((await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin)).status).toBe(202);
  await t.pump();
  const live = (await c.get(`/api/v1/listings/${l.id}`, admin)).body.data;
  expect(live.status).toBe('active');
  return live;
};
const qty = (acct: { sellerId: string }, sku: string) => mockControl.quantity(acct.sellerId, sku);
const policy = (acct: { id: string }, body: Record<string, unknown>) => c.put(`/api/v1/marketplace-accounts/${acct.id}/inventory-policy`, body, admin);
const stockUpdates = async (listingId: string) => (await c.get(`/api/v1/listings/${listingId}/stock-updates`, admin)).body.data as any[];
const inventoryJobs = async () => (await c.get('/api/v1/sync/jobs?filter[type]=inventory&limit=50', admin)).body.data as any[];

describe('central stock -> reserve -> available -> channel sellable quantity -> marketplace update', () => {
  it('pushes the available quantity when a listing goes live and whenever stock changes', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 20);
    const l = await goLive(acct, v.variantId);
    expect(qty(acct, v.sku)).toBe(20);
    expect(l.quantity).toMatchObject({ sellable: 20, pushed: 20, dirty: false });

    await c.stock(admin, v.variantId, wh.id, 5);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(25);
    await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, delta: -7, reason: 'shrinkage' }, admin);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(18);

    // every push is recorded: what central stock had vs what the marketplace was asked to show
    const ups = await stockUpdates(l.id);
    expect(ups.map((u) => u.requestedQuantity)).toEqual([18, 25, 20]); // newest first
    expect(ups.every((u) => u.status === 'succeeded' && u.syncJobId)).toBe(true);
    expect(ups[0]).toMatchObject({ availableQuantity: 18, requestedQuantity: 18 });
    expect((await c.get('/api/v1/inventory/ledger-check', admin)).body.data.healthy).toBe(true);
  });

  it('a reservation by an order lowers what the marketplace may sell, before the order ships', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const other = await c.connectAccount(admin, 'mock'); // the SAME variant sold on a second marketplace account
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await goLive(acct, v.variantId);
    await goLive(other, v.variantId);
    expect([qty(acct, v.sku), qty(other, v.sku)]).toEqual([10, 10]);

    // an order arrives on the first account: 4 units are promised, so BOTH channels must show 6
    const s = mockControl.state.seller(acct.sellerId);
    expect(s.products.get(v.sku)).toBeTruthy();
    mockControl.placeOrder(acct.sellerId, [{ sku: v.sku, quantity: 4 }]);
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/sync-orders`, {}, admin);
    await t.pump();
    expect(await c.available(admin, v.variantId)).toBe(6);
    expect(qty(acct, v.sku)).toBe(6);
    expect(qty(other, v.sku)).toBe(6);

    // cancelling gives the units back to both
    const [o] = (await c.get('/api/v1/orders', admin)).body.data;
    await c.post(`/api/v1/orders/${o.id}/cancel`, { reason: 'changed mind' }, admin);
    await t.pump();
    expect([qty(acct, v.sku), qty(other, v.sku)]).toEqual([10, 10]);
  });

  it('shipping an order consumes the reservation without changing the sellable quantity (and without a pointless push)', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    const l = await goLive(acct, v.variantId);
    mockControl.placeOrder(acct.sellerId, [{ sku: v.sku, quantity: 3 }]);
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/sync-orders`, {}, admin);
    await t.pump();
    const pushesBefore = (await stockUpdates(l.id)).length;
    const [o] = (await c.get('/api/v1/orders', admin)).body.data;
    for (const s of ['confirmed', 'picking', 'packed', 'ready_to_dispatch', 'dispatched']) await c.post(`/api/v1/orders/${o.id}/transition`, { status: s }, admin);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(7);
    expect((await stockUpdates(l.id)).length).toBe(pushesBefore); // on_hand and reserved fell together: available did not move
  });
});

describe('every marketplace gets its OWN number (buffer, allocation, caps)', () => {
  it('different policies yield different quantities from the same stock', async () => {
    const cautious = await c.connectAccount(admin, 'mock', { displayName: 'Cautious channel' });
    const open = await c.connectAccount(admin, 'mock', { displayName: 'Open channel' });
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 20);
    await goLive(cautious, v.variantId);
    await goLive(open, v.variantId);

    const p = await policy(cautious, { safetyBuffer: 3, allocationPercent: 50 });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ mode: 'sync', safetyBuffer: 3, allocationPercent: 50, isDefault: false });
    await t.pump(); // the policy change re-pushes the account
    expect(qty(cautious, v.sku)).toBe(7); // floor(20 * 50%) - 3
    expect(qty(open, v.sku)).toBe(20);

    await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, delta: -4, reason: 'sold offline' }, admin);
    await t.pump();
    expect(qty(cautious, v.sku)).toBe(5); // floor(16 * 50%) - 3
    expect(qty(open, v.sku)).toBe(16);
  });

  it('never exposes more than is available, and a buffer larger than the stock means zero', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 4);
    await goLive(acct, v.variantId);
    await policy(acct, { safetyBuffer: 10 });
    await t.pump();
    expect(qty(acct, v.sku)).toBe(0);
    await policy(acct, { safetyBuffer: 0, maxQuantity: 3 }); // hard cap per listing
    await t.pump();
    expect(qty(acct, v.sku)).toBe(3);
  });

  it('a listing can override the channel buffer and cap', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    const l = await goLive(acct, v.variantId);
    expect((await c.patch(`/api/v1/listings/${l.id}`, { bufferOverride: 4 }, admin)).status).toBe(200);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(6);
    expect((await c.patch(`/api/v1/listings/${l.id}`, { maxQuantityOverride: 2 }, admin)).status).toBe(200);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(2);
  });

  it('only the warehouses feeding a channel count, and a change elsewhere pushes nothing', async () => {
    const wh2 = await c.makeWarehouse(admin);
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await c.stock(admin, v.variantId, wh2.id, 30);
    await goLive(acct, v.variantId);
    expect(qty(acct, v.sku)).toBe(40);
    await policy(acct, { warehouseIds: [wh.id] });
    await t.pump();
    expect(qty(acct, v.sku)).toBe(10);

    const callsBefore = mockControl.calls(acct.sellerId);
    await c.stock(admin, v.variantId, wh2.id, 5); // not a feeding warehouse
    await t.pump();
    expect(qty(acct, v.sku)).toBe(10);
    expect(mockControl.calls(acct.sellerId)).toBe(callsBefore); // sellable did not change: the marketplace was not even called
    const job = (await inventoryJobs())[0];
    expect(job).toMatchObject({ status: 'succeeded', stats: { pushed: 0, unchanged: 1 } });
  });

  it('paused channels are left alone and catch up when resumed', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await goLive(acct, v.variantId);
    await policy(acct, { mode: 'paused' });
    await t.pump();
    await c.stock(admin, v.variantId, wh.id, 5);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(10); // paused: nothing pushed
    await policy(acct, { mode: 'sync' });
    await t.pump();
    expect(qty(acct, v.sku)).toBe(15);
  });
});

describe('queueing: many triggers -> one job; failures retry; results are recorded', () => {
  it('coalesces a burst of stock changes into one inventory job per account', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await goLive(acct, v.variantId);
    const before = (await inventoryJobs()).length;
    for (let i = 0; i < 8; i++) await c.post('/api/v1/inventory/adjust', { variantId: v.variantId, warehouseId: wh.id, delta: 1, reason: `burst ${i}` }, admin);
    await t.relayEvents(); // events -> consumers -> ONE coalesced job
    expect(t.pendingJobs((j) => j.name === 'sync.inventory')).toHaveLength(1);
    await t.pump();
    expect((await inventoryJobs()).length).toBe(before + 1);
    expect(qty(acct, v.sku)).toBe(18);
  });

  it('a failing marketplace call is retried; the flag stays dirty until the push succeeds', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    const l = await goLive(acct, v.variantId);
    mockControl.setBehavior(acct.sellerId, { failNext: 50, failKind: 'transient' });
    await c.stock(admin, v.variantId, wh.id, 5);
    await t.relayEvents();
    await t.runJobs();
    let job = (await inventoryJobs())[0];
    expect(job).toMatchObject({ status: 'retrying', attempts: 1 });
    expect((await c.get(`/api/v1/listings/${l.id}`, admin)).body.data.quantity).toMatchObject({ pushed: 10, dirty: true });
    expect((await stockUpdates(l.id))[0]).toMatchObject({ status: 'failed', requestedQuantity: 15 });
    expect(qty(acct, v.sku)).toBe(10); // the marketplace still shows the old number

    mockControl.setBehavior(acct.sellerId, {});
    await t.pump();
    job = (await inventoryJobs())[0];
    expect(job).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(qty(acct, v.sku)).toBe(15);
    expect((await c.get(`/api/v1/listings/${l.id}`, admin)).body.data.quantity).toMatchObject({ pushed: 15, dirty: false });
  });

  it('rate limiting is absorbed: Retry-After is honoured and the push still lands', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await goLive(acct, v.variantId);
    mockControl.setBehavior(acct.sellerId, { rateLimitNext: 2, retryAfterMs: 1 });
    await c.stock(admin, v.variantId, wh.id, 1);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(11);
    expect((await inventoryJobs())[0]).toMatchObject({ status: 'succeeded' });
  });

  it('a SKU the marketplace refuses is recorded as an item failure without blocking the others', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const [a, b] = [await c.makeVariant(admin), await c.makeVariant(admin)];
    await c.stock(admin, a.variantId, wh.id, 5);
    await c.stock(admin, b.variantId, wh.id, 5);
    const la = await goLive(acct, a.variantId);
    await goLive(acct, b.variantId);
    mockControl.state.seller(acct.sellerId).products.delete(a.sku); // vanished on the marketplace side
    await c.stock(admin, a.variantId, wh.id, 1);
    await c.stock(admin, b.variantId, wh.id, 1);
    await t.pump();
    const job = (await inventoryJobs())[0];
    expect(job).toMatchObject({ status: 'partially_failed', failureDetails: [expect.objectContaining({ ref: a.sku, code: 'SKU_NOT_FOUND' })], progress: { failed: 1 } });
    expect(qty(acct, b.sku)).toBe(6);
    expect((await stockUpdates(la.id))[0]).toMatchObject({ status: 'failed', errorCode: 'SKU_NOT_FOUND' });
    expect((await c.get(`/api/v1/listings/${la.id}`, admin)).body.data.quantity.dirty).toBe(false); // not retried forever
  });

  it('manual full re-sync recomputes everything', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await goLive(acct, v.variantId);
    mockControl.state.seller(acct.sellerId).products.get(v.sku)!.quantity = 999; // somebody edited it on the marketplace
    // drift is only corrected by a push; an unchanged sellable number is skipped, so the operator forces a re-push via the policy
    const r = await c.post(`/api/v1/marketplace-accounts/${acct.id}/inventory-sync`, {}, admin);
    expect(r.status).toBe(202);
    expect(r.body.data.job).toMatchObject({ type: 'inventory', trigger: 'manual' });
    await t.pump();
    expect((await c.get(`/api/v1/sync/jobs/${r.body.data.job.id}`, admin)).body.data.status).toBe('succeeded');
  });

  it('disconnecting stops quantity work; reconnecting catches the channel up', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 10);
    await goLive(acct, v.variantId);
    await c.post(`/api/v1/marketplace-accounts/${acct.id}/disconnect`, {}, admin);
    await t.pump();
    await c.stock(admin, v.variantId, wh.id, 5);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(10);
    const re = await c.post(`/api/v1/marketplace-accounts/${acct.id}/reconnect`, { credentials: { sellerId: acct.sellerId, apiKey: 'sandbox_key' } }, admin);
    expect(re.status).toBe(200);
    await t.pump();
    expect(qty(acct, v.sku)).toBe(15);
  });
});

describe('price sync', () => {
  it('a variant price change reaches listings that follow the variant price, not ones with an override', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const other = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin, { priceMinor: 50000, mrpMinor: 60000 });
    await c.stock(admin, v.variantId, wh.id, 5);
    await goLive(acct, v.variantId);
    const pinned = await goLive(other, v.variantId);
    // pin the second listing's price (a live listing allows price edits)
    expect((await c.patch(`/api/v1/listings/${pinned.id}`, { priceMinor: 55000 }, admin)).status).toBe(200);
    await t.pump();
    expect(mockControl.state.seller(other.sellerId).products.get(v.sku)?.priceMinor).toBe(55000); // the override is pushed on edit

    const variants = (await c.get(`/api/v1/products/${v.productId}/variants`, admin)).body.data;
    expect((await c.patch(`/api/v1/variants/${variants[0].id}`, { sellingPriceMinor: 45000 }, admin)).status).toBe(200);
    await t.pump();
    expect(mockControl.state.seller(acct.sellerId).products.get(v.sku)?.priceMinor).toBe(45000);
    expect(mockControl.state.seller(other.sellerId).products.get(v.sku)?.priceMinor).toBe(55000);
  });
});
