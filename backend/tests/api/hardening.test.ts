import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, PROD_SAFE_ENV, type TestApp } from '@oms/testing';
import { safeEqual } from '@oms/auth';
import { verifyWebhook as amazonVerify } from '../../integrations/marketplace/amazon-in/src/webhooks';
import { verifyWebhook as flipkartVerify } from '../../integrations/marketplace/flipkart/src/webhooks';
import { scrubError } from '../../apps/api/src/plugins/errors';
import { buildWorld, orderArrives, pickAndPack, ship } from '../helpers/stage4';

/**
 * Security hardening + the defects found in the stage-4 review. Each test pins one fix so it cannot regress.
 */
let t: TestApp;
let c: ReturnType<typeof clientFor>;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
});
afterAll(() => t.close());

describe('crypto and logging helpers', () => {
  it('safeEqual never throws, whatever the encodings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('é'.repeat(64), 'a'.repeat(64))).toBe(false); // equal length, different byte length
    expect(safeEqual('', '')).toBe(true);
  });
  it('webhook verification returns false (not a 500) for hostile signature headers', () => {
    const raw = Buffer.from('{"x":1}');
    for (const verify of [amazonVerify, flipkartVerify]) {
      const header = verify === amazonVerify ? 'x-oms-signature' : 'x-flipkart-signature';
      for (const bad of ['é'.repeat(64), 'zz', '', 'a'.repeat(5000)]) {
        expect(() => verify({ headers: { [header]: bad }, rawBody: raw, secret: 's3cret' })).not.toThrow();
        expect(verify({ headers: { [header]: bad }, rawBody: raw, secret: 's3cret' })).toBe(false);
      }
    }
  });
  it('database errors are logged without their bound values', () => {
    const e = Object.assign(new Error('Failed query: update "users" set "password_hash" = $1\nparams: $argon2id$v=19$SECRET'), { query: 'update "users" set "password_hash" = $1', params: ['$argon2id$SECRET'], cause: { code: '40P01', detail: 'Key (email)=(a@b.c)' } });
    const s = JSON.stringify(scrubError(e));
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain('a@b.c');
    expect(s).toContain('40P01');
  });
});

describe('production configuration', () => {
  it('the sandbox courier and its simulator are unavailable unless the deployment opts in', async () => {
    const prod = await buildTestApp({ database: true, config: { ...PROD_SAFE_ENV, MOCK_MARKETPLACE_ENABLED: 'false', SWAGGER_ENABLED: 'false' } });
    const cc = clientFor(prod);
    const admin = await cc.registerVendor();
    expect((await cc.get('/api/v1/shipping/providers/catalog', admin)).body.data.map((p: any) => p.code)).toEqual(['manual']);
    const r = await cc.post('/api/v1/shipping/providers', { providerCode: 'sandbox' }, admin);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('not available');
    expect((await cc.post('/api/v1/shipping/providers', { providerCode: 'manual' }, admin)).status).toBe(201);
    await prod.close();
  });
  it('/health/ready does not publish the dependency topology in production', async () => {
    const prod = await buildTestApp({ database: true, config: { ...PROD_SAFE_ENV, SWAGGER_ENABLED: 'false' } });
    const res = await prod.app.inject('/health/ready');
    expect(res.json().checks ?? {}).toEqual({});
    await prod.close();
  });
});

describe('access control', () => {
  it('a platform user acting inside a vendor is READ-ONLY, even a platform admin', async () => {
    const admin = await c.registerVendor();
    const platform = await c.platformAdmin('platform_admin');
    const as = { 'x-act-as-vendor': admin.vendorId! };
    expect((await c.call('GET', '/api/v1/products', { as: platform, headers: as })).status).toBe(200);
    const w = await c.call('POST', '/api/v1/warehouses', { as: platform, headers: as, body: { code: 'EVIL', name: 'Evil' } });
    expect(w.status).toBe(403);
    expect(w.body.error.details.rule).toBe('impersonation_read_only');
    expect((await c.call('PATCH', '/api/v1/vendor', { as: platform, headers: as, body: { displayName: 'Hijacked' } })).status).toBe(403);
  });

  it('demoting a user ends their sessions immediately (no 15-minute window with the old role)', async () => {
    const admin = await c.registerVendor();
    const second = await c.addMember(admin, 'vendor_admin');
    expect((await c.get('/api/v1/users', second)).status).toBe(200);
    const demote = await c.patch(`/api/v1/users/${second.userId}`, { roleKey: 'vendor_viewer' }, admin);
    expect(demote.status, JSON.stringify(demote.body)).toBe(200);
    const after = await c.get('/api/v1/users', second); // the OLD token must no longer work
    expect(after.status).toBe(401);
    const relogin = await c.login(second.email, second.password);
    expect((await c.get('/api/v1/users', relogin)).status).toBe(403); // and the new role is a viewer
  });

  it('staff run operations but cannot change who may act in a warehouse, configure carriers or record refunds', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [5] });
    const staff = await c.addMember(w.admin, 'vendor_staff');
    expect((await c.post(`/api/v1/warehouses/${w.warehouses[0]!.id}/members`, { userId: staff.userId, role: 'manager' }, staff)).status).toBe(403);
    expect((await c.post('/api/v1/shipping/providers', { providerCode: 'manual' }, staff)).status).toBe(403);
    expect((await c.get('/api/v1/warehouse-access/me', staff)).status).toBe(200);
    const order = await orderArrives(t, c, w, 1);
    expect((await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, staff)).status).toBe(201); // day-to-day work is allowed
    const f = (await c.get(`/api/v1/orders/${order.id}/fulfillment`, staff)).body.data[0];
    await pickAndPack(t, c, w, f.id);
    await ship(t, c, w, f.id);
    const ret = (await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'other', items: [{ orderItemId: order.items[0].id, quantity: 1 }] }, staff)).body.data;
    expect((await c.post(`/api/v1/returns/${ret.id}/refund`, { status: 'processed' }, staff)).status).toBe(403);
    expect((await c.post(`/api/v1/returns/${ret.id}/refund`, { status: 'processed' }, w.admin)).status).toBe(409); // not approved yet
    await c.post(`/api/v1/returns/${ret.id}/approve`, {}, w.admin);
    expect((await c.post(`/api/v1/returns/${ret.id}/refund`, { status: 'processed', amountMinor: 999_999_999 }, w.admin)).status).toBe(400); // more than was paid
    expect((await c.post(`/api/v1/returns/${ret.id}/refund`, { status: 'processed' }, w.admin)).status).toBe(200);
    // a refund can never exceed what the customer paid
    const ret2 = (await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'other', items: [] as never }, w.admin)).status;
    expect(ret2).toBe(400);
  });

  it('a warehouse-restricted user cannot act on another warehouse\'s shipment (cancel, tracking, NDR, simulate)', async () => {
    const w = await buildWorld(t, c, { warehouses: 2, stock: [5, 5] });
    const [a, b] = w.warehouses as unknown as [{ id: string }, { id: string }];
    const picker = await c.addMember(w.admin, 'vendor_staff');
    await c.post(`/api/v1/warehouses/${a.id}/members`, { userId: picker.userId, role: 'dispatcher' }, w.admin);
    const order = await orderArrives(t, c, w, 1);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, { warehouseIds: [b.id] }, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    const s = (await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'sandbox' }, w.admin)).body.data;
    expect((await c.post(`/api/v1/shipments/${s.id}/cancel`, {}, picker)).status).toBe(403);
    expect((await c.post(`/api/v1/shipments/${s.id}/simulate`, { status: 'in_transit' }, picker)).status).toBe(403);
    expect((await c.post(`/api/v1/shipments/${s.id}/tracking-events`, { events: [{ eventId: 'E9', status: 'delivered', occurredAt: new Date().toISOString() }] }, picker)).status).toBe(403);
    expect((await c.post(`/api/v1/fulfillments/${f.id}/resume`, {}, picker)).status).toBe(403);
  });
});

describe('shipping inputs are constrained', () => {
  it('manual tracking cannot dispatch, use reserved ids, come from the future, or carry javascript: links', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [5] });
    const order = await orderArrives(t, c, w, 1);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    const s = (await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'sandbox' }, w.admin)).body.data;
    const ev = (e: Record<string, unknown>) => c.post(`/api/v1/shipments/${s.id}/tracking-events`, { events: [{ eventId: 'X1', status: 'in_transit', occurredAt: new Date().toISOString(), ...e }] }, w.admin);
    expect((await ev({ status: 'dispatched' })).status).toBe(400);
    expect((await ev({ eventId: 'dispatched' })).status).toBe(400);
    expect((await ev({ eventId: 'sim-9' })).status).toBe(400);
    expect((await ev({ occurredAt: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);
    // a courier saying "delivered" while the parcel never left the warehouse changes nothing
    const r = await ev({ eventId: 'E1', status: 'delivered' });
    expect(r.body.data).toMatchObject({ applied: 0 });
    expect((await c.get(`/api/v1/fulfillments/${f.id}`, w.admin)).body.data.status).toBe('ready_to_ship');
    // links are https only
    const bad = await c.post('/api/v1/shipments', { fulfillmentId: f.id, providerCode: 'manual', manual: { awb: 'A1', trackingUrl: 'javascript:alert(1)' } }, w.admin);
    expect(bad.status).toBe(400);
    expect((await c.post('/api/v1/shipping/providers', { providerCode: 'manual', config: { trackingUrlTemplate: 'http://x.example/{awb}' } }, w.admin)).status).toBe(400);
    expect((await c.post('/api/v1/shipping/providers', { providerCode: 'manual', config: { trackingUrlTemplate: 'https://x.example/{awb}', apiKey: 'SUPER-SECRET' } }, w.admin)).body.data.config).toEqual({ trackingUrlTemplate: 'https://x.example/{awb}' }); // undeclared settings never come back
    // dispatching a parcel for an order that was cancelled is refused
    await c.post(`/api/v1/orders/${order.id}/cancellation-requests`, { initiator: 'seller', reasonCode: 'out_of_stock' }, w.admin).then((r2) => c.post(`/api/v1/orders/${order.id}/cancellation-requests/${r2.body.data.id}/accept`, {}, w.admin));
    expect((await c.post(`/api/v1/shipments/${s.id}/dispatch`, {}, w.admin)).status).toBe(409);
  });
});

describe('state machines cannot be bypassed', () => {
  it('an order that is being fulfilled cannot be moved by hand past the warehouse work', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [5] });
    const order = await orderArrives(t, c, w, 1);
    // before fulfilment starts the manual path still works (small vendors without a warehouse flow)
    expect((await c.post(`/api/v1/orders/${order.id}/transition`, { status: 'confirmed' }, w.admin)).status).toBe(200);
    await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin);
    for (const status of ['picking', 'packed', 'dispatched']) {
      const r = await c.post(`/api/v1/orders/${order.id}/transition`, { status }, w.admin);
      expect(r.status, status).toBe(409);
      expect(r.body.error.details.rule).toBe('managed_by_fulfillment');
    }
    expect((await c.get(`/api/v1/orders/${order.id}`, w.admin)).body.data.inventoryStatus).toBe('reserved'); // stock untouched
  });

  it('an accepted cancellation leaves ONE completed record with the released units', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [5] });
    const order = await orderArrives(t, c, w, 2);
    const req = (await c.post(`/api/v1/orders/${order.id}/cancellation-requests`, { initiator: 'customer', reasonCode: 'customer_changed_mind' }, w.admin)).body.data;
    await c.post(`/api/v1/orders/${order.id}/cancellation-requests/${req.id}/accept`, {}, w.admin);
    const list = (await c.get(`/api/v1/orders/${order.id}/cancellations`, w.admin)).body.data as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'completed', releasedUnits: 2, initiator: 'customer', reasonCode: 'customer_changed_mind' });
    expect((await c.get('/api/v1/reports/orders', w.admin)).body.data.cancellationReasons).toEqual([{ reasonCode: 'customer_changed_mind', initiator: 'customer', count: 1 }]);
  });
});

describe('inventory invariants', () => {
  it('a short pick shrinks the bin with the stock (sum of bins never exceeds on hand)', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const wh = w.warehouses[0]!.id;
    const bin = (await c.post(`/api/v1/warehouses/${wh}/bins`, { code: 'S-01', barcode: 'BIN-S01' }, w.admin)).body.data;
    await c.post('/api/v1/bin-stock/put-away', { warehouseId: wh, variantId: w.variant.variantId, binId: bin.id, quantity: 10 }, w.admin);
    const order = await orderArrives(t, c, w, 5);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    const task = (await c.post('/api/v1/pick-lists', { fulfillmentIds: [f.id] }, w.admin)).body.data.tasks[0];
    await c.post(`/api/v1/pick-tasks/${task.id}/scan`, { itemBarcode: task.sku }, w.admin);
    await c.post(`/api/v1/pick-tasks/${task.id}/pick`, { quantity: 3 }, w.admin);
    await c.post(`/api/v1/pick-tasks/${task.id}/short`, { reason: 'damaged shelf' }, w.admin);
    const stock = (await c.get(`/api/v1/inventory/variants/${w.variant.variantId}`, w.admin)).body.data.totals;
    const binned = (await c.get('/api/v1/bin-stock', w.admin)).body.data.reduce((n: number, b: any) => n + b.quantity, 0);
    expect(stock.onHand).toBe(8); // 10 - 2 that were never there
    expect(binned).toBeLessThanOrEqual(stock.onHand);
    expect(binned).toBe(5); // 10 - 3 picked - 2 missing
  });

  it('a move between bins respects the destination capacity', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const wh = w.warehouses[0]!.id;
    const a = (await c.post(`/api/v1/warehouses/${wh}/bins`, { code: 'A', capacity: 20 }, w.admin)).body.data;
    const b = (await c.post(`/api/v1/warehouses/${wh}/bins`, { code: 'B', capacity: 4 }, w.admin)).body.data;
    await c.post('/api/v1/bin-stock/put-away', { warehouseId: wh, variantId: w.variant.variantId, binId: a.id, quantity: 10 }, w.admin);
    const over = await c.post('/api/v1/bin-stock/put-away', { warehouseId: wh, variantId: w.variant.variantId, binId: b.id, fromBinId: a.id, quantity: 5 }, w.admin);
    expect(over.status).toBe(409);
    expect((await c.post('/api/v1/bin-stock/put-away', { warehouseId: wh, variantId: w.variant.variantId, binId: b.id, fromBinId: a.id, quantity: 4 }, w.admin)).status).toBe(200);
  });

  it('receiving the same return line twice in one request cannot create phantom units', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 3);
    const f = (await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin)).body.data.fulfillments[0];
    await pickAndPack(t, c, w, f.id);
    await ship(t, c, w, f.id);
    const ret = (await c.post('/api/v1/returns', { orderId: order.id, reasonCode: 'other', items: [{ orderItemId: order.items[0].id, quantity: 3 }] }, w.admin)).body.data;
    await c.post(`/api/v1/returns/${ret.id}/approve`, { warehouseId: w.warehouses[0]!.id }, w.admin);
    const line = { returnItemId: ret.items[0].id, quantity: 3 };
    const dup = await c.post(`/api/v1/returns/${ret.id}/receive`, { warehouseId: w.warehouses[0]!.id, items: [line, line] }, w.admin);
    expect(dup.status).toBe(400);
    expect((await c.get(`/api/v1/inventory/variants/${w.variant.variantId}`, w.admin)).body.data.totals.returned).toBe(0); // the whole request rolled back
    expect((await c.post(`/api/v1/returns/${ret.id}/receive`, { warehouseId: w.warehouses[0]!.id, items: [line] }, w.admin)).status).toBe(200);
    expect((await c.get('/api/v1/inventory/ledger-check', w.admin)).body.data.healthy).toBe(true);
  });

  it('an item with reserved stock or a live listing cannot be deleted', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const del = await c.del(`/api/v1/variants/${w.variant.variantId}`, w.admin);
    expect(del.status, JSON.stringify(del.body)).toBe(409);
    expect(['has_reservations', 'has_live_listing']).toContain(del.body.error.details.rule);
  });
});

describe('idempotency for every state-changing endpoint', () => {
  it('a retried POST with the same Idempotency-Key does not repeat its effect', async () => {
    const w = await buildWorld(t, c, { warehouses: 1, stock: [10] });
    const order = await orderArrives(t, c, w, 1);
    const key = 'retry-key-0123456789';
    const first = await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin, { 'idempotency-key': key });
    const second = await c.post(`/api/v1/orders/${order.id}/fulfillment`, {}, w.admin, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body.data.fulfillments[0].id).toBe(first.body.data.fulfillments[0].id);
    expect((await c.get(`/api/v1/orders/${order.id}/fulfillment`, w.admin)).body.data).toHaveLength(1);
  });
});
