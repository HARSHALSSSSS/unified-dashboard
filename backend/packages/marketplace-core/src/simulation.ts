import type { HttpRequest, HttpResponse, HttpTransport } from './http';

/**
 * In-process marketplace SIMULATION used for sandbox mode, development and tests.
 *
 * `SimulatedWorld` is a tiny, marketplace-agnostic model of a seller account (catalogue with a listing review
 * lifecycle, stock, orders, scripted failures). Each connector ships a simulator that exposes that world through
 * ITS marketplace's wire format (paths, JSON shapes, status words, auth) on a `SimulatedTransport`, so the connector's
 * client, mappers and error handling are exercised exactly as they would be against the real HTTP API.
 * It is a simulator, not the marketplace: passing against it proves our code, never the marketplace's behaviour.
 */

// ---------------------------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------------------------
export interface SimRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  form: Record<string, string> | null;
  params: Record<string, string>;
}
export interface SimResponse { status: number; body?: unknown; headers?: Record<string, string> }
export type SimHandler = (req: SimRequest) => SimResponse | Promise<SimResponse>;

export const simJson = (status: number, body: unknown, headers: Record<string, string> = {}): SimResponse => ({ status, body, headers });

export class SimulatedTransport implements HttpTransport {
  private readonly routes: Array<{ method: string; segs: string[]; handler: SimHandler }> = [];
  /** recorded requests (most recent 500) for assertions */
  readonly requests: Array<{ method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown }> = [];

  /** `guard` runs before every handler: authentication, fault injection, rate limiting */
  constructor(private readonly guard?: (req: SimRequest) => SimResponse | null | Promise<SimResponse | null>) {}

  on(method: string, pattern: string, handler: SimHandler): this {
    this.routes.push({ method: method.toUpperCase(), segs: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const segs = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const r of this.routes) {
      if (r.method !== req.method || r.segs.length !== segs.length) continue;
      const params: Record<string, string> = {};
      if (!r.segs.every((s, i) => (s.startsWith(':') ? ((params[s.slice(1)] = segs[i]!), true) : s === segs[i]))) continue;
      const simReq: SimRequest = { method: req.method, path: url.pathname, query, headers, body: req.json ?? null, form: req.form ?? null, params };
      this.requests.push({ method: req.method, path: url.pathname, query, headers, body: req.json ?? req.form ?? null });
      if (this.requests.length > 500) this.requests.shift();
      const blocked = await this.guard?.(simReq);
      const res = blocked ?? (await r.handler(simReq));
      return toHttp(res);
    }
    return toHttp(simJson(404, { message: `No simulated route for ${req.method} ${url.pathname}` }));
  }
}

function toHttp(res: SimResponse): HttpResponse {
  const text = res.body === undefined ? '' : typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  return { status: res.status, headers: Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: res.body === undefined ? null : JSON.parse(JSON.stringify(res.body)), text };
}

// ---------------------------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------------------------
export interface SimRequirement { name: string; required: boolean; type: 'string' | 'number' | 'boolean' | 'enum'; allowed?: string[]; maxLength?: number; description?: string }
export interface SimCategory { id: string; name: string; parentId?: string | null; requirements: SimRequirement[] }
export type SimListingStatus = 'active' | 'pending' | 'rejected' | 'correction_required' | 'inactive';
export interface SimIssue { code: string; message: string; attribute?: string; severity: 'error' | 'warning' }

export interface SimProduct {
  listingId: string;
  sku: string;
  title: string;
  description?: string;
  brand?: string;
  barcode?: string;
  categoryId?: string;
  priceMinor: number;
  mrpMinor?: number;
  currency: string;
  quantity: number;
  status: SimListingStatus;
  issues: SimIssue[];
  attributes: Record<string, string | number | boolean>;
  imageUrls: string[];
  pendingPolls: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SimOrderItem { itemId: string; sku: string; title: string; quantity: number; unitPriceMinor: number; taxMinor: number; discountMinor: number }
export interface SimOrder {
  id: string;
  /** the marketplace's NATIVE status word */
  status: string;
  placedAt: Date;
  updatedAt: Date;
  currency: string;
  buyer: { name: string; email: string; phone: string };
  address: { line1: string; city: string; state: string; pincode: string; country: string };
  payment: { method: 'prepaid' | 'cod'; codAmountMinor?: number };
  items: SimOrderItem[];
  tracking?: { number: string; carrier: string };
  history: Array<{ status: string; at: Date }>;
}

/** Scripted misbehaviour for the NEXT calls on a seller. */
export interface SimBehavior {
  failNext?: number;
  failStatus?: number;
  rateLimitNext?: number;
  retryAfterSec?: number;
  authFailNext?: number;
}

export interface SimListingSubmission {
  sku: string; title: string; description?: string; brand?: string; barcode?: string; categoryId?: string; priceMinor: number; mrpMinor?: number;
  currency: string; quantity?: number; attributes?: Record<string, string | number | boolean>; imageUrls?: string[];
}

const BANNED = /\b(counterfeit|replica|fake)\b/i;

export class SimSeller {
  readonly products = new Map<string, SimProduct>();
  readonly orders = new Map<string, SimOrder>();
  behavior: SimBehavior = {};
  calls = 0;
  /** events a real marketplace would push (webhook / notification) */
  readonly webhookQueue: Array<{ type: string; payload: Record<string, unknown> }> = [];
  private listingSeq = 1000;
  private orderSeq = 5000;
  private itemSeq = 1;

  constructor(readonly id: string, readonly world: SimulatedWorld) {}

  /** Applies scripted faults. Returns an error response, or null to proceed. Counts the call. */
  checkBehavior(): SimResponse | null {
    this.calls++;
    const b = this.behavior;
    if (b.authFailNext && b.authFailNext > 0) { b.authFailNext--; return simJson(401, { message: 'Access token invalid or expired' }); }
    if (b.rateLimitNext && b.rateLimitNext > 0) { b.rateLimitNext--; return simJson(429, { message: 'Too many requests' }, { 'retry-after': String(b.retryAfterSec ?? 1) }); }
    if (b.failNext && b.failNext > 0) { b.failNext--; return simJson(b.failStatus ?? 503, { message: 'Simulated upstream failure' }); }
    return null;
  }

  seedCatalog(count: number, o: { skuPrefix: string; categoryId: string; brand?: string }): void {
    for (let i = 1; i <= count; i++) {
      const sku = `${o.skuPrefix}-${String(i).padStart(3, '0')}`;
      this.products.set(sku, {
        listingId: `${o.skuPrefix}-L${this.listingSeq++}`, sku, title: `Sandbox listing number ${i} for testing`, brand: o.brand ?? 'SandboxBrand', categoryId: o.categoryId,
        priceMinor: 49_900 + i * 1_000, mrpMinor: 69_900 + i * 1_000, currency: 'INR', quantity: 10 * i, status: 'active', issues: [],
        attributes: { color: i % 2 ? 'Blue' : 'Red' }, imageUrls: [`https://sandbox.example.invalid/img/${sku}.jpg`], pendingPolls: 0, createdAt: this.world.now(), updatedAt: this.world.now(),
      });
    }
  }

  /** Create or update a listing; validates against the category's requirements like a real catalogue review would. */
  submitListing(s: SimListingSubmission): SimProduct {
    const existing = this.products.get(s.sku);
    const issues = this.validate(s);
    const hardReject = BANNED.test(`${s.title} ${s.description ?? ''}`);
    const hasError = issues.some((i) => i.severity === 'error');
    const status: SimListingStatus = hardReject ? 'rejected' : hasError ? 'correction_required' : this.world.publishDelayPolls > 0 ? 'pending' : 'active';
    if (hardReject) issues.push({ code: 'POLICY_VIOLATION', message: 'Listing violates marketplace policy', severity: 'error' });
    const now = this.world.now();
    const p: SimProduct = {
      listingId: existing?.listingId ?? `${this.id}-L${this.listingSeq++}`, sku: s.sku, title: s.title, description: s.description, brand: s.brand, barcode: s.barcode,
      categoryId: s.categoryId, priceMinor: s.priceMinor, mrpMinor: s.mrpMinor, currency: s.currency, quantity: s.quantity ?? existing?.quantity ?? 0,
      status, issues, attributes: s.attributes ?? {}, imageUrls: s.imageUrls ?? [], pendingPolls: status === 'pending' ? this.world.publishDelayPolls : 0,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.products.set(s.sku, p);
    return p;
  }

  private validate(s: SimListingSubmission): SimIssue[] {
    const issues: SimIssue[] = [];
    const err = (code: string, message: string, attribute?: string) => issues.push({ code, message, attribute, severity: 'error' });
    if (s.title.trim().length < 10) err('TITLE_TOO_SHORT', 'Title must be at least 10 characters', 'title');
    if (s.title.length > 200) err('TITLE_TOO_LONG', 'Title must be at most 200 characters', 'title');
    if (!(s.priceMinor > 0)) err('INVALID_PRICE', 'Price must be greater than zero', 'price');
    const cat = s.categoryId ? this.world.categories.get(s.categoryId) : undefined;
    if (!cat) { err('INVALID_CATEGORY', `Unknown category ${s.categoryId ?? '(none)'}`, 'category'); return issues; }
    for (const r of cat.requirements) {
      const v = s.attributes?.[r.name];
      if (v === undefined || v === null || v === '') { if (r.required) err('MISSING_ATTRIBUTE', `Required attribute "${r.name}" is missing`, r.name); continue; }
      if (r.type === 'enum' && r.allowed && !r.allowed.includes(String(v))) err('INVALID_VALUE', `"${r.name}" must be one of: ${r.allowed.join(', ')}`, r.name);
      if (r.type === 'number' && Number.isNaN(Number(v))) err('INVALID_VALUE', `"${r.name}" must be a number`, r.name);
      if (r.maxLength && String(v).length > r.maxLength) err('VALUE_TOO_LONG', `"${r.name}" exceeds ${r.maxLength} characters`, r.name);
    }
    return issues;
  }

  /** One review "tick": pending listings move towards active. Called whenever the marketplace is asked for the status. */
  pollListing(sku: string): SimProduct | undefined {
    const p = this.products.get(sku);
    if (p && p.status === 'pending') {
      p.pendingPolls = Math.max(0, p.pendingPolls - 1);
      if (p.pendingPolls === 0) { p.status = 'active'; p.updatedAt = this.world.now(); this.webhookQueue.push({ type: 'listing.status_changed', payload: { sku, status: 'active', listingId: p.listingId } }); }
    }
    return p;
  }

  setQuantity(sku: string, quantity: number): boolean {
    const p = this.products.get(sku);
    if (!p) return false;
    p.quantity = Math.max(0, quantity);
    p.updatedAt = this.world.now();
    return true;
  }

  /** A customer buys: the marketplace creates the order in ITS initial native status and lowers its displayed stock. */
  placeOrder(items: Array<{ sku: string; quantity: number }>, o: { initialStatus: string; payment?: SimOrder['payment']; idPrefix?: string; buyerName?: string } ): SimOrder {
    const lines: SimOrderItem[] = items.map((it) => {
      const p = this.products.get(it.sku);
      if (!p) throw new Error(`Sandbox has no listing for SKU ${it.sku}`);
      p.quantity = Math.max(0, p.quantity - it.quantity);
      return { itemId: `I${this.itemSeq++}`, sku: it.sku, title: p.title, quantity: it.quantity, unitPriceMinor: p.priceMinor, taxMinor: Math.round(p.priceMinor * it.quantity * 0.05), discountMinor: 0 };
    });
    const now = this.world.now();
    const id = `${o.idPrefix ?? 'ORD'}-${this.orderSeq++}`;
    const order: SimOrder = {
      id, status: o.initialStatus, placedAt: now, updatedAt: now, currency: 'INR',
      buyer: { name: o.buyerName ?? 'Sandbox Buyer', email: 'buyer@sandbox.example.invalid', phone: '+910000000000' },
      address: { line1: '12 Test Street', city: 'Bengaluru', state: 'KA', pincode: '560001', country: 'IN' },
      payment: o.payment ?? { method: 'prepaid' }, items: lines, history: [{ status: o.initialStatus, at: now }],
    };
    this.orders.set(id, order);
    this.webhookQueue.push({ type: 'order.created', payload: { orderId: id } });
    return order;
  }

  setOrderStatus(id: string, status: string): SimOrder | undefined {
    const o = this.orders.get(id);
    if (!o) return undefined;
    o.status = status;
    o.updatedAt = this.world.now();
    o.history.push({ status, at: o.updatedAt });
    this.webhookQueue.push({ type: 'order.updated', payload: { orderId: id, status } });
    return o;
  }
}

export class SimulatedWorld {
  readonly sellers = new Map<string, SimSeller>();
  readonly categories = new Map<string, SimCategory>();
  /** access token -> { sellerId, exp } */
  readonly accessTokens = new Map<string, { sellerId: string; exp: number }>();
  readonly refreshTokens = new Map<string, string>();
  /** how many status checks a new listing stays `pending` before it becomes `active` */
  publishDelayPolls = 1;
  now: () => Date = () => new Date();
  private tokenSeq = 1;

  constructor(private readonly seed?: (s: SimSeller) => void) {}

  seller(id: string): SimSeller {
    let s = this.sellers.get(id);
    if (!s) { s = new SimSeller(id, this); this.seed?.(s); this.sellers.set(id, s); }
    return s;
  }

  issueToken(sellerId: string, ttlSeconds: number, prefix = 'sim'): { accessToken: string; refreshToken: string; expiresIn: number; expiresAt: Date } {
    const n = this.tokenSeq++;
    const accessToken = `${prefix}_at_${n}_${Math.random().toString(36).slice(2, 10)}`;
    const refreshToken = `${prefix}_rt_${n}_${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    this.accessTokens.set(accessToken, { sellerId, exp: expiresAt.getTime() });
    this.refreshTokens.set(refreshToken, sellerId);
    return { accessToken, refreshToken, expiresIn: ttlSeconds, expiresAt };
  }

  /** the seller behind a valid, unexpired access token */
  authenticate(token: string | undefined): SimSeller | null {
    const t = token ? this.accessTokens.get(token) : undefined;
    return t && t.exp > this.now().getTime() ? this.seller(t.sellerId) : null;
  }

  expireAllTokens(): void { for (const [k, v] of this.accessTokens) this.accessTokens.set(k, { ...v, exp: 0 }); }

  reset(): void {
    this.sellers.clear(); this.accessTokens.clear(); this.refreshTokens.clear();
    this.publishDelayPolls = 1; this.now = () => new Date();
  }
}
