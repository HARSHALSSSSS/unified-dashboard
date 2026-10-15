/* eslint-disable @typescript-eslint/no-explicit-any -- marketplace wire payloads are untyped JSON */
import { SimulatedTransport, SimulatedWorld, simJson, toMinor, type SimBehavior, type SimListingStatus, type SimOrder, type SimProduct, type SimRequest, type SimSeller } from '@oms/marketplace-core';
import type { SdFieldRule, SdOrder, SdOrderState, SdProduct, SdProductState } from './dto';

/**
 * In-process Snapdeal seller SANDBOX over a shared `SimulatedWorld`. The wire format is PROVISIONAL (see capabilities.ts);
 * this proves OUR code, not Snapdeal's behaviour. Sandbox credentials: sellerId `<id>`, authToken `sd-sandbox-<id>`.
 */
const PAGE = 5;
const CATEGORIES: Array<{ id: string; name: string; fields: SdFieldRule[] }> = [
  { id: 'mens-apparel', name: "Men's Apparel", fields: [
    { key: 'productName', title: 'Product name', mandatory: true, dataType: 'STRING', max: 150 },
    { key: 'brand', title: 'Brand', mandatory: true, dataType: 'STRING', max: 50 },
    { key: 'description', title: 'Description', mandatory: false, dataType: 'STRING', max: 2000 },
    { key: 'color', title: 'Colour', mandatory: true, dataType: 'STRING', max: 30 },
    { key: 'size', title: 'Size', mandatory: true, dataType: 'LIST', allowed: ['S', 'M', 'L', 'XL'] },
  ] },
  { id: 'bags', name: 'Bags', fields: [
    { key: 'productName', title: 'Product name', mandatory: true, dataType: 'STRING', max: 150 },
    { key: 'brand', title: 'Brand', mandatory: true, dataType: 'STRING', max: 50 },
    { key: 'material', title: 'Material', mandatory: true, dataType: 'STRING', max: 40 },
  ] },
];

export const snapdealWorld = new SimulatedWorld((s) => {
  s.seedCatalog(8, { skuPrefix: `SD-${s.id}`, categoryId: 'mens-apparel', brand: 'SandboxBrand' });
  for (const p of s.products.values()) p.attributes = { color: 'Blue', size: 'M' };
});
for (const c of CATEGORIES) {
  snapdealWorld.categories.set(c.id, { id: c.id, name: c.name, requirements: c.fields.map((f) => ({ name: f.key, required: f.mandatory, type: f.dataType === 'LIST' ? 'enum' : f.dataType === 'NUMBER' ? 'number' : f.dataType === 'BOOLEAN' ? 'boolean' : 'string', allowed: f.allowed, maxLength: f.max })) });
}

const STATE: Record<SimListingStatus, SdProductState> = { active: 'LIVE', pending: 'QC_PENDING', rejected: 'QC_FAILED', correction_required: 'NEEDS_INFO', inactive: 'INACTIVE' };
const rupees = (minor: number) => minor / 100;

const toProduct = (p: SimProduct): SdProduct => ({
  sellerSku: p.sku, supc: p.listingId, productName: p.title, brand: p.brand, categoryId: p.categoryId, mrp: p.mrpMinor ? rupees(p.mrpMinor) : undefined, sellingPrice: rupees(p.priceMinor), stock: p.quantity,
  state: STATE[p.status], issues: p.issues.map((i) => ({ code: i.code, message: i.message, field: i.attribute, advisory: i.severity === 'warning' })), attributes: p.attributes, images: p.imageUrls,
});
const toOrder = (o: SimOrder): SdOrder => ({
  orderCode: o.id, orderDate: o.placedAt.toISOString(), lastUpdated: o.updatedAt.toISOString(), state: o.status as SdOrderState, paymentType: o.payment.method === 'cod' ? 'COD' : 'ONLINE',
  customer: { name: o.buyer.name, email: o.buyer.email, mobile: o.buyer.phone },
  shipTo: { address: o.address.line1, city: o.address.city, state: o.address.state, pincode: o.address.pincode, country: o.address.country },
  suborders: o.items.map((i) => ({ suborderCode: i.itemId, sellerSku: i.sku, productName: i.title, qty: i.quantity, sellingPrice: rupees(i.unitPriceMinor), taxAmount: rupees(i.taxMinor), discount: rupees(i.discountMinor) })),
  ...(o.tracking ? { awb: { courier: o.tracking.carrier, number: o.tracking.number } } : {}),
});

const NEXT: Record<string, string[]> = {
  NEW: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['PACKED', 'CANCELLED'], PACKED: ['MANIFESTED', 'CANCELLED'], MANIFESTED: ['HANDED_OVER', 'CANCELLED'],
};

export function createSnapdealSimulator(world: SimulatedWorld = snapdealWorld): SimulatedTransport {
  const sellerOf = (req: SimRequest): SimSeller | null => {
    const id = req.headers['x-seller-id'];
    return id && req.headers['x-auth-token'] === `sd-sandbox-${id}` ? world.seller(id) : null;
  };
  const t = new SimulatedTransport((req) => {
    const seller = sellerOf(req);
    if (!seller) return simJson(401, { errorCode: 'AUTH_FAILED', errorMessage: 'Invalid seller id or auth token' });
    const fault = seller.checkBehavior();
    return fault ? { ...fault, body: { errorCode: fault.status === 401 ? 'AUTH_FAILED' : fault.status === 429 ? 'THROTTLED' : 'INTERNAL', errorMessage: fault.status === 401 ? 'Auth token rejected' : 'Simulated failure' } } : null;
  });

  t.on('GET', '/seller/v1/profile', (req) => simJson(200, { sellerId: sellerOf(req)!.id, storeName: `Sandbox Store ${sellerOf(req)!.id}`, active: true }));

  // ---- orders (page-number pagination)
  t.on('GET', '/seller/v1/orders', (req) => {
    const seller = sellerOf(req)!;
    const since = req.query.updatedSince ? new Date(req.query.updatedSince) : null;
    const all = [...seller.orders.values()].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime()).filter((o) => !since || o.updatedAt >= since);
    const size = Math.min(Number(req.query.pageSize ?? PAGE), PAGE);
    const page = Math.max(1, Number(req.query.page ?? 1));
    return simJson(200, { orders: all.slice((page - 1) * size, page * size).map(toOrder), page, pageSize: size, totalPages: Math.max(1, Math.ceil(all.length / size)) });
  });
  t.on('GET', '/seller/v1/orders/:code', (req) => {
    const o = sellerOf(req)!.orders.get(req.params.code!);
    return o ? simJson(200, toOrder(o)) : simJson(404, { errorCode: 'NOT_FOUND', errorMessage: 'Order not found' });
  });
  t.on('PUT', '/seller/v1/orders/:code/state', (req) => {
    const seller = sellerOf(req)!;
    const o = seller.orders.get(req.params.code!);
    if (!o) return simJson(404, { errorCode: 'NOT_FOUND', errorMessage: 'Order not found' });
    const to = String(req.body?.state);
    if (!NEXT[o.status]?.includes(to)) return simJson(409, { errorCode: 'INVALID_STATE_CHANGE', errorMessage: `Cannot move order from ${o.status} to ${to}` });
    if (to === 'HANDED_OVER') o.tracking = { number: String(req.body?.awb ?? ''), carrier: String(req.body?.courier ?? '') };
    seller.setOrderStatus(o.id, to);
    return simJson(200, { orderCode: o.id, state: to });
  });

  // ---- products (page-number pagination)
  t.on('GET', '/seller/v1/products', (req) => {
    const all = [...sellerOf(req)!.products.values()];
    const size = Math.min(Number(req.query.pageSize ?? PAGE), 20);
    const page = Math.max(1, Number(req.query.page ?? 1));
    return simJson(200, { products: all.slice((page - 1) * size, page * size).map(toProduct), page, totalPages: Math.max(1, Math.ceil(all.length / size)) });
  });
  t.on('GET', '/seller/v1/products/:sku', (req) => {
    const p = sellerOf(req)!.pollListing(req.params.sku!);
    return p ? simJson(200, toProduct(p)) : simJson(404, { errorCode: 'NOT_FOUND', errorMessage: 'Product not found' });
  });
  t.on('POST', '/seller/v1/products', (req) => {
    const seller = sellerOf(req)!;
    const results = ((req.body?.products ?? []) as Array<Record<string, any>>).map((s) => {
      const p = seller.submitListing({
        sku: s.sellerSku, title: String(s.productName ?? ''), description: s.description, brand: s.brand, barcode: s.barcode, categoryId: s.categoryId,
        priceMinor: s.sellingPrice !== undefined ? toMinor(s.sellingPrice) : 0, mrpMinor: s.mrp !== undefined ? toMinor(s.mrp) : undefined, currency: 'INR', quantity: s.stock, attributes: s.attributes ?? {}, imageUrls: s.images,
      });
      const bad = p.status === 'correction_required' || p.status === 'rejected';
      return { sellerSku: p.sku, ok: !bad, errorCode: bad ? p.issues[0]?.code : undefined, errorMessage: bad ? p.issues[0]?.message : undefined, ...(bad ? { issues: p.issues.map((i) => ({ code: i.code, message: i.message, field: i.attribute, advisory: i.severity === 'warning' })) } : {}) };
    });
    return simJson(200, { results });
  });
  t.on('POST', '/seller/v1/stock/bulk', (req) => {
    const seller = sellerOf(req)!;
    const results = ((req.body?.items ?? []) as Array<{ sellerSku: string; stock: number }>).map((i) => {
      if (!seller.products.has(i.sellerSku)) return { sellerSku: i.sellerSku, ok: false, errorCode: 'NOT_FOUND', errorMessage: 'Product not found' };
      if (!Number.isInteger(i.stock) || i.stock < 0) return { sellerSku: i.sellerSku, ok: false, errorCode: 'INVALID_STOCK', errorMessage: 'stock must be a non-negative integer' };
      seller.setQuantity(i.sellerSku, i.stock);
      return { sellerSku: i.sellerSku, ok: true };
    });
    return simJson(200, { results });
  });
  t.on('POST', '/seller/v1/prices/bulk', (req) => {
    const seller = sellerOf(req)!;
    const results = ((req.body?.items ?? []) as Array<{ sellerSku: string; sellingPrice: number }>).map((i) => {
      const p = seller.products.get(i.sellerSku);
      if (!p) return { sellerSku: i.sellerSku, ok: false, errorCode: 'NOT_FOUND', errorMessage: 'Product not found' };
      p.priceMinor = toMinor(i.sellingPrice);
      return { sellerSku: i.sellerSku, ok: true };
    });
    return simJson(200, { results });
  });
  t.on('PUT', '/seller/v1/products/:sku/deactivate', (req) => {
    const p = sellerOf(req)!.products.get(req.params.sku!);
    if (!p) return simJson(404, { errorCode: 'NOT_FOUND', errorMessage: 'Product not found' });
    p.status = 'inactive';
    return simJson(200, { sellerSku: p.sku, state: 'INACTIVE' });
  });

  t.on('GET', '/seller/v1/categories', (req) => {
    const q = req.query.q?.toLowerCase();
    return simJson(200, { categories: CATEGORIES.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q)).map((c) => ({ id: c.id, name: c.name, path: c.name })) });
  });
  t.on('GET', '/seller/v1/categories/:id/fields', (req) => {
    const c = CATEGORIES.find((x) => x.id === req.params.id);
    return c ? simJson(200, { fields: c.fields }) : simJson(404, { errorCode: 'NOT_FOUND', errorMessage: 'Category not found' });
  });
  return t;
}

export const snapdealSimulator = createSnapdealSimulator();

export const snapdealControl = {
  world: snapdealWorld,
  transport: snapdealSimulator,
  setBehavior: (sellerId: string, b: SimBehavior) => { snapdealWorld.seller(sellerId).behavior = { ...b }; },
  calls: (sellerId: string) => snapdealWorld.seller(sellerId).calls,
  placeOrder: (sellerId: string, items: Array<{ sku: string; quantity: number }>, o: { cod?: boolean } = {}) =>
    snapdealWorld.seller(sellerId).placeOrder(items, { initialStatus: 'NEW', idPrefix: 'SD', payment: o.cod ? { method: 'cod' } : { method: 'prepaid' } }),
  setOrderStatus: (sellerId: string, orderId: string, status: string) => snapdealWorld.seller(sellerId).setOrderStatus(orderId, status),
  order: (sellerId: string, orderId: string) => snapdealWorld.seller(sellerId).orders.get(orderId),
  listing: (sellerId: string, sku: string) => snapdealWorld.seller(sellerId).products.get(sku),
  /** Snapdeal tokens are static: nothing to expire, so this is a no-op kept for a uniform control surface */
  expireTokens: () => undefined,
  reset: () => snapdealWorld.reset(),
};
