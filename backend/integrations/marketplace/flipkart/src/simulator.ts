/* eslint-disable @typescript-eslint/no-explicit-any -- marketplace wire payloads are untyped JSON */
import { fromMinor, SimulatedTransport, SimulatedWorld, simJson, toMinor, type SimBehavior, type SimListingStatus, type SimOrder, type SimProduct, type SimRequest, type SimSeller } from '@oms/marketplace-core';
import type { FkAttributeDef, FkListingRecord, FkListingState, FkShipment } from './dto';
import { sign, SIGNATURE_HEADER, type FkNotification } from './webhooks';

/**
 * In-process Flipkart SANDBOX: speaks the paths/JSON the connector's real client uses over a marketplace-agnostic
 * `SimulatedWorld`. It proves OUR code, not Flipkart's behaviour.
 *
 * Sandbox credentials (self access): appId `fk-sandbox-<sellerId>`, any non-empty appSecret.
 * Sandbox authorization code: `FKsandbox:<sellerId>`. Refresh token: `fk-rt-sandbox:<sellerId>`.
 */
const PAGE_SIZE = 5;
const CATEGORIES: Array<{ id: string; name: string; attrs: FkAttributeDef[] }> = [
  { id: 'mens_tshirts', name: "Men's T-Shirts", attrs: [
    { name: 'title', displayName: 'Title', mandatory: true, type: 'TEXT', maxLength: 120 },
    { name: 'brand', displayName: 'Brand', mandatory: true, type: 'TEXT', maxLength: 50 },
    { name: 'description', displayName: 'Description', mandatory: false, type: 'TEXT', maxLength: 2000 },
    { name: 'color', displayName: 'Colour', mandatory: true, type: 'TEXT', maxLength: 30 },
    { name: 'size', displayName: 'Size', mandatory: true, type: 'ENUM', values: ['S', 'M', 'L', 'XL'] },
  ] },
  { id: 'wallets', name: 'Wallets', attrs: [
    { name: 'title', displayName: 'Title', mandatory: true, type: 'TEXT', maxLength: 120 },
    { name: 'brand', displayName: 'Brand', mandatory: true, type: 'TEXT', maxLength: 50 },
    { name: 'material', displayName: 'Material', mandatory: true, type: 'TEXT', maxLength: 40 },
  ] },
];

export const flipkartWorld = new SimulatedWorld((s) => {
  s.seedCatalog(8, { skuPrefix: `FK-${s.id}`, categoryId: 'mens_tshirts', brand: 'SandboxBrand' });
  for (const p of s.products.values()) p.attributes = { color: 'Blue', size: 'M' };
});
for (const c of CATEGORIES) {
  flipkartWorld.categories.set(c.id, { id: c.id, name: c.name, requirements: c.attrs.map((a) => ({ name: a.name, required: a.mandatory, type: a.type === 'ENUM' ? 'enum' : a.type === 'NUMBER' ? 'number' : a.type === 'BOOLEAN' ? 'boolean' : 'string', allowed: a.values, maxLength: a.maxLength })) });
}

const num = (minor: number) => Number(fromMinor(minor));
const STATE: Record<SimListingStatus, FkListingState> = { active: 'ACTIVE', pending: 'PENDING_REVIEW', rejected: 'REJECTED', correction_required: 'CORRECTION_NEEDED', inactive: 'INACTIVE' };

function toRecord(p: SimProduct): FkListingRecord {
  return {
    sku: p.sku, listingId: p.listingId, fsn: p.listingId, title: p.title, brand: p.brand, category: p.categoryId, state: STATE[p.status],
    errors: p.issues.map((i) => ({ code: i.code, message: i.message, attribute: i.attribute, level: i.severity === 'error' ? 'ERROR' : 'WARNING' })),
    price: { mrp: p.mrpMinor ? num(p.mrpMinor) : undefined, sellingPrice: num(p.priceMinor), currency: p.currency }, inventory: p.quantity, attributes: p.attributes, images: p.imageUrls,
  };
}

function toShipment(o: SimOrder): FkShipment {
  const [first = '', ...rest] = o.buyer.name.split(' ');
  return {
    shipmentId: o.id, orderDate: o.placedAt.toISOString(), updatedAt: o.updatedAt.toISOString(), paymentType: o.payment.method === 'cod' ? 'COD' : 'PREPAID',
    buyerDetails: { firstName: first, lastName: rest.join(' '), email: o.buyer.email, phone: o.buyer.phone },
    deliveryAddress: { addressLine1: o.address.line1, city: o.address.city, state: o.address.state, pinCode: o.address.pincode, country: o.address.country },
    orderItems: o.items.map((i) => ({
      orderItemId: i.itemId, orderId: o.id, sku: i.sku, title: i.title, quantity: i.quantity, status: o.status as FkShipment['orderItems'][number]['status'],
      priceComponents: { sellingPrice: num(i.unitPriceMinor), totalPrice: num(i.unitPriceMinor * i.quantity + i.taxMinor - i.discountMinor), taxAmount: num(i.taxMinor), sellerDiscount: num(i.discountMinor) },
    })),
    ...(o.tracking ? { trackingDetails: { trackingId: o.tracking.number, courierName: o.tracking.carrier } } : {}),
  };
}

const bulkError = (code: string, message: string, attribute?: string) => ({ status: 'FAILURE' as const, errors: [{ code, message, attribute }] });

export function createFlipkartSimulator(world: SimulatedWorld = flipkartWorld): SimulatedTransport {
  const sellerOf = (req: SimRequest): SimSeller | null => world.authenticate(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
  const basicId = (req: SimRequest): { id: string; secret: string } | null => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const [id, secret] = Buffer.from(m[1]!, 'base64').toString().split(':');
    return id && secret ? { id, secret } : null;
  };

  const t = new SimulatedTransport((req) => {
    if (req.path === '/oauth-service/oauth/token') return null;
    const seller = sellerOf(req);
    if (!seller) return simJson(401, { message: 'Invalid or expired access token' });
    const fault = seller.checkBehavior();
    return fault ? { ...fault, body: { message: fault.status === 401 ? 'Invalid or expired access token' : fault.status === 429 ? 'Too many requests' : 'Simulated failure' } } : null;
  });

  // ---- OAuth
  t.on('GET', '/oauth-service/oauth/token', (req) => {
    const app = basicId(req);
    if (!app) return simJson(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
    const q = req.query;
    if (q.grant_type === 'client_credentials') {
      const m = /^fk-sandbox-(.+)$/.exec(app.id);
      if (!m) return simJson(401, { error: 'invalid_client', error_description: 'Unknown application' });
      const tk = world.issueToken(m[1]!, 3600, 'fkat');
      return simJson(200, { access_token: tk.accessToken, token_type: 'bearer', expires_in: 3600, scope: 'Seller_Api' });
    }
    if (q.grant_type === 'authorization_code') {
      const m = /^FKsandbox:(.+)$/.exec(q.code ?? '');
      if (!m) return simJson(400, { error: 'invalid_grant', error_description: 'The authorization code is invalid or expired' });
      const tk = world.issueToken(m[1]!, 3600, 'fkat');
      return simJson(200, { access_token: tk.accessToken, refresh_token: `fk-rt-sandbox:${m[1]}`, token_type: 'bearer', expires_in: 3600, scope: 'Seller_Api' });
    }
    if (q.grant_type === 'refresh_token') {
      const m = /^fk-rt-sandbox:(.+)$/.exec(q.refresh_token ?? '');
      if (!m) return simJson(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid or has been revoked' });
      const tk = world.issueToken(m[1]!, 3600, 'fkat');
      return simJson(200, { access_token: tk.accessToken, token_type: 'bearer', expires_in: 3600 });
    }
    return simJson(400, { error: 'unsupported_grant_type' });
  });

  t.on('GET', '/sellers/v3/profile', (req) => {
    const seller = sellerOf(req)!;
    return simJson(200, { sellerId: seller.id, name: `Sandbox Seller ${seller.id}`, active: true });
  });

  // ---- shipments
  t.on('POST', '/sellers/v3/shipments/filter', (req) => {
    const seller = sellerOf(req)!;
    const after = req.body?.filter?.modifiedAfter ? new Date(req.body.filter.modifiedAfter) : null;
    const all = [...seller.orders.values()].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime()).filter((o) => !after || o.updatedAt >= after);
    const size = Math.min(Number(req.body?.pagination?.pageSize ?? PAGE_SIZE), PAGE_SIZE);
    const start = req.body?.pagination?.pageToken ? Number(Buffer.from(req.body.pagination.pageToken, 'base64url').toString()) || 0 : 0;
    const hasMore = start + size < all.length;
    return simJson(200, { hasMore, ...(hasMore ? { nextPageToken: Buffer.from(String(start + size)).toString('base64url') } : {}), shipments: all.slice(start, start + size).map(toShipment) });
  });
  t.on('GET', '/sellers/v3/shipments', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.query.shipmentIds ?? '');
    return o ? simJson(200, { shipments: [toShipment(o)] }) : simJson(404, { message: 'Shipment not found' });
  });
  t.on('POST', '/sellers/v3/shipments/dispatch', (req) => {
    const seller = sellerOf(req)!;
    const s = req.body?.shipments?.[0];
    const o = seller.orders.get(s?.shipmentId);
    if (!o) return simJson(404, { message: 'Shipment not found' });
    if (o.status === 'CANCELLED') return simJson(400, { message: 'Shipment is cancelled', errors: [{ code: 'INVALID_STATE', message: 'Shipment is cancelled' }] });
    if (['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(o.status)) return simJson(400, { message: 'Shipment already dispatched', errors: [{ code: 'INVALID_STATE', message: 'Shipment already dispatched' }] });
    o.tracking = { number: String(s.trackingId ?? ''), carrier: String(s.courierName ?? '') };
    seller.setOrderStatus(o.id, 'SHIPPED');
    return simJson(200, { status: 'SUCCESS' });
  });
  t.on('POST', '/sellers/v3/shipments/cancel', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.body?.shipments?.[0]?.shipmentId);
    if (!o) return simJson(404, { message: 'Shipment not found' });
    if (['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(o.status)) return simJson(400, { message: 'Shipment already dispatched', errors: [{ code: 'INVALID_STATE', message: 'Shipment already dispatched' }] });
    seller.setOrderStatus(o.id, 'CANCELLED');
    return simJson(200, { status: 'SUCCESS' });
  });

  // ---- listings
  t.on('GET', '/sellers/v3/listings', (req) => {
    const seller = sellerOf(req)!;
    const all = [...seller.products.values()];
    const size = Number(req.query.pageSize ?? 10);
    const start = req.query.pageToken ? Number(Buffer.from(req.query.pageToken, 'base64url').toString()) : 0;
    const hasMore = start + size < all.length;
    return simJson(200, { hasMore, ...(hasMore ? { nextPageToken: Buffer.from(String(start + size)).toString('base64url') } : {}), listings: all.slice(start, start + size).map(toRecord) });
  });
  t.on('GET', '/sellers/v3/listings/:sku', (req) => {
    const p = sellerOf(req)!.pollListing(req.params.sku!);
    return p ? simJson(200, toRecord(p)) : simJson(404, { message: 'Listing not found' });
  });
  t.on('POST', '/sellers/v3/listings', (req) => {
    const seller = sellerOf(req)!;
    const results: Record<string, unknown> = {};
    for (const r of (req.body?.listings ?? []) as Array<Record<string, any>>) {
      const attrs = { ...(r.attributes ?? {}), ...(r.size ? { size: r.size } : {}) } as Record<string, string | number | boolean>;
      const p = seller.submitListing({
        sku: r.sku, title: String(r.title ?? ''), description: r.description, brand: r.brand, barcode: r.barcode, categoryId: r.category,
        priceMinor: r.price?.sellingPrice !== undefined ? toMinor(r.price.sellingPrice) : 0, mrpMinor: r.price?.mrp !== undefined ? toMinor(r.price.mrp) : undefined,
        currency: r.price?.currency ?? 'INR', quantity: r.inventory, attributes: attrs, imageUrls: r.images,
      });
      results[r.sku] = p.status === 'correction_required' || p.status === 'rejected' ? { status: 'FAILURE', errors: toRecord(p).errors } : { status: 'SUCCESS', errors: toRecord(p).errors };
    }
    return simJson(200, { results });
  });
  t.on('POST', '/sellers/v3/listings/inventory', (req) => {
    const seller = sellerOf(req)!;
    const results: Record<string, unknown> = {};
    for (const i of (req.body?.items ?? []) as Array<{ sku: string; quantity: number }>) {
      const p = seller.products.get(i.sku);
      if (!p) results[i.sku] = bulkError('NOT_FOUND', 'Listing not found');
      else if (!Number.isInteger(i.quantity) || i.quantity < 0) results[i.sku] = bulkError('INVALID_QUANTITY', 'quantity must be a non-negative integer', 'inventory');
      else { seller.setQuantity(i.sku, i.quantity); results[i.sku] = { status: 'SUCCESS' }; }
    }
    return simJson(200, { results });
  });
  t.on('POST', '/sellers/v3/listings/price', (req) => {
    const seller = sellerOf(req)!;
    const results: Record<string, unknown> = {};
    for (const i of (req.body?.items ?? []) as Array<{ sku: string; sellingPrice: number }>) {
      const p = seller.products.get(i.sku);
      if (!p) results[i.sku] = bulkError('NOT_FOUND', 'Listing not found');
      else { p.priceMinor = toMinor(i.sellingPrice); results[i.sku] = { status: 'SUCCESS' }; }
    }
    return simJson(200, { results });
  });
  t.on('POST', '/sellers/v3/listings/:sku/deactivate', (req) => {
    const p = sellerOf(req)!.products.get(req.params.sku!);
    if (!p) return simJson(404, { message: 'Listing not found' });
    p.status = 'inactive';
    return simJson(200, { status: 'SUCCESS' });
  });

  // ---- categories
  t.on('GET', '/sellers/v3/categories', (req) => {
    const q = req.query.q?.toLowerCase();
    return simJson(200, { categories: CATEGORIES.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q)).map((c) => ({ id: c.id, name: c.name, path: c.name, leaf: true })) });
  });
  t.on('GET', '/sellers/v3/categories/:id/attributes', (req) => {
    const c = CATEGORIES.find((x) => x.id === req.params.id);
    return c ? simJson(200, { attributes: c.attrs }) : simJson(404, { message: 'Category not found' });
  });
  return t;
}

export const flipkartSimulator = createFlipkartSimulator();

/** Test/dev control surface */
export const flipkartControl = {
  world: flipkartWorld,
  transport: flipkartSimulator,
  setBehavior: (sellerId: string, b: SimBehavior) => { flipkartWorld.seller(sellerId).behavior = { ...b }; },
  calls: (sellerId: string) => flipkartWorld.seller(sellerId).calls,
  /** a customer buys on Flipkart: shipment appears as APPROVED */
  placeOrder: (sellerId: string, items: Array<{ sku: string; quantity: number }>, o: { cod?: boolean } = {}) =>
    flipkartWorld.seller(sellerId).placeOrder(items, { initialStatus: 'APPROVED', idPrefix: 'OD', payment: o.cod ? { method: 'cod' } : { method: 'prepaid' } }),
  setOrderStatus: (sellerId: string, orderId: string, status: string) => flipkartWorld.seller(sellerId).setOrderStatus(orderId, status),
  order: (sellerId: string, orderId: string) => flipkartWorld.seller(sellerId).orders.get(orderId),
  listing: (sellerId: string, sku: string) => flipkartWorld.seller(sellerId).products.get(sku),
  expireTokens: () => flipkartWorld.expireAllTokens(),
  signedNotification: (n: { id: string; type: FkNotification['eventType']; shipmentId?: string; state?: FkNotification['data']['state']; sku?: string; listingState?: FkListingState }, secret: string) => {
    const body: FkNotification = { eventId: n.id, eventType: n.type, occurredAt: new Date().toISOString(), data: { shipmentId: n.shipmentId, state: n.state, sku: n.sku, listingState: n.listingState } };
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(secret, rawBody) } };
  },
  reset: () => flipkartWorld.reset(),
};
