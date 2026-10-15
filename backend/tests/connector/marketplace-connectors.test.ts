import { beforeEach, describe, expect, it } from 'vitest';
import { createAmazonInConnector, amazonControl, AMAZON_ORDER_STATUS_MAP } from '@oms/connector-amazon-in';
import { createFlipkartConnector, flipkartControl, FLIPKART_ORDER_STATUS_MAP } from '@oms/connector-flipkart';
import { createMyntraConnector, myntraControl, MYNTRA_ORDER_STATUS_MAP } from '@oms/connector-myntra';
import { createSnapdealConnector, snapdealControl, SNAPDEAL_ORDER_STATUS_MAP } from '@oms/connector-snapdeal';
import {
  ConnectorError, enabledCapabilities, ORDER_STATUSES, type ConnectorContext, type ConnectorCredentials, type ListingInput, type MarketplaceConnector,
} from '@oms/marketplace-core';

/**
 * Conformance suite: every launch connector must behave the same way at the contract level, whatever its wire format.
 * These tests talk to each connector's own simulator over its REAL client (HTTP paths, headers, JSON shapes, error codes):
 * what they prove is OUR code (auth, mapping, error classification, rate-limit handling), not the marketplace's behaviour.
 */
interface Spec {
  code: string;
  connector: MarketplaceConnector;
  control: typeof amazonControl;
  creds: (seller: string) => ConnectorCredentials;
  badCreds: ConnectorCredentials;
  categoryId: string;
  /** attribute values the category requires (beyond title / brand which come from the listing input) */
  attributes: Record<string, string>;
  statusMap: Record<string, string>;
  /** native word of an order a customer just placed + one the seller shipped */
  nativeNew: string;
  nativeShipped: string;
  nativeCancelled: string;
  expectedAuth: 'oauth2_lwa' | 'oauth2' | 'api_key' | 'custom';
  webhooks: boolean;
  batchInventory: boolean;
  updatableStatuses: string[];
}

const SPECS: Spec[] = [
  {
    code: 'amazon_in', connector: createAmazonInConnector(), control: amazonControl, creds: (s) => ({ sellerId: s, refreshToken: `Atzr|sandbox:${s}` }), badCreds: { sellerId: 'X', refreshToken: 'garbage' },
    categoryId: 'SHIRT', attributes: { color: 'Blue', size: 'M', country_of_origin: 'IN' }, statusMap: AMAZON_ORDER_STATUS_MAP, nativeNew: 'Unshipped', nativeShipped: 'Shipped', nativeCancelled: 'Canceled',
    expectedAuth: 'oauth2_lwa', webhooks: true, batchInventory: false, updatableStatuses: ['dispatched'],
  },
  {
    code: 'flipkart', connector: createFlipkartConnector(), control: flipkartControl as never, creds: (s) => ({ appId: `fk-sandbox-${s}`, appSecret: 'secret' }), badCreds: { appId: 'nope', appSecret: 'x' },
    categoryId: 'mens_tshirts', attributes: { color: 'Blue', size: 'M' }, statusMap: FLIPKART_ORDER_STATUS_MAP, nativeNew: 'APPROVED', nativeShipped: 'SHIPPED', nativeCancelled: 'CANCELLED',
    expectedAuth: 'oauth2', webhooks: true, batchInventory: true, updatableStatuses: ['dispatched', 'cancelled'],
  },
  {
    code: 'myntra', connector: createMyntraConnector(), control: myntraControl as never, creds: (s) => ({ apiKey: `myn-sandbox-${s}`, apiSecret: 'secret' }), badCreds: { apiKey: 'nope', apiSecret: 'x' },
    categoryId: 'tshirts', attributes: { color: 'Blue', size: 'M' }, statusMap: MYNTRA_ORDER_STATUS_MAP, nativeNew: 'CREATED', nativeShipped: 'SHIPPED', nativeCancelled: 'CANCELLED',
    expectedAuth: 'api_key', webhooks: false, batchInventory: true, updatableStatuses: ['confirmed', 'packed', 'ready_to_dispatch', 'dispatched'],
  },
  {
    code: 'snapdeal', connector: createSnapdealConnector(), control: snapdealControl as never, creds: (s) => ({ sellerId: s, authToken: `sd-sandbox-${s}` }), badCreds: { sellerId: 'S', authToken: 'wrong' },
    categoryId: 'mens-apparel', attributes: { color: 'Blue', size: 'M' }, statusMap: SNAPDEAL_ORDER_STATUS_MAP, nativeNew: 'NEW', nativeShipped: 'HANDED_OVER', nativeCancelled: 'CANCELLED',
    expectedAuth: 'custom', webhooks: false, batchInventory: true, updatableStatuses: ['confirmed', 'packed', 'ready_to_dispatch', 'dispatched', 'cancelled'],
  },
];

describe.each(SPECS)('connector conformance: $code', (spec) => {
  const { connector, control } = spec;
  let seller: string;
  let ctx: ConnectorContext;
  let n = 0;

  const contextFor = async (sellerId: string): Promise<ConnectorContext> => {
    const a = await connector.authenticate!({ credentials: spec.creds(sellerId), mode: 'sandbox' });
    return { vendorId: 'v1', marketplaceAccountId: 'a1', externalAccountId: a.externalAccountId, mode: 'sandbox', credentials: a.credentials };
  };
  // the title also travels as the marketplace's own title attribute (name differs per marketplace), so keep them in step
  const input = (sku: string, o: Partial<ListingInput> = {}): ListingInput => {
    const title = o.title ?? 'A comfortable cotton tee shirt';
    return {
      externalSku: sku, brand: 'Acme', priceMinor: 49900, mrpMinor: 59900, currency: 'INR', quantity: 5, marketplaceCategoryId: spec.categoryId,
      attributes: { ...spec.attributes, title, brand: 'Acme', item_name: title, name: title, productName: title }, ...o, title,
    };
  };

  beforeEach(async () => {
    control.reset();
    seller = `S${++n}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    ctx = await contextFor(seller);
  });

  // ---------------------------------------------------------------- declaration
  describe('declaration', () => {
    it('is a beta connector, sandbox-ready and NEVER claims live access it has not earned', () => {
      expect(connector).toMatchObject({ code: spec.code, implementation: 'beta' });
      expect(connector.readiness.sandbox).toBe(true);
      expect(connector.readiness.live).toBe(false);
      expect(connector.readiness.notes.length).toBeGreaterThan(40);
      expect(connector.capabilities.auth.type).toBe(spec.expectedAuth);
    });

    it('every enabled capability has an implementation, and nothing is implemented that is not declared', () => {
      const need: Record<string, string[]> = {
        'account.fetchProfile': ['getAccount'], 'catalog.import': ['importProducts'], 'listings.create': ['createListing'], 'listings.update': ['updateListing'], 'listings.deactivate': ['deactivateListing'],
        'listings.fetch': ['getListingStatus'], 'listings.categorySearch': ['searchCategories', 'getCategoryRequirements'], 'listings.statusLookup': ['getListingStatus'],
        'inventory.push': ['pushInventory'], 'pricing.push': ['pushPrices'], 'orders.fetch': ['fetchOrders', 'getOrder'], 'orders.webhook': ['verifyWebhook', 'parseWebhook'], 'orders.updateStatus': ['updateOrderStatus', 'canRequestOrderStatus'],
      };
      const have = new Set(enabledCapabilities(connector));
      for (const [cap, methods] of Object.entries(need)) {
        if (have.has(cap)) for (const m of methods) expect(typeof (connector as unknown as Record<string, unknown>)[m], `${spec.code}.${m} for ${cap}`).toBe('function');
      }
      expect(have.has('orders.webhook')).toBe(spec.webhooks);
      expect(connector.capabilities.inventory.batch).toBe(spec.batchInventory);
      expect(typeof connector.verifyWebhook === 'function').toBe(spec.webhooks);
    });

    it('declares a polling plan where it cannot rely on pushes; limits are sane', () => {
      expect(connector.polling?.orders?.intervalSeconds).toBeGreaterThan(0);
      if (!spec.webhooks) expect(connector.polling!.orders!.intervalSeconds).toBeLessThanOrEqual(600); // polling IS the only source of orders
      const l = connector.capabilities.limits;
      expect(l.requestsPerSecond).toBeGreaterThan(0);
      expect(l.burst).toBeGreaterThanOrEqual(1);
      expect(l.maxBatchSize).toBeGreaterThanOrEqual(1);
    });

    it('maps every marketplace order status to a valid internal status', () => {
      for (const [native, internal] of Object.entries(spec.statusMap)) expect(ORDER_STATUSES, `${native} -> ${internal}`).toContain(internal);
      expect(spec.statusMap[spec.nativeNew]).toMatch(/^(new|confirmed)$/);
      expect(spec.statusMap[spec.nativeShipped]).toBe('dispatched');
      expect(spec.statusMap[spec.nativeCancelled]).toBe('cancelled');
    });
  });

  // ---------------------------------------------------------------- authentication
  describe('authentication + authorization', () => {
    it('authenticates a sandbox seller and returns the seller id, a usable credential set and an expiry where tokens expire', async () => {
      const a = await connector.authenticate!({ credentials: spec.creds('SELLER-A'), mode: 'sandbox' });
      expect(a.externalAccountId).toBe('SELLER-A');
      expect(Object.keys(a.credentials).length).toBeGreaterThan(0);
      expect(a.credentials.password).toBeUndefined();
      if (connector.capabilities.auth.refreshable || spec.expectedAuth !== 'custom') expect(a.expiresAt).toBeInstanceOf(Date);
      if (spec.expectedAuth === 'custom') expect(a.expiresAt).toBeUndefined(); // static token: no expiry
      expect((await connector.verifyConnection({ ...ctx, credentials: a.credentials })).ok).toBe(true);
    });

    it('rejects bad credentials as an AUTH error (never retried), and missing fields as such too', async () => {
      await expect(connector.authenticate!({ credentials: spec.badCreds, mode: 'sandbox' })).rejects.toMatchObject({ kind: 'auth' });
      await expect(connector.authenticate!({ credentials: {}, mode: 'sandbox' })).rejects.toMatchObject({ kind: 'auth', code: 'invalid_credentials' });
      const e = await connector.authenticate!({ credentials: spec.badCreds, mode: 'sandbox' }).catch((x) => x);
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e.retryable).toBe(false);
    });

    it('an expired access token is an auth error; refreshing yields a working one (where refreshable)', async () => {
      control.expireTokens();
      if (connector.capabilities.auth.refreshable) {
        await expect(connector.fetchOrders!(ctx, { since: new Date(0) })).rejects.toMatchObject({ kind: 'auth' });
        const next = await connector.refreshCredentials!(ctx);
        expect(next.expiresAt).toBeInstanceOf(Date);
        const page = await connector.fetchOrders!({ ...ctx, credentials: next.credentials }, { since: new Date(0) });
        expect(page.items).toEqual([]);
      } else {
        expect(connector.refreshCredentials).toBeUndefined(); // static token: nothing to refresh
      }
    });

    it('a scripted 401 is an auth error', async () => {
      control.setBehavior(seller, { authFailNext: 1 });
      await expect(connector.verifyConnection(ctx)).rejects.toMatchObject({ kind: 'auth' });
    });

    it('redirect-based authorization builds a URL carrying our state, and exchanges a code (where supported)', async () => {
      if (!connector.capabilities.auth.redirectFlow) { expect(connector.buildAuthorizationUrl).toBeUndefined(); return; }
      const url = new URL(connector.buildAuthorizationUrl!({ state: 'STATE123', redirectUri: 'https://app.example/cb' }));
      expect(url.searchParams.get('state')).toBe('STATE123');
      const code = spec.code === 'amazon_in' ? `ANsandbox:${seller}` : `FKsandbox:${seller}`;
      const done = await connector.exchangeAuthorizationCode!({ code, redirectUri: 'https://app.example/cb', externalAccountId: seller, mode: 'sandbox' });
      expect(done.externalAccountId).toBe(seller);
      await expect(connector.exchangeAuthorizationCode!({ code: 'garbage', redirectUri: 'https://app.example/cb', externalAccountId: seller, mode: 'sandbox' })).rejects.toMatchObject({ kind: 'auth' });
    });
  });

  // ---------------------------------------------------------------- errors + rate limits
  describe('error mapping and rate-limit handling', () => {
    it('429 becomes a retryable rate_limited error carrying the marketplace Retry-After', async () => {
      control.setBehavior(seller, { rateLimitNext: 1, retryAfterSec: 7 });
      const e = await connector.fetchOrders!(ctx, { since: new Date(0) }).catch((x) => x);
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e).toMatchObject({ kind: 'rate_limited', retryable: true });
      expect(e.opts.retryAfterMs).toBe(7000);
    });

    it('5xx is transient (retryable); 4xx business rejections are permanent (not retryable)', async () => {
      control.setBehavior(seller, { failNext: 1, failStatus: 503 });
      expect(await connector.fetchOrders!(ctx, { since: new Date(0) }).catch((x) => x)).toMatchObject({ kind: 'transient', retryable: true });
      control.setBehavior(seller, { failNext: 1, failStatus: 400 });
      expect(await connector.fetchOrders!(ctx, { since: new Date(0) }).catch((x) => x)).toMatchObject({ kind: 'permanent', retryable: false });
    });

    it('the error message never leaks credentials', async () => {
      control.setBehavior(seller, { failNext: 1, failStatus: 500 });
      const e = (await connector.fetchOrders!(ctx, { since: new Date(0) }).catch((x) => x)) as Error;
      const text = `${e.message} ${JSON.stringify((e as ConnectorError).opts)}`;
      for (const v of Object.values(ctx.credentials)) if (typeof v === 'string' && v.length > 6) expect(text).not.toContain(v);
    });
  });

  // ---------------------------------------------------------------- catalogue import
  describe('product import (marketplace product -> normalised product)', () => {
    it('pages through the whole catalogue with a cursor and normalises every item', async () => {
      const skus: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<NonNullable<MarketplaceConnector['importProducts']>>> = await connector.importProducts!(ctx, { cursor, limit: 3 });
        pages++;
        for (const p of page.items) {
          skus.push(p.externalSku);
          expect(p).toMatchObject({ externalListingId: expect.any(String), externalSku: expect.any(String), title: expect.any(String), currency: 'INR', status: 'active' });
          expect(p.priceMinor).toBeGreaterThan(0);
          expect(Number.isInteger(p.priceMinor)).toBe(true); // money is integer minor units, never a float
          expect(p.quantity).toBeGreaterThanOrEqual(0);
          expect(p.raw).toBeDefined(); // the marketplace payload is kept for audit, outside the normalised fields
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(skus).toHaveLength(8);
      expect(new Set(skus).size).toBe(8);
    });
  });

  // ---------------------------------------------------------------- categories + listings
  describe('categories and listings', () => {
    it('searches categories and reports the requirements of one', async () => {
      const cats = await connector.searchCategories!(ctx, { query: undefined });
      expect(cats.map((c) => c.id)).toContain(spec.categoryId);
      const reqs = await connector.getCategoryRequirements!(ctx, { marketplaceCategoryId: spec.categoryId });
      expect(reqs.length).toBeGreaterThan(2);
      expect(reqs.some((r) => r.required)).toBe(true);
      for (const r of reqs) expect(['string', 'number', 'boolean', 'enum']).toContain(r.type);
    });

    it('previews the exact request without any network call', () => {
      const before = control.calls(seller);
      const p = connector.previewListing!(input('PREVIEW-1'));
      expect(p.endpoint).toEqual(expect.any(String));
      expect(`${p.endpoint} ${JSON.stringify(p.payload)}`).toContain('PREVIEW-1');
      expect(Array.isArray(p.warnings)).toBe(true);
      expect(control.calls(seller)).toBe(before);
    });

    it('creates a listing that goes pending -> active after the marketplace review, and exposes its status', async () => {
      const r = await connector.createListing!(ctx, input('NEW-SKU-1'));
      expect(r).toMatchObject({ status: 'pending', issues: [] });
      expect(r.externalListingId).toEqual(expect.any(String));
      const first = await connector.getListingStatus!(ctx, { externalSku: 'NEW-SKU-1' });
      expect(first.status).toBe('active'); // the simulated review finishes on the first status check
      expect(first.externalSku).toBe('NEW-SKU-1');
      expect(control.listing(seller, 'NEW-SKU-1')?.status).toBe('active');
      const upd = await connector.updateListing!(ctx, { ...input('NEW-SKU-1', { title: 'A renamed cotton tee shirt' }), externalListingId: first.externalListingId });
      expect(upd.externalListingId).toBe(first.externalListingId);
    });

    it('maps marketplace validation errors to correction_required with the offending attribute', async () => {
      const bad = input('BAD-SKU', { attributes: {}, title: 'Short' });
      const r = await connector.createListing!(ctx, bad);
      expect(r.status).toBe('correction_required');
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues.every((i) => i.code && i.message && ['error', 'warning'].includes(i.severity))).toBe(true);
      expect(r.issues.some((i) => i.attribute)).toBe(true);
    });

    it('a policy violation is a rejection, not a fixable error', async () => {
      const r = await connector.createListing!(ctx, input('REPLICA-SKU', { title: 'A replica designer cotton tee' }));
      expect(r.status).toBe('rejected');
      const report = await connector.getListingStatus!(ctx, { externalSku: 'REPLICA-SKU' });
      expect(report.status).toBe('rejected');
    });

    it('deactivates a listing; an unknown SKU is a per-item failure, not an exception', async () => {
      const [first] = (await connector.importProducts!(ctx, { limit: 1 })).items;
      expect(await connector.deactivateListing!(ctx, { externalSku: first!.externalSku })).toMatchObject({ ok: true });
      const after = control.listing(seller, first!.externalSku);
      expect(!after || after.status === 'inactive').toBe(true); // some marketplaces keep the record as inactive, others delete it
      expect(await connector.deactivateListing!(ctx, { externalSku: 'NOPE' })).toMatchObject({ ok: false });
    });
  });

  // ---------------------------------------------------------------- inventory + pricing
  describe('inventory and price push', () => {
    it('pushes quantities with a result PER SKU: an unknown SKU or a bad quantity does not fail the batch', async () => {
      const [a, b] = (await connector.importProducts!(ctx, { limit: 2 })).items;
      const res = await connector.pushInventory!(ctx, [{ externalSku: a!.externalSku, quantity: 33 }, { externalSku: 'UNKNOWN-SKU', quantity: 1 }, { externalSku: b!.externalSku, quantity: 0 }]);
      expect(res.map((r) => r.ok)).toEqual([true, false, true]);
      expect(res[1]).toMatchObject({ externalSku: 'UNKNOWN-SKU', errorCode: expect.any(String) });
      expect(control.listing(seller, a!.externalSku)?.quantity).toBe(33);
      expect(control.listing(seller, b!.externalSku)?.quantity).toBe(0);
    });

    it('a large batch is split to the marketplace limit (or sent SKU by SKU) transparently', async () => {
      const all = (await connector.importProducts!(ctx, { limit: 100 })).items.slice(0, 8);
      const res = await connector.pushInventory!(ctx, all.map((p, i) => ({ externalSku: p.externalSku, quantity: 100 + i })));
      expect(res.every((r) => r.ok)).toBe(true);
      all.forEach((p, i) => expect(control.listing(seller, p.externalSku)?.quantity).toBe(100 + i));
    });

    it('a transient failure of the push aborts the call (so the engine retries); it is not reported as an item failure', async () => {
      const [a] = (await connector.importProducts!(ctx, { limit: 1 })).items;
      control.setBehavior(seller, { failNext: 1, failStatus: 503 });
      await expect(connector.pushInventory!(ctx, [{ externalSku: a!.externalSku, quantity: 5 }])).rejects.toMatchObject({ kind: 'transient' });
    });

    it('pushes prices in minor units', async () => {
      const [a] = (await connector.importProducts!(ctx, { limit: 1 })).items;
      const res = await connector.pushPrices!(ctx, [{ externalSku: a!.externalSku, priceMinor: 123456, currency: 'INR' }, { externalSku: 'UNKNOWN-SKU', priceMinor: 100, currency: 'INR' }]);
      expect(res.map((r) => r.ok)).toEqual([true, false]);
      expect(control.listing(seller, a!.externalSku)?.priceMinor).toBe(123456);
    });
  });

  // ---------------------------------------------------------------- orders
  describe('orders (marketplace order -> normalised order)', () => {
    const sellable = async () => (await connector.importProducts!(ctx, { limit: 1 })).items[0]!;

    it('normalises a new customer order: status, money, buyer, address, payment, lines', async () => {
      const p = await sellable();
      const placed = control.placeOrder(seller, [{ sku: p.externalSku, quantity: 2 }], { cod: true });
      const page = await connector.fetchOrders!(ctx, { since: new Date(0) });
      expect(page.items).toHaveLength(1);
      const o = page.items[0]!;
      expect(o).toMatchObject({
        externalOrderId: placed.id, marketplaceStatus: spec.nativeNew, status: spec.statusMap[spec.nativeNew], currency: 'INR',
        buyer: { name: 'Sandbox Buyer' }, shippingAddress: expect.objectContaining({ city: 'Bengaluru', pincode: '560001' }), payment: { method: 'cod' },
      });
      expect(o.items).toEqual([expect.objectContaining({ sku: p.externalSku, quantity: 2, unitPriceMinor: p.priceMinor })]);
      expect(Number.isInteger(o.totalMinor)).toBe(true);
      // line amounts are in minor units and add up to the order total (unit x qty + tax - discount)
      const calc = o.items.reduce((s, i) => s + i.unitPriceMinor * i.quantity + i.taxMinor - i.discountMinor, 0);
      expect(o.totalMinor).toBe(calc);
      expect(o.payment!.codAmountMinor).toBe(o.totalMinor);
      expect(o.placedAt).toBeInstanceOf(Date);
    });

    it('pages through many orders without losing or repeating any', async () => {
      const p = await sellable();
      const ids = new Set<string>();
      for (let i = 0; i < 12; i++) ids.add(control.placeOrder(seller, [{ sku: p.externalSku, quantity: 1 }]).id);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<NonNullable<MarketplaceConnector['fetchOrders']>>> = await connector.fetchOrders!(ctx, { since: new Date(0), cursor });
        seen.push(...page.items.map((o) => o.externalOrderId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(12);
      expect(new Set(seen)).toEqual(ids);
    });

    it('`since` filters out older orders', async () => {
      const p = await sellable();
      control.placeOrder(seller, [{ sku: p.externalSku, quantity: 1 }]);
      expect((await connector.fetchOrders!(ctx, { since: new Date(Date.now() + 3_600_000) })).items).toHaveLength(0);
    });

    it('reports status changes made on the marketplace, normalised', async () => {
      const p = await sellable();
      const o = control.placeOrder(seller, [{ sku: p.externalSku, quantity: 1 }]);
      control.setOrderStatus(seller, o.id, spec.nativeShipped);
      expect((await connector.fetchOrders!(ctx, { since: new Date(0) })).items[0]).toMatchObject({ status: 'dispatched', marketplaceStatus: spec.nativeShipped });
      control.setOrderStatus(seller, o.id, spec.nativeCancelled);
      expect((await connector.getOrder!(ctx, { externalOrderId: o.id }))).toMatchObject({ status: 'cancelled' });
    });

    it('fetches a single order, and returns null for one that does not exist', async () => {
      const p = await sellable();
      const o = control.placeOrder(seller, [{ sku: p.externalSku, quantity: 1 }]);
      expect((await connector.getOrder!(ctx, { externalOrderId: o.id }))?.externalOrderId).toBe(o.id);
      expect(await connector.getOrder!(ctx, { externalOrderId: 'DOES-NOT-EXIST' })).toBeNull();
    });

    it('accepts only the statuses it declares; the marketplace changes accordingly; invalid steps are per-item rejections', async () => {
      const p = await sellable();
      for (const s of ORDER_STATUSES) expect(connector.canRequestOrderStatus!(s), s).toBe(spec.updatableStatuses.includes(s));
      expect(await connector.updateOrderStatus!(ctx, { externalOrderId: 'x', status: 'delivered' })).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_STATUS' });

      const o = control.placeOrder(seller, [{ sku: p.externalSku, quantity: 1 }]);
      // walk the marketplace's own sequence of accepted statuses up to dispatch
      for (const s of ['confirmed', 'packed', 'ready_to_dispatch', 'dispatched'] as const) {
        if (!spec.updatableStatuses.includes(s)) continue;
        const r = await connector.updateOrderStatus!(ctx, { externalOrderId: o.id, status: s, tracking: { number: 'AWB-1', carrier: 'FastShip' } });
        expect(r, `${spec.code} ${s}`).toMatchObject({ ok: true, marketplaceStatus: expect.any(String) });
      }
      expect(control.order(seller, o.id)?.status).toBe(spec.nativeShipped);
      expect(control.order(seller, o.id)?.tracking).toMatchObject({ number: 'AWB-1' });
      // a dispatched order cannot be dispatched/cancelled again: reported, not thrown
      const again = await connector.updateOrderStatus!(ctx, { externalOrderId: o.id, status: 'dispatched' });
      expect(again.ok).toBe(false);
      expect(await connector.updateOrderStatus!(ctx, { externalOrderId: 'NOPE', status: 'dispatched' })).toMatchObject({ ok: false });
    });
  });
});

// -------------------------------------------------------------------- webhooks (marketplaces that push)
describe.each(SPECS.filter((s) => s.webhooks))('webhook handling: $code', (spec) => {
  const { connector, control } = spec;
  const secret = 'whsec_test_secret';
  beforeEach(() => control.reset());

  const signed = (type: 'ORDER_CHANGE' | 'LISTINGS_ITEM_STATUS_CHANGE' | 'shipment.updated' | 'shipment.cancelled' | 'listing.updated', extra: Record<string, unknown> = {}) => {
    if (spec.code === 'amazon_in') {
      return amazonControl.signedNotification({ id: 'N-1', type: type as 'ORDER_CHANGE', orderId: 'ORD-1', orderStatus: 'Unshipped', sku: 'SKU-1', status: ['BUYABLE'], ...extra }, secret);
    }
    return flipkartControl.signedNotification({ id: 'N-1', type: type as 'shipment.updated', shipmentId: 'ORD-1', state: 'APPROVED', sku: 'SKU-1', listingState: 'ACTIVE', ...extra } as never, secret);
  };
  const orderType = spec.code === 'amazon_in' ? 'ORDER_CHANGE' : 'shipment.updated';
  const listingType = spec.code === 'amazon_in' ? 'LISTINGS_ITEM_STATUS_CHANGE' : 'listing.updated';

  it('verifies the signature over the RAW body, constant-time, and rejects everything else', () => {
    const { rawBody, headers: signedHeaders } = signed(orderType);
    const headers = signedHeaders as Record<string, string>;
    const verify = (h: Record<string, string | undefined>, body: string, sec = secret) => connector.verifyWebhook!({ headers: h, rawBody: Buffer.from(body), secret: sec });
    expect(verify(headers, rawBody)).toBe(true);
    expect(verify(headers, rawBody.replace('ORD-1', 'ORD-2'))).toBe(false); // tampered
    expect(verify(headers, rawBody, 'another-secret')).toBe(false);
    expect(verify({}, rawBody)).toBe(false); // missing header
    const header = Object.keys(headers).find((k) => k !== 'content-type')!;
    expect(verify({ [header]: 'short' }, rawBody)).toBe(false); // wrong length must not throw
    expect(verify({ [header]: headers[header]!.toUpperCase() === headers[header] ? headers[header]!.toLowerCase() + 'x' : headers[header]!.toUpperCase() }, rawBody)).toBe(false);
    expect(connector.webhook?.signatureHeader).toBe(header);
  });

  it('parses an order notification into a normalised event with a stable idempotency key', () => {
    const a = connector.parseWebhook!({ headers: {}, body: JSON.parse(signed(orderType).rawBody) })!;
    const b = connector.parseWebhook!({ headers: {}, body: JSON.parse(signed(orderType).rawBody) })!;
    expect(a).toMatchObject({ eventType: 'order.updated', externalOrderId: 'ORD-1', idempotencyKey: expect.stringContaining('N-1') });
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    const cancelled = connector.parseWebhook!({ headers: {}, body: JSON.parse(signed(orderType, spec.code === 'amazon_in' ? { orderStatus: 'Canceled' } : { state: 'CANCELLED' }).rawBody) })!;
    expect(cancelled.eventType).toBe('order.cancelled');
  });

  it('parses a listing notification into a normalised status report', () => {
    const e = connector.parseWebhook!({ headers: {}, body: JSON.parse(signed(listingType).rawBody) })!;
    expect(e).toMatchObject({ eventType: 'listing.status_changed', listing: { externalSku: 'SKU-1', status: 'active' } });
  });

  it('ignores shapes it does not understand instead of throwing', () => {
    for (const body of [null, {}, { hello: 'world' }, { NotificationMetadata: {} }, { eventId: '' }, []]) expect(connector.parseWebhook!({ headers: {}, body })).toBeNull();
  });
});
