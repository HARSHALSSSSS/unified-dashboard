import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, flipkartControl, mockControl, amazonControl, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let viewer: Actor;
let wh: { id: string };

beforeAll(async () => {
  t = await buildTestApp({ database: true, config: { WEBHOOK_MAX_ATTEMPTS: '3' } });
  c = clientFor(t);
});
beforeEach(async () => {
  mockControl.reset();
  mockControl.configure({ seedOrders: false });
  flipkartControl.reset();
  amazonControl.reset();
  admin = await c.registerVendor({ businessName: 'Hook Co' });
  viewer = await c.addMember(admin, 'vendor_viewer');
  wh = await c.makeWarehouse(admin);
});
afterAll(() => t.close());

const secretFor = async (acct: { id: string }, as = admin): Promise<string> => (await c.post(`/api/v1/marketplace-accounts/${acct.id}/webhook-secret`, {}, as)).body.data.secret;
const deliver = (acct: { id: string; marketplace?: string }, signed: { rawBody: string; headers: Record<string, string> }, marketplace = 'mock') =>
  c.call('POST', `/api/v1/webhooks/${marketplace}/${acct.id}`, { raw: signed.rawBody, headers: signed.headers, contentType: 'application/json' });
const events = async (q = '', as = admin) => (await c.get(`/api/v1/webhooks/events${q}`, as)).body.data as any[];
const orders = async () => (await c.get('/api/v1/orders', admin)).body.data as any[];
const pendingHooks = () => t.pendingJobs((j) => j.name === 'webhooks.process' && j.envelope.vendorId === admin.vendorId);

/** a mock marketplace with one order the marketplace knows about (we have NOT polled it) */
const setup = async () => {
  const acct = await c.connectAccount(admin, 'mock');
  const v = await c.makeVariant(admin);
  await c.stock(admin, v.variantId, wh.id, 10);
  mockControl.state.seller(acct.sellerId).products.set(v.sku, { externalListingId: 'MP-1', externalSku: v.sku, title: 'x', priceMinor: 20000, currency: 'INR', quantity: 5, status: 'active' } as never);
  const mo = mockControl.placeOrder(acct.sellerId, [{ sku: v.sku, quantity: 2 }]);
  const secret = await secretFor(acct);
  return { acct, v, mo, secret };
};

describe('secret + configuration', () => {
  it('generates a per-account secret, shown once; rotating invalidates the old one', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const cfg0 = (await c.get(`/api/v1/marketplace-accounts/${acct.id}/webhook-config`, admin)).body.data;
    expect(cfg0).toMatchObject({ configured: false, supported: true, secretRotatedAt: null, signature: { header: 'x-mock-signature' } });
    expect(cfg0.callbackUrl).toBe(`http://localhost:3000/api/v1/webhooks/mock/${acct.id}`);

    const r1 = await c.post(`/api/v1/marketplace-accounts/${acct.id}/webhook-secret`, {}, admin);
    expect(r1.body.data.secret).toMatch(/^whsec_/);
    expect(r1.body.data.configured).toBe(true);
    const cfg1 = (await c.get(`/api/v1/marketplace-accounts/${acct.id}/webhook-config`, admin)).body.data;
    expect(cfg1.configured).toBe(true);
    expect(JSON.stringify(cfg1)).not.toContain(r1.body.data.secret); // never readable again
    // encrypted at rest: the stored value is an AES-GCM envelope, not the secret
    const pg = t.database!.pg;
    await pg.exec('RESET ROLE');
    const { rows } = await pg.query<{ webhook_secret_ciphertext: string }>('select webhook_secret_ciphertext from marketplace_accounts where id = $1', [acct.id]);
    await pg.exec('SET ROLE oms_app');
    expect(rows[0]!.webhook_secret_ciphertext).not.toContain(r1.body.data.secret);
    expect(rows[0]!.webhook_secret_ciphertext.length).toBeGreaterThan(40);

    const old = r1.body.data.secret;
    const next = await secretFor(acct);
    expect(next).not.toBe(old);
    const body = mockControl.signedWebhook({ id: 'e1', type: 'order.updated', orderId: 'x' }, old);
    expect((await deliver(acct, body)).status).toBe(401);
    expect((await deliver(acct, mockControl.signedWebhook({ id: 'e2', type: 'order.updated', orderId: 'x' }, next))).status).toBe(200);
  });

  it('is only available to marketplaces that push notifications, and to vendors who own the account', async () => {
    const myntra = await c.connectAccount(admin, 'myntra');
    const r = await c.post(`/api/v1/marketplace-accounts/${myntra.id}/webhook-secret`, {}, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.details.rule).toBe('webhooks_unsupported');
    expect((await c.get(`/api/v1/marketplace-accounts/${myntra.id}/webhook-config`, admin)).body.data.supported).toBe(false);

    const acct = await c.connectAccount(admin, 'mock');
    const other = await c.registerVendor({ businessName: 'Nosy Co' });
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/webhook-secret`, {}, other)).status).toBe(404);
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/webhook-secret`, {}, viewer)).status).toBe(403);
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}/webhook-config`, viewer)).status).toBe(200);
  });
});

describe('verification and idempotency', () => {
  it('a correctly signed notification is stored, acknowledged and processed asynchronously: the order appears', async () => {
    const { acct, mo, secret } = await setup();
    const res = await deliver(acct, mockControl.signedWebhook({ id: 'evt-1', type: 'order.created', orderId: mo.externalOrderId }, secret));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ received: true, duplicate: false, ignored: false, eventId: expect.any(String) });
    // acknowledged BEFORE processing: stored, nothing imported yet
    expect((await events())[0]).toMatchObject({ status: 'received', eventType: 'order.created', attempts: 0, deliveries: 1 });
    expect(await orders()).toHaveLength(0);
    expect(pendingHooks()).toHaveLength(1);

    await t.pump();
    expect((await events())[0]).toMatchObject({ status: 'processed', attempts: 1, lastError: null });
    const o = await orders();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ externalOrderId: mo.externalOrderId, status: 'new', inventoryStatus: 'reserved' });
    expect((await t.outbox('webhook.received')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(1);
  });

  it('a duplicate delivery is acknowledged but changes nothing', async () => {
    const { acct, mo, secret } = await setup();
    const signed = mockControl.signedWebhook({ id: 'evt-dup', type: 'order.created', orderId: mo.externalOrderId }, secret);
    expect((await deliver(acct, signed)).body.data.duplicate).toBe(false);
    await t.pump();
    const again = await deliver(acct, signed);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    await deliver(acct, signed);
    await t.pump();
    const evs = await events();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ deliveries: 3, attempts: 1, status: 'processed' });
    expect(await orders()).toHaveLength(1);
    expect(await c.available(admin, (await orders())[0].items[0].variantId)).toBe(8); // reserved once
    expect(pendingHooks()).toHaveLength(0);
  });

  it('even a different event for an order we already have never duplicates it', async () => {
    const { acct, mo, secret } = await setup();
    await deliver(acct, mockControl.signedWebhook({ id: 'a', type: 'order.created', orderId: mo.externalOrderId }, secret));
    await deliver(acct, mockControl.signedWebhook({ id: 'b', type: 'order.updated', orderId: mo.externalOrderId }, secret));
    await t.pump();
    expect(await orders()).toHaveLength(1);
    expect((await events()).map((e) => e.status)).toEqual(['processed', 'processed']);
  });

  it('rejects bad signatures with 401 and stores no payload', async () => {
    const { acct, mo, secret } = await setup();
    const good = mockControl.signedWebhook({ id: 'evt-x', type: 'order.created', orderId: mo.externalOrderId }, secret);
    // wrong secret
    expect((await deliver(acct, mockControl.signedWebhook({ id: 'evt-x', type: 'order.created', orderId: mo.externalOrderId }, 'whsec_wrong'))).status).toBe(401);
    // tampered body, signature of the original
    expect((await deliver(acct, { rawBody: good.rawBody.replace('evt-x', 'evt-y'), headers: good.headers })).status).toBe(401);
    // missing signature
    expect((await deliver(acct, { rawBody: good.rawBody, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    // a secret that belongs to ANOTHER account does not work here
    const second = await c.connectAccount(admin, 'mock');
    const theirs = await secretFor(second);
    expect((await deliver(acct, mockControl.signedWebhook({ id: 'evt-x', type: 'order.created', orderId: mo.externalOrderId }, theirs))).status).toBe(401);

    const rejected = await events('?filter[status]=rejected');
    expect(rejected).toHaveLength(4);
    expect(rejected.every((e) => e.lastError === 'bad_signature')).toBe(true);
    const detail = (await c.get(`/api/v1/webhooks/events/${rejected[0].id}`, admin)).body.data;
    expect(detail.payload).toBeNull(); // unauthenticated bytes are never stored
    expect(await orders()).toHaveLength(0);
    expect(pendingHooks()).toHaveLength(0);
    expect((await t.outbox('webhook.rejected')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(4);
  });

  it('an account with no secret cannot receive anything', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const res = await deliver(acct, mockControl.signedWebhook({ id: 'e', type: 'order.created', orderId: 'x' }, 'whsec_anything'));
    expect(res.status).toBe(401);
    expect((await events('?filter[status]=rejected'))[0].lastError).toBe('no_secret_configured');
  });

  it('unknown endpoints and wrong marketplace codes answer exactly like a bad signature (401, no existence oracle); malformed JSON is 400', async () => {
    const { acct, secret } = await setup();
    const signed = mockControl.signedWebhook({ id: 'e', type: 'order.created', orderId: 'x' }, secret);
    expect((await deliver({ id: '019a0000-0000-7000-8000-000000000000' }, signed)).status).toBe(401);
    expect((await deliver(acct, signed, 'flipkart')).status).toBe(401); // the account exists, but not as a flipkart account
    const bad = await c.call('POST', `/api/v1/webhooks/mock/${acct.id}`, { raw: '{not json', contentType: 'application/json', headers: { 'x-mock-signature': 'abc' } });
    expect(bad.status).toBe(400);
  });

  it('an authentic event we do not act on is recorded as ignored', async () => {
    const { acct, secret } = await setup();
    const res = await deliver(acct, mockControl.signedWebhook({ id: 'ret-1', type: 'return.created', orderId: 'x' }, secret));
    expect(res.status).toBe(200);
    await t.pump();
    expect((await events())[0]).toMatchObject({ eventType: 'return.created', status: 'ignored' });
    const unknown = await deliver(acct, mockControl.signedWebhook({ id: '', type: 'order.created' } as never, secret));
    expect(unknown.body.data).toMatchObject({ received: true, ignored: true });
  });
});

describe('asynchronous processing: retry, dead-letter, manual retry', () => {
  it('a failure while processing is retried with backoff and recovers', async () => {
    const { acct, mo, secret } = await setup();
    mockControl.setBehavior(acct.sellerId, { failNext: 100, failKind: 'transient' });
    await deliver(acct, mockControl.signedWebhook({ id: 'evt-r', type: 'order.created', orderId: mo.externalOrderId }, secret));
    await t.runJobs();
    const failed = (await events())[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining(':') });
    expect(failed.nextRetryAt).toBeTruthy();
    expect(await orders()).toHaveLength(0);

    mockControl.setBehavior(acct.sellerId, {});
    await t.pump();
    expect((await events())[0]).toMatchObject({ status: 'processed', attempts: 2, lastError: null });
    expect(await orders()).toHaveLength(1);
  });

  it('is dead-lettered after the last attempt and can be replayed by an operator', async () => {
    const { acct, mo, secret } = await setup();
    mockControl.setBehavior(acct.sellerId, { failNext: 1000, failKind: 'transient' });
    await deliver(acct, mockControl.signedWebhook({ id: 'evt-d', type: 'order.created', orderId: mo.externalOrderId }, secret));
    await t.pump();
    const dead = (await events())[0];
    expect(dead).toMatchObject({ status: 'dead_lettered', attempts: 3 });
    expect((await t.outbox('webhook.dead_lettered')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(1);

    mockControl.setBehavior(acct.sellerId, {});
    const r = await c.post(`/api/v1/webhooks/events/${dead.id}/retry`, {}, admin);
    expect(r.status).toBe(202);
    await t.pump();
    expect((await events())[0]).toMatchObject({ status: 'processed' });
    expect(await orders()).toHaveLength(1);
    expect((await c.post(`/api/v1/webhooks/events/${dead.id}/retry`, {}, admin)).status).toBe(409); // already processed
    expect((await c.post(`/api/v1/webhooks/events/${dead.id}/retry`, {}, viewer)).status).toBe(403);
  });

  it('an event whose queue message was lost is picked up by the sweeper', async () => {
    const { acct, mo, secret } = await setup();
    const realEnqueue = t.queues.enqueue.bind(t.queues);
    t.queues.enqueue = async (...args: Parameters<typeof realEnqueue>) => { if (args[0] === 'webhooksInbound') throw new Error('redis is down'); return realEnqueue(...args); };
    const res = await deliver(acct, mockControl.signedWebhook({ id: 'evt-lost', type: 'order.created', orderId: mo.externalOrderId }, secret));
    t.queues.enqueue = realEnqueue;
    expect(res.status).toBe(200); // the event is durable, so we still acknowledge
    await t.pump();
    expect((await events())[0].status).toBe('received');
    const pg = t.database!.pg;
    await pg.exec('RESET ROLE');
    await pg.query(`update webhook_events set received_at = now() - interval '10 minutes'`);
    await pg.exec('SET ROLE oms_app');
    await t.queues.enqueue('maintenance', 'webhooks.sweep', { vendorId: null, correlationId: 'sweep', data: {} });
    await t.pump();
    expect((await events())[0].status).toBe('processed');
    expect(await orders()).toHaveLength(1);
  });

  it('processed events are purged after the retention window, unprocessed ones are kept', async () => {
    const { acct, mo, secret } = await setup();
    await deliver(acct, mockControl.signedWebhook({ id: 'old-1', type: 'order.created', orderId: mo.externalOrderId }, secret));
    await t.pump();
    await deliver(acct, mockControl.signedWebhook({ id: 'pending-1', type: 'order.updated', orderId: mo.externalOrderId }, secret));
    const pg = t.database!.pg;
    await pg.exec('RESET ROLE');
    await pg.query(`update webhook_events set received_at = now() - interval '90 days'`);
    await pg.exec('SET ROLE oms_app');
    t.queues.jobs.length = 0;
    await t.queues.enqueue('maintenance', 'webhooks.sweep', { vendorId: null, correlationId: 'purge', data: {} });
    await t.runJobs((j) => j.name === 'webhooks.sweep');
    expect((await events()).map((e) => e.status)).toEqual(['received']); // the processed one is gone, the unprocessed one stays
  });
});

describe('what notifications change', () => {
  it('order.cancelled cancels the order and releases the stock', async () => {
    const { acct, v, mo, secret } = await setup();
    await deliver(acct, mockControl.signedWebhook({ id: 'c-1', type: 'order.created', orderId: mo.externalOrderId }, secret));
    await t.pump();
    expect(await c.available(admin, v.variantId)).toBe(8);
    mockControl.setOrderStatus(acct.sellerId, mo.externalOrderId, 'cancelled');
    await deliver(acct, mockControl.signedWebhook({ id: 'c-2', type: 'order.cancelled', orderId: mo.externalOrderId }, secret));
    await t.pump();
    expect((await orders())[0]).toMatchObject({ status: 'cancelled', inventoryStatus: 'released' });
    expect(await c.available(admin, v.variantId)).toBe(10);
    const tl = (await c.get(`/api/v1/orders/${(await orders())[0].id}/timeline`, admin)).body.data;
    expect(tl.map((e: any) => [e.toStatus, e.source])).toEqual([['new', 'webhook'], ['cancelled', 'webhook']]);
  });

  it('listing.status_changed moves a pending listing to active, idempotently', async () => {
    mockControl.configure({ publishDelayPolls: 99 }); // the marketplace review never finishes by polling
    const acct = await c.connectAccount(admin, 'mock');
    const secret = await secretFor(acct);
    const v = await c.makeVariant(admin);
    const l = (await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId: v.variantId, marketplaceCategoryId: 'mock-apparel' }, admin)).body.data;
    await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin);
    await c.post(`/api/v1/listings/${l.id}/approve`, {}, admin);
    await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    await t.pump();
    expect((await c.get(`/api/v1/listings/${l.id}`, admin)).body.data.status).toBe('pending');

    const hook = mockControl.signedWebhook({ id: 'l-1', type: 'listing.status_changed', sku: v.sku, status: 'active' }, secret);
    await deliver(acct, hook);
    await deliver(acct, hook); // duplicate
    await t.pump();
    const live = (await c.get(`/api/v1/listings/${l.id}`, admin)).body.data;
    expect(live).toMatchObject({ status: 'active', externalStatus: 'active' });
    expect((await t.outbox('listing.published')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(1);
    // an unknown SKU is ignored, not an error
    await deliver(acct, mockControl.signedWebhook({ id: 'l-2', type: 'listing.status_changed', sku: 'NOT-OURS', status: 'active' }, secret));
    await t.pump();
    expect((await events()).find((e) => e.externalId === 'l-2')).toMatchObject({ status: 'ignored' });
  });
});

describe('marketplace-specific signing schemes', () => {
  it('Flipkart: base64 HMAC in x-flipkart-signature; shipment notifications import the shipment', async () => {
    const acct = await c.connectAccount(admin, 'flipkart');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 5);
    const secret = await secretFor(acct);
    const cfg = (await c.get(`/api/v1/marketplace-accounts/${acct.id}/webhook-config`, admin)).body.data;
    expect(cfg.signature).toMatchObject({ header: 'x-flipkart-signature' });
    flipkartControl.world.seller(acct.sellerId).products.set(v.sku, { listingId: 'LST1', sku: v.sku, title: 'x', priceMinor: 30000, currency: 'INR', quantity: 5, status: 'active', issues: [], attributes: {}, imageUrls: [], pendingPolls: 0, createdAt: new Date(), updatedAt: new Date() } as never);
    const order = flipkartControl.placeOrder(acct.sellerId, [{ sku: v.sku, quantity: 1 }]);
    const good = flipkartControl.signedNotification({ id: 'fk-1', type: 'shipment.updated', shipmentId: order.id, state: 'APPROVED' }, secret);
    expect((await deliver(acct, good, 'flipkart')).status).toBe(200);
    // an Amazon-style hex signature (or the mock's header) is not accepted on Flipkart
    expect((await deliver(acct, { rawBody: good.rawBody, headers: { 'content-type': 'application/json', 'x-oms-signature': 'abc' } }, 'flipkart')).status).toBe(401);
    await t.pump();
    const o = await orders();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ marketplace: 'flipkart', externalOrderId: order.id, status: 'confirmed', marketplaceStatus: 'APPROVED', inventoryStatus: 'reserved' });
  });

  it('Amazon: hex HMAC in x-oms-signature (ingress bridge); ORDER_CHANGE imports the order', async () => {
    const acct = await c.connectAccount(admin, 'amazon_in');
    const v = await c.makeVariant(admin);
    await c.stock(admin, v.variantId, wh.id, 5);
    const secret = await secretFor(acct);
    amazonControl.world.seller(acct.sellerId).products.set(v.sku, { listingId: 'B0TEST', sku: v.sku, title: 'x', priceMinor: 30000, currency: 'INR', quantity: 5, status: 'active', issues: [], attributes: {}, imageUrls: [], pendingPolls: 0, createdAt: new Date(), updatedAt: new Date() } as never);
    const order = amazonControl.placeOrder(acct.sellerId, [{ sku: v.sku, quantity: 2 }]);
    const note = amazonControl.signedNotification({ id: 'amz-1', type: 'ORDER_CHANGE', orderId: order.id, orderStatus: 'Unshipped' }, secret);
    expect((await deliver(acct, note, 'amazon_in')).status).toBe(200);
    expect((await deliver(acct, note, 'amazon_in')).body.data.duplicate).toBe(true);
    await t.pump();
    const o = await orders();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ marketplace: 'amazon_in', externalOrderId: order.id, status: 'confirmed', marketplaceStatus: 'Unshipped', payment: { method: 'prepaid' } });
    expect(o[0].items[0]).toMatchObject({ quantity: 2, unitPriceMinor: 30000 });
  });
});
