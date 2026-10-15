/* eslint-disable @typescript-eslint/no-explicit-any -- marketplace wire payloads are untyped JSON */
import { fromMinor, SimulatedTransport, SimulatedWorld, simJson, toMinor, type SimBehavior, type SimListingStatus, type SimOrder, type SimProduct, type SimRequest, type SimSeller } from '@oms/marketplace-core';
import type { MynAttributeRule, MynRelease, MynStyle, MynStyleStatus } from './dto';

/**
 * In-process Myntra partner SANDBOX over a shared `SimulatedWorld`. The wire format is PROVISIONAL (see capabilities.ts);
 * this proves OUR code, not Myntra's behaviour. Sandbox credentials: apiKey `myn-sandbox-<partnerId>`, any non-empty apiSecret.
 */
const PAGE = 5;
const ARTICLE_TYPES: Array<{ id: string; name: string; rules: MynAttributeRule[] }> = [
  { id: 'tshirts', name: 'Tshirts', rules: [
    { field: 'name', label: 'Product name', required: true, kind: 'text', maxLen: 100 },
    { field: 'brand', label: 'Brand', required: true, kind: 'text', maxLen: 50 },
    { field: 'description', label: 'Description', required: false, kind: 'text', maxLen: 2000 },
    { field: 'color', label: 'Base colour', required: true, kind: 'text', maxLen: 30 },
    { field: 'size', label: 'Size', required: true, kind: 'list', options: ['S', 'M', 'L', 'XL'] },
  ] },
  { id: 'handbags', name: 'Handbags', rules: [
    { field: 'name', label: 'Product name', required: true, kind: 'text', maxLen: 100 },
    { field: 'brand', label: 'Brand', required: true, kind: 'text', maxLen: 50 },
    { field: 'material', label: 'Material', required: true, kind: 'text', maxLen: 40 },
  ] },
];

export const myntraWorld = new SimulatedWorld((s) => {
  s.seedCatalog(8, { skuPrefix: `MYN-${s.id}`, categoryId: 'tshirts', brand: 'SandboxBrand' });
  for (const p of s.products.values()) p.attributes = { color: 'Blue', size: 'M' };
});
for (const a of ARTICLE_TYPES) {
  myntraWorld.categories.set(a.id, { id: a.id, name: a.name, requirements: a.rules.map((r) => ({ name: r.field, required: r.required, type: r.kind === 'list' ? 'enum' : r.kind === 'text' ? 'string' : r.kind, allowed: r.options, maxLength: r.maxLen })) });
}

const STATUS: Record<SimListingStatus, MynStyleStatus> = { active: 'LIVE', pending: 'IN_REVIEW', rejected: 'REJECTED', correction_required: 'NEEDS_CHANGES', inactive: 'DISABLED' };
const dec = (minor: number) => fromMinor(minor);

const toStyle = (p: SimProduct): MynStyle => ({
  skuCode: p.sku, styleId: p.listingId, name: p.title, brand: p.brand, articleType: p.categoryId, mrp: p.mrpMinor ? dec(p.mrpMinor) : undefined, sellingPrice: dec(p.priceMinor), quantity: p.quantity,
  status: STATUS[p.status], errors: p.issues.map((i) => ({ code: i.code, message: i.message, field: i.attribute, warning: i.severity === 'warning' })), attributes: p.attributes, images: p.imageUrls,
});
const toRelease = (o: SimOrder): MynRelease => ({
  releaseId: o.id, createdOn: o.placedAt.toISOString(), modifiedOn: o.updatedAt.toISOString(), status: o.status as MynRelease['status'], paymentMode: o.payment.method === 'cod' ? 'COD' : 'PREPAID',
  customerName: o.buyer.name, customerEmail: o.buyer.email, customerMobile: o.buyer.phone,
  address: { line1: o.address.line1, city: o.address.city, state: o.address.state, zipcode: o.address.pincode, country: o.address.country },
  lines: o.items.map((i) => ({ orderLineId: i.itemId, skuCode: i.sku, name: i.title, quantity: i.quantity, unitPrice: dec(i.unitPriceMinor), tax: dec(i.taxMinor), discount: dec(i.discountMinor) })),
  ...(o.tracking ? { courier: { name: o.tracking.carrier, awb: o.tracking.number } } : {}),
});

/** allowed seller-driven transitions */
const NEXT: Record<string, string[]> = { CREATED: ['ACKNOWLEDGED'], ACKNOWLEDGED: ['PACKED'], PACKED: ['READY_TO_SHIP'], READY_TO_SHIP: ['SHIPPED'] };

export function createMyntraSimulator(world: SimulatedWorld = myntraWorld): SimulatedTransport {
  const sellerOf = (req: SimRequest): SimSeller | null => world.authenticate(req.headers['x-myntra-token']);
  const t = new SimulatedTransport((req) => {
    if (req.path === '/partner/v1/auth/login') return null;
    const seller = sellerOf(req);
    if (!seller) return simJson(401, { code: 'UNAUTHORIZED', message: 'Session token is missing, invalid or expired' });
    const fault = seller.checkBehavior();
    return fault ? { ...fault, body: { code: fault.status === 401 ? 'UNAUTHORIZED' : fault.status === 429 ? 'THROTTLED' : 'INTERNAL', message: fault.status === 401 ? 'Session token expired' : 'Simulated failure' } } : null;
  });

  t.on('POST', '/partner/v1/auth/login', (req) => {
    const m = /^myn-sandbox-(.+)$/.exec(String(req.body?.apiKey ?? ''));
    if (!m || !req.body?.apiSecret) return simJson(401, { code: 'INVALID_CREDENTIALS', message: 'Invalid API key or secret' });
    const tk = world.issueToken(m[1]!, 1800, 'mynat');
    return simJson(200, { token: tk.accessToken, expiresIn: 1800 });
  });
  t.on('GET', '/partner/v1/profile', (req) => simJson(200, { partnerId: sellerOf(req)!.id, name: `Sandbox Partner ${sellerOf(req)!.id}`, active: true }));

  // ---- releases (orders)
  t.on('GET', '/partner/v1/releases', (req) => {
    const seller = sellerOf(req)!;
    const after = req.query.modifiedAfter ? new Date(req.query.modifiedAfter) : null;
    const all = [...seller.orders.values()].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime()).filter((o) => !after || o.updatedAt >= after);
    const offset = Number(req.query.offset ?? 0);
    const limit = Math.min(Number(req.query.limit ?? PAGE), PAGE);
    return simJson(200, { releases: all.slice(offset, offset + limit).map(toRelease), total: all.length, offset });
  });
  t.on('GET', '/partner/v1/releases/:id', (req) => {
    const o = sellerOf(req)!.orders.get(req.params.id!);
    return o ? simJson(200, toRelease(o)) : simJson(404, { code: 'NOT_FOUND', message: 'Release not found' });
  });
  t.on('POST', '/partner/v1/releases/:id/status', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.params.id!);
    if (!o) return simJson(404, { code: 'NOT_FOUND', message: 'Release not found' });
    const to = String(req.body?.status);
    if (!NEXT[o.status]?.includes(to)) return simJson(409, { code: 'INVALID_TRANSITION', message: `Cannot move release from ${o.status} to ${to}` });
    if (to === 'SHIPPED') o.tracking = { number: String(req.body?.awb ?? ''), carrier: String(req.body?.courier ?? '') };
    seller.setOrderStatus(o.id, to);
    return simJson(200, { releaseId: o.id, status: to });
  });

  // ---- styles (listings)
  t.on('GET', '/partner/v1/styles', (req) => {
    const all = [...sellerOf(req)!.products.values()];
    const offset = Number(req.query.offset ?? 0);
    const limit = Math.min(Number(req.query.limit ?? PAGE), 20);
    return simJson(200, { styles: all.slice(offset, offset + limit).map(toStyle), total: all.length, offset });
  });
  t.on('GET', '/partner/v1/styles/:sku', (req) => {
    const p = sellerOf(req)!.pollListing(req.params.sku!);
    return p ? simJson(200, toStyle(p)) : simJson(404, { code: 'NOT_FOUND', message: 'Style not found' });
  });
  t.on('POST', '/partner/v1/styles', (req) => {
    const seller = sellerOf(req)!;
    const results = ((req.body?.styles ?? []) as Array<Record<string, any>>).map((s) => {
      const p = seller.submitListing({
        sku: s.skuCode, title: String(s.name ?? ''), description: s.description, brand: s.brand, barcode: s.barcode, categoryId: s.articleType,
        priceMinor: s.sellingPrice !== undefined ? toMinor(s.sellingPrice) : 0, mrpMinor: s.mrp !== undefined ? toMinor(s.mrp) : undefined, currency: 'INR', quantity: s.quantity, attributes: s.attributes ?? {}, imageUrls: s.images,
      });
      const bad = p.status === 'correction_required' || p.status === 'rejected';
      return { skuCode: p.sku, success: !bad, code: bad ? p.issues[0]?.code : undefined, message: bad ? p.issues[0]?.message : undefined, ...(bad ? { errors: p.issues.map((i) => ({ code: i.code, message: i.message, field: i.attribute, warning: i.severity === 'warning' })) } : {}) };
    });
    return simJson(200, { results });
  });
  t.on('POST', '/partner/v1/inventory', (req) => {
    const seller = sellerOf(req)!;
    const results = ((req.body?.items ?? []) as Array<{ skuCode: string; quantity: number }>).map((i) => {
      if (!seller.products.has(i.skuCode)) return { skuCode: i.skuCode, success: false, code: 'NOT_FOUND', message: 'Style not found' };
      if (!Number.isInteger(i.quantity) || i.quantity < 0) return { skuCode: i.skuCode, success: false, code: 'INVALID_QUANTITY', message: 'quantity must be a non-negative integer' };
      seller.setQuantity(i.skuCode, i.quantity);
      return { skuCode: i.skuCode, success: true };
    });
    return simJson(200, { results });
  });
  t.on('POST', '/partner/v1/prices', (req) => {
    const seller = sellerOf(req)!;
    const results = ((req.body?.items ?? []) as Array<{ skuCode: string; sellingPrice: string }>).map((i) => {
      const p = seller.products.get(i.skuCode);
      if (!p) return { skuCode: i.skuCode, success: false, code: 'NOT_FOUND', message: 'Style not found' };
      p.priceMinor = toMinor(i.sellingPrice);
      return { skuCode: i.skuCode, success: true };
    });
    return simJson(200, { results });
  });
  t.on('POST', '/partner/v1/styles/:sku/disable', (req) => {
    const p = sellerOf(req)!.products.get(req.params.sku!);
    if (!p) return simJson(404, { code: 'NOT_FOUND', message: 'Style not found' });
    p.status = 'inactive';
    return simJson(200, { skuCode: p.sku, status: 'DISABLED' });
  });

  t.on('GET', '/partner/v1/article-types', (req) => {
    const q = req.query.q?.toLowerCase();
    return simJson(200, { articleTypes: ARTICLE_TYPES.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q)).map((a) => ({ id: a.id, name: a.name })) });
  });
  t.on('GET', '/partner/v1/article-types/:id/rules', (req) => {
    const a = ARTICLE_TYPES.find((x) => x.id === req.params.id);
    return a ? simJson(200, { rules: a.rules }) : simJson(404, { code: 'NOT_FOUND', message: 'Article type not found' });
  });
  return t;
}

export const myntraSimulator = createMyntraSimulator();

export const myntraControl = {
  world: myntraWorld,
  transport: myntraSimulator,
  setBehavior: (sellerId: string, b: SimBehavior) => { myntraWorld.seller(sellerId).behavior = { ...b }; },
  calls: (sellerId: string) => myntraWorld.seller(sellerId).calls,
  placeOrder: (sellerId: string, items: Array<{ sku: string; quantity: number }>, o: { cod?: boolean } = {}) =>
    myntraWorld.seller(sellerId).placeOrder(items, { initialStatus: 'CREATED', idPrefix: 'MYN', payment: o.cod ? { method: 'cod' } : { method: 'prepaid' } }),
  setOrderStatus: (sellerId: string, orderId: string, status: string) => myntraWorld.seller(sellerId).setOrderStatus(orderId, status),
  order: (sellerId: string, orderId: string) => myntraWorld.seller(sellerId).orders.get(orderId),
  listing: (sellerId: string, sku: string) => myntraWorld.seller(sellerId).products.get(sku),
  expireTokens: () => myntraWorld.expireAllTokens(),
  reset: () => myntraWorld.reset(),
};
