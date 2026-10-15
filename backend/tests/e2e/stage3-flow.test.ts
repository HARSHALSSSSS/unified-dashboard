import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amazonControl, buildTestApp, clientFor, flipkartControl, mockControl, myntraControl, snapdealControl, type Actor, type TestApp } from '@oms/testing';

/**
 * FINAL END-TO-END (Stage 3), once per marketplace, through the public HTTP API with the real workers' job handlers:
 *
 *   Vendor -> Connect Marketplace -> Import Product -> Create Master Product -> Create Listing -> Publish/Test Listing
 *   -> Order Arrives -> Inventory Reserves -> Inventory Sync Job -> Marketplace Update -> Order Appears in Central Dashboard
 *
 * Every marketplace here runs against its sandbox/simulator (the mock, and the Amazon IN / Flipkart / Myntra / Snapdeal
 * simulators); none of it touches a real marketplace.
 */
interface Market {
  code: 'mock' | 'amazon_in' | 'flipkart' | 'myntra' | 'snapdeal';
  categoryId: string;
  newOrderStatus: string; // our normalised status when the customer's order first appears
  nativeNewStatus: string;
  place: (seller: string, sku: string, qty: number) => { id: string };
  quantity: (seller: string, sku: string) => number | undefined;
  /** make the marketplace's displayed stock disagree with ours, so only a real push can fix it */
  setQuantity: (seller: string, sku: string, qty: number) => void;
  nativeStatus: (seller: string, orderId: string) => string | undefined;
  /** what the marketplace shows after we confirm / dispatch (undefined = this marketplace cannot be told) */
  afterConfirm?: string;
  afterDispatch: string;
  reset: () => void;
}

const sim = (control: typeof amazonControl) => ({
  place: (seller: string, sku: string, qty: number) => { const o = control.placeOrder(seller, [{ sku, quantity: qty }]); return { id: o.id }; },
  quantity: (seller: string, sku: string) => control.listing(seller, sku)?.quantity,
  setQuantity: (seller: string, sku: string, qty: number) => { control.listing(seller, sku)!.quantity = qty; },
  nativeStatus: (seller: string, id: string) => control.order(seller, id)?.status,
  reset: () => control.reset(),
});

const MARKETS: Market[] = [
  {
    code: 'mock', categoryId: 'mock-apparel', newOrderStatus: 'new', nativeNewStatus: 'new', afterConfirm: 'accepted', afterDispatch: 'shipped',
    place: (s, sku, q) => { const o = mockControl.placeOrder(s, [{ sku, quantity: q }]); return { id: o.externalOrderId }; },
    quantity: (s, sku) => mockControl.quantity(s, sku), setQuantity: (s, sku, q) => { mockControl.state.seller(s).products.get(sku)!.quantity = q; }, nativeStatus: (s, id) => mockControl.order(s, id)?.marketplaceStatus,
    reset: () => { mockControl.reset(); mockControl.configure({ seedOrders: false }); },
  },
  { code: 'amazon_in', categoryId: 'SHIRT', newOrderStatus: 'confirmed', nativeNewStatus: 'Unshipped', afterDispatch: 'Shipped', ...sim(amazonControl) },
  { code: 'flipkart', categoryId: 'mens_tshirts', newOrderStatus: 'confirmed', nativeNewStatus: 'APPROVED', afterDispatch: 'SHIPPED', ...sim(flipkartControl as never) },
  { code: 'myntra', categoryId: 'tshirts', newOrderStatus: 'new', nativeNewStatus: 'CREATED', afterConfirm: 'ACKNOWLEDGED', afterDispatch: 'SHIPPED', ...sim(myntraControl as never) },
  { code: 'snapdeal', categoryId: 'mens-apparel', newOrderStatus: 'new', nativeNewStatus: 'NEW', afterConfirm: 'CONFIRMED', afterDispatch: 'HANDED_OVER', ...sim(snapdealControl as never) },
];

let t: TestApp;
let c: ReturnType<typeof clientFor>;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
});
afterAll(() => t.close());

describe.each(MARKETS)('Stage 3 end-to-end: $code', (m) => {
  let admin: Actor;

  it('vendor -> connect -> import -> master product -> listing -> publish -> order -> reserve -> inventory sync -> marketplace update -> dashboard', async () => {
    m.reset();
    admin = await c.registerVendor({ businessName: `E2E ${m.code}` });
    const wh = await c.makeWarehouse(admin, { code: 'MAIN' });

    // 1. connect the marketplace (sandbox)
    const acct = await c.connectAccount(admin, m.code);
    expect(acct).toMatchObject({ marketplace: m.code, status: 'active' });
    const health = await c.post(`/api/v1/marketplace-accounts/${acct.id}/health-check`, {}, admin);
    expect(health.body.data).toMatchObject({ ok: true, connectionStatus: 'connected' });

    // 2. import the products that already exist on the marketplace (normalised, paged, resumable)
    const imp = await c.post(`/api/v1/marketplace-accounts/${acct.id}/import-products`, {}, admin);
    expect(imp.status).toBe(202);
    await t.pump();
    expect((await c.get(`/api/v1/sync/jobs/${imp.body.data.job.id}`, admin)).body.data).toMatchObject({ status: 'succeeded', type: 'catalog_import' });
    const imported = (await c.get(`/api/v1/imported-products?filter[accountId]=${acct.id}&limit=100`, admin)).body.data as any[];
    expect(imported.length).toBeGreaterThanOrEqual(8);
    expect(imported[0]).toMatchObject({ status: 'new', currency: 'INR', externalSku: expect.any(String), title: expect.any(String) });

    // 3. create a MASTER product from one of them (opening stock goes through the ledger)
    const pick = imported[0]!;
    const master = await c.post(`/api/v1/imported-products/${pick.id}/create-product`, { initialQuantity: 12, warehouseId: wh.id }, admin);
    expect(master.status, JSON.stringify(master.body)).toBe(201);
    expect(master.body.data).toMatchObject({ openingStock: 12, listingId: expect.any(String), variantId: expect.any(String) });
    const adopted = (await c.get(`/api/v1/listings/${master.body.data.listingId}`, admin)).body.data;
    expect(adopted).toMatchObject({ source: 'imported', externalSku: pick.externalSku, marketplace: m.code });
    expect((await c.get(`/api/v1/imported-products?filter[status]=linked&filter[accountId]=${acct.id}`, admin)).body.data).toHaveLength(1);
    await t.pump(); // the stock event may push a quantity to the adopted listing: it must succeed too

    // 4. create a listing for a NEW master product, validate, preview, approve, publish
    const v = await c.makeVariant(admin, { title: `Cotton tee for ${m.code}` });
    await c.stock(admin, v.variantId, wh.id, 30);
    const l = (await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId: v.variantId, marketplaceCategoryId: m.categoryId }, admin)).body.data;
    const val = await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin);
    expect(val.body.data.validation, JSON.stringify(val.body.data.validation)).toMatchObject({ ready: true });
    const prev = await c.get(`/api/v1/listings/${l.id}/preview`, admin);
    expect(prev.body.data.payload).toBeTruthy();
    expect(prev.body.data.endpoint).toEqual(expect.any(String));
    expect((await c.post(`/api/v1/listings/${l.id}/approve`, {}, admin)).body.data.status).toBe('approved');
    const pub = await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    expect(pub.status).toBe(202);
    await t.pump();
    expect((await c.get(`/api/v1/sync/jobs/${pub.body.data.job.id}`, admin)).body.data.status).toBe('succeeded');
    const live = (await c.get(`/api/v1/listings/${l.id}`, admin)).body.data;
    expect(live, JSON.stringify(live.issues)).toMatchObject({ status: 'active', externalListingId: expect.any(String) });
    // the first push put our available stock on the marketplace
    expect(m.quantity(acct.sellerId, v.sku)).toBe(30);

    m.setQuantity(acct.sellerId, v.sku, 999); // the marketplace is out of sync with us
    // 5. an order arrives on the marketplace; we import it (poll) and it reserves stock
    const placed = m.place(acct.sellerId, v.sku, 4);
    const sync = await c.post(`/api/v1/marketplace-accounts/${acct.id}/sync-orders`, {}, admin);
    expect(sync.status).toBe(202);
    await t.pump();
    const [order] = (await c.get('/api/v1/orders?filter[accountId]=' + acct.id, admin)).body.data as any[];
    expect(order).toMatchObject({
      marketplace: m.code, externalOrderId: placed.id, status: m.newOrderStatus, marketplaceStatus: m.nativeNewStatus, inventoryStatus: 'reserved', currency: 'INR', attentionReason: null,
      items: [expect.objectContaining({ sku: v.sku, quantity: 4, reservedQuantity: 4, variantId: v.variantId })],
    });

    // 6. inventory reserved (available fell) -> inventory sync job ran -> the marketplace was updated
    const stock = (await c.get(`/api/v1/inventory/variants/${v.variantId}`, admin)).body.data.totals;
    expect(stock).toMatchObject({ onHand: 30, reserved: 4, available: 26 });
    const invJobs = (await c.get('/api/v1/sync/jobs?filter[type]=inventory&limit=20', admin)).body.data as any[];
    expect(invJobs.length).toBeGreaterThan(0);
    expect(invJobs.every((j) => j.status === 'succeeded')).toBe(true);
    expect(m.quantity(acct.sellerId, v.sku)).toBe(26);
    const pushes = (await c.get(`/api/v1/listings/${l.id}/stock-updates`, admin)).body.data as any[];
    expect(pushes[0]).toMatchObject({ availableQuantity: 26, requestedQuantity: 26, status: 'succeeded' });

    // 7. the order is in the central dashboard
    const dash = (await c.get('/api/v1/orders/summary', admin)).body.data;
    expect(dash.byMarketplace[m.code]).toMatchObject({ orders: 1, revenueMinor: order.totalMinor });
    expect(dash.byStatus[m.newOrderStatus]).toBe(1);
    expect(dash.needsAttention).toBe(0);
    const tl = (await c.get(`/api/v1/orders/${order.id}/timeline`, admin)).body.data;
    expect(tl[0]).toMatchObject({ toStatus: m.newOrderStatus, source: 'marketplace' });

    // 8. fulfilment: our status changes reach the marketplace where it accepts them; dispatch consumes the stock
    const step = async (status: string, body: Record<string, unknown> = {}) => {
      const r = await c.post(`/api/v1/orders/${order.id}/transition`, { status, ...body }, admin);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await t.pump();
      return r.body.data;
    };
    if (order.status === 'new') {
      const confirmed = await step('confirmed');
      const upd = (await c.get(`/api/v1/orders/${order.id}/status-updates`, admin)).body.data.find((u: any) => u.requestedStatus === 'confirmed');
      expect(upd.status, JSON.stringify(confirmed.statusUpdate)).toBe(m.afterConfirm ? 'successful' : 'skipped');
      if (m.afterConfirm) expect(m.nativeStatus(acct.sellerId, placed.id)).toBe(m.afterConfirm);
    }
    for (const s of ['picking', 'packed', 'ready_to_dispatch']) await step(s);
    const out = await step('dispatched', { tracking: { number: 'AWB-E2E-1', carrier: 'FastShip' } });
    expect(out.order).toMatchObject({ status: 'dispatched', inventoryStatus: 'committed', tracking: { number: 'AWB-E2E-1' } });
    expect(out.statusUpdate.requestedStatus).toBe('dispatched');
    expect(m.nativeStatus(acct.sellerId, placed.id)).toBe(m.afterDispatch);
    expect((await c.get(`/api/v1/orders/${order.id}/status-updates`, admin)).body.data.find((u: any) => u.requestedStatus === 'dispatched').status).toBe('successful');
    expect((await c.get(`/api/v1/inventory/variants/${v.variantId}`, admin)).body.data.totals).toMatchObject({ onHand: 26, reserved: 0, available: 26 });
    expect(m.quantity(acct.sellerId, v.sku)).toBe(26); // shipping did not change what may be sold

    // 9. nothing was ever sold without a movement, nothing was duplicated, nothing failed
    expect((await c.get('/api/v1/inventory/ledger-check', admin)).body.data).toEqual({ healthy: true, drift: [] });
    expect((await c.get('/api/v1/sync/summary', admin)).body.data.needsAttention).toBe(0);
    expect((await c.get('/api/v1/orders', admin)).body.data).toHaveLength(1);
  });

  it('is isolated from other vendors on the same marketplace', async () => {
    const rival = await c.registerVendor({ businessName: `Rival ${m.code}` });
    expect((await c.get('/api/v1/orders', rival)).body.data).toEqual([]);
    expect((await c.get('/api/v1/listings', rival)).body.data).toEqual([]);
    expect((await c.get('/api/v1/sync/jobs', rival)).body.data).toEqual([]);
    expect((await c.get('/api/v1/imported-products', rival)).body.data).toEqual([]);
    expect((await c.get('/api/v1/inventory', rival)).body.data).toEqual([]);
  });
});
