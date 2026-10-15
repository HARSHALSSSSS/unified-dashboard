import { fromMinor, SimulatedTransport, SimulatedWorld, simJson, toMinor, type SimBehavior, type SimOrder, type SimProduct, type SimRequest, type SimSeller } from '@oms/marketplace-core';
import { INDIA_MARKETPLACE_ID } from './environment';
import { PRODUCT_TYPE_REQUIREMENTS } from './capabilities';
import { sign, SIGNATURE_HEADER } from './webhooks';
import type { AmzIssue, AmzListingsItem, AmzNotification, AmzOrder, AmzOrderItem } from './dto';

/**
 * In-process Amazon SP-API SANDBOX. Speaks the same paths/JSON as the connector's real client (LWA, Orders v0,
 * Listings Items, Product Type search) over a marketplace-agnostic `SimulatedWorld`. Used for sandbox-mode accounts
 * (default target "simulator"), development and tests. It is not Amazon: it proves OUR code, not Amazon's behaviour.
 *
 * Sandbox credentials: refresh token `Atzr|sandbox:<sellerId>` (or `ANsandbox:<sellerId>` as authorization code).
 */
const ORDER_PAGE_SIZE = 5;

export const amazonWorld = new SimulatedWorld((s) => {
  s.seedCatalog(8, { skuPrefix: `AMZ-${s.id}`, categoryId: 'SHIRT', brand: 'SandboxBrand' });
  for (const p of s.products.values()) p.attributes = { color: 'Blue', size: 'M', country_of_origin: 'IN' };
});
for (const [id, reqs] of Object.entries(PRODUCT_TYPE_REQUIREMENTS)) {
  amazonWorld.categories.set(id, { id, name: id === 'SHIRT' ? 'Shirt' : 'Bag', requirements: reqs.map((r) => ({ name: r.name, required: r.required, type: r.type, allowed: r.allowedValues, maxLength: r.maxLength })) });
}

const money = (minor: number) => ({ CurrencyCode: 'INR', Amount: fromMinor(minor) });
const iso = (d: Date) => d.toISOString();

function toAmzOrder(o: SimOrder): AmzOrder {
  // Amazon's OrderTotal includes tax and is net of promotions
  const total = o.items.reduce((n, i) => n + i.unitPriceMinor * i.quantity + i.taxMinor - i.discountMinor, 0);
  return {
    AmazonOrderId: o.id, PurchaseDate: iso(o.placedAt), LastUpdateDate: iso(o.updatedAt), OrderStatus: o.status as AmzOrder['OrderStatus'], OrderTotal: money(total),
    PaymentMethod: o.payment.method === 'cod' ? 'COD' : 'Other', FulfillmentChannel: 'MFN', MarketplaceId: INDIA_MARKETPLACE_ID,
    BuyerInfo: { BuyerEmail: o.buyer.email, BuyerName: o.buyer.name },
    ShippingAddress: { Name: o.buyer.name, AddressLine1: o.address.line1, City: o.address.city, StateOrRegion: o.address.state, PostalCode: o.address.pincode, CountryCode: o.address.country, Phone: o.buyer.phone },
  };
}
const toAmzItem = (i: SimOrder['items'][number], p?: SimProduct): AmzOrderItem => ({
  ASIN: p?.listingId, SellerSKU: i.sku, OrderItemId: i.itemId, Title: i.title, QuantityOrdered: i.quantity, QuantityShipped: 0,
  ItemPrice: money(i.unitPriceMinor * i.quantity), ItemTax: money(i.taxMinor), PromotionDiscount: money(i.discountMinor),
});

/** amazon attribute structure -> flat map used by the world's validator */
function flatten(attrs: Record<string, Array<{ value?: unknown }>> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const val = v?.[0]?.value;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
  }
  return out;
}

function toListingsItem(p: SimProduct, sku: string): AmzListingsItem {
  const flags = p.status === 'active' ? ['BUYABLE', 'DISCOVERABLE'] : [];
  const issues: AmzIssue[] = p.issues.map((i) => ({ code: i.code, message: i.message, severity: i.severity === 'error' ? 'ERROR' : 'WARNING', ...(i.attribute && i.code !== 'POLICY_VIOLATION' ? { attributeNames: [i.attribute] } : {}) }));
  return {
    sku,
    summaries: [{ marketplaceId: INDIA_MARKETPLACE_ID, asin: p.listingId, productType: p.categoryId, status: flags, itemName: p.title, createdDate: iso(p.createdAt), lastUpdatedDate: iso(p.updatedAt) }],
    attributes: { item_name: [{ value: p.title }], ...(p.brand ? { brand: [{ value: p.brand }] } : {}), ...Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, [{ value: v }]])) },
    issues,
    offers: [{ marketplaceId: INDIA_MARKETPLACE_ID, offerType: 'B2C', price: { currencyCode: p.currency, amount: fromMinor(p.priceMinor) } }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: p.quantity }],
  };
}

export function createAmazonSimulator(world: SimulatedWorld = amazonWorld): SimulatedTransport {
  const sellerOf = (req: SimRequest): SimSeller | null => world.authenticate(req.headers['x-amz-access-token']);

  const t = new SimulatedTransport((req) => {
    if (req.path === '/auth/o2/token') return null; // LWA is not rate-limited by the seller behaviour below
    const seller = sellerOf(req);
    if (!seller) return simJson(403, { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] });
    const fault = seller.checkBehavior();
    return fault ? { ...fault, body: fault.status === 401 ? { errors: [{ code: 'Unauthorized', message: 'The access token you provided has expired.' }] } : fault.status === 429 ? { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] } : { errors: [{ code: 'InternalFailure', message: 'Simulated failure' }] } } : null;
  });

  // ---- LWA
  t.on('POST', '/auth/o2/token', (req) => {
    const f = req.form ?? {};
    if (!f.client_id || !f.client_secret) return simJson(400, { error: 'invalid_client', error_description: 'Client authentication failed' });
    if (f.grant_type === 'authorization_code') {
      const m = /^ANsandbox:(.+)$/.exec(f.code ?? '');
      if (!m) return simJson(400, { error: 'invalid_grant', error_description: 'The authorization code is invalid or expired' });
      const t2 = world.issueToken(m[1]!, 3600, 'Atza|sim');
      return simJson(200, { access_token: t2.accessToken, refresh_token: `Atzr|sandbox:${m[1]}`, token_type: 'bearer', expires_in: 3600 });
    }
    if (f.grant_type === 'refresh_token') {
      const m = /^Atzr\|sandbox:(.+)$/.exec(f.refresh_token ?? '');
      if (!m) return simJson(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid or has been revoked' });
      const t2 = world.issueToken(m[1]!, 3600, 'Atza|sim');
      return simJson(200, { access_token: t2.accessToken, token_type: 'bearer', expires_in: 3600 });
    }
    return simJson(400, { error: 'unsupported_grant_type' });
  });

  t.on('GET', '/sellers/v1/marketplaceParticipations', () =>
    simJson(200, { payload: [{ marketplace: { id: INDIA_MARKETPLACE_ID, countryCode: 'IN', name: 'Amazon.in', defaultCurrencyCode: 'INR', defaultLanguageCode: 'en_IN', domainName: 'www.amazon.in' }, participation: { isParticipating: true, hasSuspendedListings: false } }] }, { 'x-amzn-ratelimit-limit': '0.0167' }));

  // ---- Orders v0
  t.on('GET', '/orders/v0/orders', (req) => {
    const seller = sellerOf(req)!;
    const all = [...seller.orders.values()].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    let list = all;
    let start = 0;
    if (req.query.NextToken) start = Number(Buffer.from(req.query.NextToken, 'base64url').toString()) || 0;
    else if (req.query.LastUpdatedAfter) list = all.filter((o) => o.updatedAt >= new Date(req.query.LastUpdatedAfter!));
    const page = list.slice(start, start + ORDER_PAGE_SIZE);
    const next = start + ORDER_PAGE_SIZE < list.length ? Buffer.from(String(start + ORDER_PAGE_SIZE)).toString('base64url') : undefined;
    return simJson(200, { payload: { Orders: page.map((o) => toAmzOrder(o)), ...(next ? { NextToken: next } : {}) } }, { 'x-amzn-ratelimit-limit': '0.0167' });
  });
  t.on('GET', '/orders/v0/orders/:id', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.params.id!);
    return o ? simJson(200, { payload: toAmzOrder(o) }) : simJson(404, { errors: [{ code: 'NotFound', message: 'Order not found' }] });
  });
  t.on('GET', '/orders/v0/orders/:id/orderItems', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.params.id!);
    if (!o) return simJson(404, { errors: [{ code: 'NotFound', message: 'Order not found' }] });
    return simJson(200, { payload: { AmazonOrderId: o.id, OrderItems: o.items.map((i) => toAmzItem(i, seller.products.get(i.sku))) } });
  });
  t.on('POST', '/orders/v0/orders/:id/shipmentConfirmation', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.params.id!);
    if (!o) return simJson(404, { errors: [{ code: 'NotFound', message: 'Order not found' }] });
    if (o.status === 'Canceled') return simJson(400, { errors: [{ code: 'InvalidInput', message: 'Order is cancelled' }] });
    if (['Shipped', 'PartiallyShipped', 'InvoiceUnconfirmed'].includes(o.status)) return simJson(400, { errors: [{ code: 'InvalidInput', message: 'Order is already shipped' }] });
    const pkg = req.body?.packageDetail;
    o.tracking = { number: String(pkg?.trackingNumber ?? ''), carrier: String(pkg?.carrierName ?? '') };
    seller.setOrderStatus(o.id, 'Shipped');
    return { status: 204 };
  });

  // ---- Listings Items
  const itemRoute = '/listings/2021-08-01/items/:sellerId/:sku';
  t.on('GET', itemRoute, (req) => {
    const seller = sellerOf(req)!;
    const p = seller.pollListing(req.params.sku!);
    return p ? simJson(200, toListingsItem(p, p.sku)) : simJson(404, { errors: [{ code: 'NOT_FOUND', message: 'Listing not found' }] });
  });
  t.on('PUT', itemRoute, (req) => {
    const seller = sellerOf(req)!;
    const attrs = flatten(req.body?.attributes);
    const offer = req.body?.attributes?.purchasable_offer?.[0];
    const price = offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
    const list = offer?.list_price?.[0]?.value_with_tax;
    const p = seller.submitListing({
      sku: req.params.sku!, title: String(attrs.item_name ?? ''), description: attrs.product_description as string | undefined, brand: attrs.brand as string | undefined,
      categoryId: req.body?.productType, priceMinor: price !== undefined ? toMinor(price) : 0, mrpMinor: list !== undefined ? toMinor(list) : undefined, currency: offer?.currency ?? 'INR',
      quantity: req.body?.attributes?.fulfillment_availability?.[0]?.quantity, attributes: attrs, barcode: req.body?.attributes?.externally_assigned_product_identifier?.[0]?.value,
    });
    const invalid = p.status === 'correction_required' || p.status === 'rejected';
    return simJson(200, { sku: p.sku, status: invalid ? 'INVALID' : 'ACCEPTED', submissionId: `sub-${Date.now()}`, issues: toListingsItem(p, p.sku).issues });
  });
  t.on('PATCH', itemRoute, (req) => {
    const seller = sellerOf(req)!;
    const p = seller.products.get(req.params.sku!);
    if (!p) return simJson(404, { errors: [{ code: 'NOT_FOUND', message: 'Listing not found' }] });
    for (const patch of req.body?.patches ?? []) {
      if (patch.path === '/attributes/fulfillment_availability') {
        const q = Number(patch.value?.[0]?.quantity);
        if (!Number.isInteger(q) || q < 0) return simJson(400, { errors: [{ code: 'InvalidInput', message: 'quantity must be a non-negative integer' }] });
        seller.setQuantity(p.sku, q);
      } else if (patch.path === '/attributes/purchasable_offer') {
        p.priceMinor = toMinor(patch.value?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax);
      }
    }
    return simJson(200, { sku: p.sku, status: 'ACCEPTED', submissionId: `sub-${Date.now()}`, issues: [] });
  });
  t.on('DELETE', itemRoute, (req) => {
    const seller = sellerOf(req)!;
    const p = seller.products.get(req.params.sku!);
    if (!p) return simJson(404, { errors: [{ code: 'NOT_FOUND', message: 'Listing not found' }] });
    seller.products.delete(p.sku);
    return simJson(200, { sku: p.sku, status: 'ACCEPTED', submissionId: `sub-${Date.now()}`, issues: [] });
  });
  t.on('GET', '/listings/2021-08-01/items/:sellerId', (req) => {
    const seller = sellerOf(req)!;
    const all = [...seller.products.values()];
    const size = Number(req.query.pageSize ?? 10);
    const start = req.query.pageToken ? Number(Buffer.from(req.query.pageToken, 'base64url').toString()) : 0;
    const items = all.slice(start, start + size).map((p) => toListingsItem(p, p.sku));
    const next = start + size < all.length ? Buffer.from(String(start + size)).toString('base64url') : undefined;
    return simJson(200, { numberOfResults: all.length, ...(next ? { pagination: { nextToken: next } } : {}), items });
  });

  // ---- Product type definitions (search)
  t.on('GET', '/definitions/2020-09-01/productTypes', (req) => {
    const q = req.query.keywords?.toLowerCase();
    const types = [...world.categories.values()].filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
    return simJson(200, { productTypes: types.map((c) => ({ name: c.id, displayName: c.name, marketplaceIds: [INDIA_MARKETPLACE_ID] })) });
  });
  return t;
}

export const amazonSimulator = createAmazonSimulator();

/** Test/dev control surface */
export const amazonControl = {
  world: amazonWorld,
  transport: amazonSimulator,
  setBehavior: (sellerId: string, b: SimBehavior) => { amazonWorld.seller(sellerId).behavior = { ...b }; },
  calls: (sellerId: string) => amazonWorld.seller(sellerId).calls,
  /** a customer buys on Amazon.in: order appears as "Unshipped" */
  placeOrder: (sellerId: string, items: Array<{ sku: string; quantity: number }>, o: { cod?: boolean } = {}) =>
    amazonWorld.seller(sellerId).placeOrder(items, { initialStatus: 'Unshipped', idPrefix: '402', payment: o.cod ? { method: 'cod' } : { method: 'prepaid' } }),
  setOrderStatus: (sellerId: string, orderId: string, status: string) => amazonWorld.seller(sellerId).setOrderStatus(orderId, status),
  order: (sellerId: string, orderId: string) => amazonWorld.seller(sellerId).orders.get(orderId),
  listing: (sellerId: string, sku: string) => amazonWorld.seller(sellerId).products.get(sku),
  expireTokens: () => amazonWorld.expireAllTokens(),
  /** a notification exactly as the ingress bridge would forward it (signed with the account's webhook secret) */
  signedNotification: (n: { id: string; type: 'ORDER_CHANGE' | 'LISTINGS_ITEM_STATUS_CHANGE'; orderId?: string; orderStatus?: string; sellerId?: string; sku?: string; status?: string[] }, secret: string) => {
    const body: AmzNotification = {
      NotificationVersion: '1.0', NotificationType: n.type, EventTime: new Date().toISOString(),
      NotificationMetadata: { ApplicationId: 'sandbox-app', SubscriptionId: 'sub-1', PublishTime: new Date().toISOString(), NotificationId: n.id },
      Payload: n.type === 'ORDER_CHANGE'
        ? { OrderChangeNotification: { AmazonOrderId: n.orderId!, OrderStatus: (n.orderStatus ?? 'Unshipped') as AmzOrder['OrderStatus'] } }
        : { ListingsItemStatusChangeNotification: { SellerId: n.sellerId ?? '', Sku: n.sku!, Status: n.status ?? ['BUYABLE'] } },
    };
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(secret, rawBody) } };
  },
  reset: () => amazonWorld.reset(),
};
