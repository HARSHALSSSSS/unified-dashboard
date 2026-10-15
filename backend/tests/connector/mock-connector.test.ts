import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { MockConnector, MockMarketplaceState, mockControl } from '@oms/connector-mock';
import { ConnectorError, withRetry, type ConnectorContext } from '@oms/marketplace-core';

/**
 * The mock/sandbox marketplace, exercised directly through the MarketplaceConnector interface (no HTTP, no DB):
 * connection, authorization, products, orders, inventory, errors and retries.
 */
const state = new MockMarketplaceState();
const mock = new MockConnector(state);
let ctx: ConnectorContext;

const ctxFor = (creds: Record<string, unknown>, sellerId: string): ConnectorContext => ({
  vendorId: 'v1', marketplaceAccountId: 'a1', externalAccountId: sellerId, mode: 'sandbox', credentials: creds,
});

beforeEach(async () => {
  state.sellers.clear(); state.accessTokens.clear(); state.refreshTokens.clear(); state.now = () => new Date();
  const auth = await mock.authenticate({ credentials: { sellerId: 'S1', apiKey: 'sandbox_abc' } });
  ctx = ctxFor(auth.credentials, auth.externalAccountId);
});

describe('connection and authorization', () => {
  it('authenticates with an API key and with an authorization code', async () => {
    const a = await mock.authenticate({ credentials: { sellerId: 'S2', apiKey: 'sandbox_k', ttlSeconds: 60 } });
    expect(a.externalAccountId).toBe('S2');
    expect(a.credentials.accessToken).toMatch(/^mock_at_/);
    expect(a.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    const b = await mock.exchangeAuthorizationCode({ code: 'sandbox-code:S3:120' });
    expect(b).toMatchObject({ externalAccountId: 'S3' });
    expect(mock.buildAuthorizationUrl({ state: 'st', redirectUri: 'https://x.test/cb' })).toContain('state=st');
  });

  it('rejects bad credentials and bad codes with a non-retryable auth error', async () => {
    for (const p of [mock.authenticate({ credentials: { sellerId: 'S', apiKey: 'live_key' } }), mock.authenticate({ credentials: {} }), mock.exchangeAuthorizationCode({ code: 'nope' })]) {
      const e = await p.catch((x) => x);
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e).toMatchObject({ kind: 'auth', retryable: false });
    }
  });

  it('verifies the connection and detects expired tokens', async () => {
    expect(await mock.verifyConnection(ctx)).toMatchObject({ ok: true });
    state.now = () => new Date(Date.now() + 2 * 3600_000); // jump 2h ahead of the default 1h token life
    await expect(mock.verifyConnection(ctx)).rejects.toMatchObject({ kind: 'auth', code: 'token_expired' });
  });

  it('rotates credentials on refresh (new tokens, expiry in the future)', async () => {
    const next = await mock.refreshCredentials(ctx);
    expect(next.credentials.accessToken).not.toBe(ctx.credentials.accessToken);
    expect(next.credentials.refreshToken).not.toBe(ctx.credentials.refreshToken);
    expect(next.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expect(mock.refreshCredentials({ ...ctx, credentials: { ...ctx.credentials, refreshToken: 'garbage' } })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('returns the seller profile', async () => {
    expect(await mock.getAccount(ctx)).toMatchObject({ externalAccountId: 'S1', status: 'active' });
  });
});

describe('products, listings, inventory and pricing', () => {
  it('pages through the seeded catalogue', async () => {
    const skus: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await mock.importProducts(ctx, { cursor, limit: 10 });
      skus.push(...page.items.map((p) => p.externalSku));
      cursor = page.nextCursor;
    } while (cursor);
    expect(skus).toHaveLength(25);
    expect(new Set(skus).size).toBe(25);
  });

  it('creates and updates listings; duplicate SKUs are a permanent error', async () => {
    const input = { externalSku: 'NEW-1', title: 'A brand new listing', priceMinor: 1000, currency: 'INR', quantity: 5, marketplaceCategoryId: 'mock-apparel', attributes: { brand: 'Acme', color: 'Red', size: 'M' } };
    const created = await mock.createListing(ctx, input);
    // listings are REVIEWED by the marketplace: a valid submission is `pending` until the status check passes
    expect(created).toMatchObject({ status: 'pending' });
    await expect(mock.createListing(ctx, input)).rejects.toMatchObject({ kind: 'permanent', code: 'duplicate_sku' });
    const upd = await mock.updateListing(ctx, { ...input, externalListingId: created.externalListingId, title: 'A renamed listing', priceMinor: 1200 });
    expect(upd.externalListingId).toBe(created.externalListingId);
    await expect(mock.updateListing(ctx, { externalListingId: 'MP-NOPE', externalSku: 'x', title: 'x', priceMinor: 1, currency: 'INR' })).rejects.toMatchObject({ code: 'listing_not_found' });
  });

  it('pushes inventory and prices with per-item results (unknown SKU / bad quantity do not fail the batch)', async () => {
    const [sku] = (await mock.importProducts(ctx, { limit: 1 })).items;
    const inv = await mock.pushInventory(ctx, [{ externalSku: sku!.externalSku, quantity: 7 }, { externalSku: 'UNKNOWN', quantity: 1 }, { externalSku: sku!.externalSku, quantity: -1 }]);
    expect(inv.map((r) => r.ok)).toEqual([true, false, false]);
    expect(inv[1]).toMatchObject({ errorCode: 'SKU_NOT_FOUND' });
    expect((await mock.importProducts(ctx, { limit: 1 })).items[0]!.quantity).toBe(7);
    const px = await mock.pushPrices(ctx, [{ externalSku: sku!.externalSku, priceMinor: 4242, currency: 'INR' }, { externalSku: 'UNKNOWN', priceMinor: 1, currency: 'INR' }]);
    expect(px.map((r) => r.ok)).toEqual([true, false]);
    expect((await mock.importProducts(ctx, { limit: 1 })).items[0]!.priceMinor).toBe(4242);
  });

  it('keeps sellers isolated from each other', async () => {
    const other = await mock.authenticate({ credentials: { sellerId: 'S9', apiKey: 'sandbox_z' } });
    await mock.pushInventory(ctx, [{ externalSku: 'MOCK-S1-SKU-001', quantity: 99 }]);
    const o = (await mock.importProducts(ctxFor(other.credentials, 'S9'), { limit: 1 })).items[0]!;
    expect(o.externalSku).toBe('MOCK-S9-SKU-001');
    expect(o.quantity).not.toBe(99);
  });
});

describe('orders, returns and shipping', () => {
  it('fetches orders since a date, with paging', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await mock.fetchOrders(ctx, { since: new Date(0), cursor });
      ids.push(...page.items.map((o) => o.externalOrderId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(5);
    expect((await mock.fetchOrders(ctx, { since: new Date(Date.now() + 86_400_000) })).items).toHaveLength(0);
    const first = (await mock.fetchOrders(ctx, { since: new Date(0) })).items[0]!;
    expect(first.items[0]).toMatchObject({ quantity: 2, unitPriceMinor: expect.any(Number) });
    expect(first.totalMinor).toBe(first.items[0]!.unitPriceMinor * 2);
  });

  it('updates order status, ships, and refuses to cancel shipped orders', async () => {
    const [o1, o2] = (await mock.fetchOrders(ctx, { since: new Date(0) })).items;
    expect(await mock.updateOrderStatus(ctx, { externalOrderId: o1!.externalOrderId, status: 'confirmed' })).toEqual({ ok: true, marketplaceStatus: 'accepted' });
    expect(await mock.updateOrderStatus(ctx, { externalOrderId: 'nope', status: 'confirmed' })).toMatchObject({ ok: false, errorCode: 'ORDER_NOT_FOUND' });
    const shipment = await mock.createShipment(ctx, { externalOrderId: o2!.externalOrderId });
    expect(shipment).toMatchObject({ carrier: 'SandboxExpress', trackingNumber: expect.stringMatching(/^MOCKTRK/) });
    expect(await mock.cancelOrder(ctx, { externalOrderId: o2!.externalOrderId })).toMatchObject({ ok: false, errorCode: 'NOT_CANCELLABLE' });
    expect(await mock.cancelOrder(ctx, { externalOrderId: o1!.externalOrderId })).toEqual({ ok: true });
    await expect(mock.createShipment(ctx, { externalOrderId: 'nope' })).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('fetches returns', async () => {
    const r = await mock.fetchReturns(ctx, { since: new Date(0) });
    expect(r.items[0]).toMatchObject({ status: 'requested', reason: 'size_issue' });
  });
});

describe('simulated failures and retries', () => {
  it('failNext makes the next N calls fail with the chosen kind, then recovers', async () => {
    mockStateBehavior('S1', { failNext: 2, failKind: 'transient' });
    await expect(mock.getAccount(ctx)).rejects.toMatchObject({ kind: 'transient', retryable: true });
    await expect(mock.getAccount(ctx)).rejects.toMatchObject({ kind: 'transient' });
    await expect(mock.getAccount(ctx)).resolves.toBeTruthy();
  });

  it('withRetry rides out transient failures and 429s, honouring Retry-After and the attempt limit', async () => {
    mockStateBehavior('S1', { failNext: 2, failKind: 'transient' });
    const delays: number[] = [];
    const opts = { sleep: async (ms: number) => void delays.push(ms), random: () => 1, baseDelayMs: 100 };
    await expect(withRetry(() => mock.getAccount(ctx), opts)).resolves.toBeTruthy();
    expect(delays).toEqual([100, 200]); // exponential, full jitter forced to 1.0

    mockStateBehavior('S1', { rateLimitNext: 1, retryAfterMs: 750 });
    delays.length = 0;
    await withRetry(() => mock.getAccount(ctx), opts);
    expect(delays).toEqual([750]); // Retry-After wins over the (smaller) backoff

    mockStateBehavior('S1', { failNext: 99, failKind: 'transient' });
    await expect(withRetry(() => mock.getAccount(ctx), { ...opts, attempts: 4 })).rejects.toMatchObject({ kind: 'transient' });
    mockStateBehavior('S1', { failNext: 1, failKind: 'permanent' });
    let attempts = 0;
    await expect(withRetry(async () => { attempts++; return mock.getAccount(ctx); }, opts)).rejects.toMatchObject({ kind: 'permanent' });
    expect(attempts).toBe(1); // permanent errors are never retried
  });
});

describe('webhooks', () => {
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ event: 'order.created', id: 'evt_1' }));
  it('verifies signatures on the RAW body and parses events with an idempotency key', () => {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(mock.verifyWebhook({ headers: { 'x-mock-signature': sig }, rawBody: body, secret })).toBe(true);
    expect(mock.verifyWebhook({ headers: { 'x-mock-signature': sig }, rawBody: Buffer.from('{"event":"x"}'), secret })).toBe(false);
    expect(mock.verifyWebhook({ headers: {}, rawBody: body, secret })).toBe(false);
    expect(mock.parseWebhook({ headers: {}, body: JSON.parse(body.toString()) })).toMatchObject({ eventType: 'order.created', idempotencyKey: 'mock-evt_1' });
  });
});

function mockStateBehavior(seller: string, b: Parameters<typeof mockControl.setBehavior>[1]) {
  state.seller(seller).behavior = { ...b };
}
