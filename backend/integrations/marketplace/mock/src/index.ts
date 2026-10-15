import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ConnectorError,
  NO_CAPABILITIES,
  type ConnectorCapabilities,
  type ConnectorContext,
  type ConnectorErrorKind,
  type CredentialSet,
  type InternalOrderStatus,
  type InventoryUpdate,
  type ListingInput,
  type ListingIssue,
  type ListingPreview,
  type ListingReportStatus,
  type ListingRequirement,
  type ListingResult,
  type ListingStatusReport,
  type MarketplaceCategory,
  type MarketplaceConnector,
  type NormalizedOrder,
  type NormalizedProduct,
  type NormalizedReturn,
  type NormalizedWebhook,
  type OperationResult,
  type Paged,
  type PriceUpdate,
  type RemoteAccount,
  type ShipmentInput,
  type ShipmentResult,
  type WebhookEventType,
} from '@oms/marketplace-core';

/**
 * MOCK / SANDBOX marketplace.
 *
 * A fully working in-memory marketplace so the whole platform can be developed and tested WITHOUT production
 * marketplace credentials. It supports every capability and can simulate failures on demand:
 *
 *   authorization   code "sandbox-code[:sellerId[:ttlSeconds]]"  or  credentials { sellerId, apiKey: "sandbox_..." }
 *   products        25 deterministic sample products per seller (paged)
 *   categories      two categories with listing requirements; listings are REVIEWED: pending -> active, or
 *                   correction_required (missing attributes / short title) or rejected (policy words)
 *   inventory/price push updates the seller's catalogue; unknown SKUs return per-item errors
 *   orders          5 deterministic orders per seller (optional), `mockControl.placeOrder` for a new customer order,
 *                   native status words (new, accepted, packed, shipped, delivered, cancelled, returned) mapped to internal ones
 *   errors/retries  `mockControl.setBehavior(sellerId, { failNext: 2, failKind: 'transient' })` makes the next 2 calls fail,
 *                   `rateLimitNext` simulates 429 + Retry-After, `expireAllAccessTokens` invalidates issued access tokens
 *   webhooks        signed events via `mockControl.signedWebhook`
 *
 * State lives in the module-level `mockControl` (process memory, reset on restart; credentials re-authenticate via refresh token).
 */

export interface MockBehavior {
  /** next N operations fail with `failKind` (default transient) */
  failNext?: number;
  failKind?: Extract<ConnectorErrorKind, 'transient' | 'permanent' | 'auth'>;
  /** next N operations are rate limited (429) with this Retry-After */
  rateLimitNext?: number;
  retryAfterMs?: number;
}

interface Lifecycle { status: ListingReportStatus; pendingPolls: number; issues: ListingIssue[]; categoryId?: string }

interface MockSeller {
  sellerId: string;
  products: Map<string, NormalizedProduct>;
  lifecycle: Map<string, Lifecycle>;
  orders: Map<string, NormalizedOrder>;
  returns: NormalizedReturn[];
  behavior: MockBehavior;
  calls: number;
  listingSeq: number;
  orderSeq: number;
  /** events a real marketplace would push to us */
  webhooks: Array<{ type: WebhookEventType; orderId?: string; sku?: string }>;
}

const DAY = 86_400_000;

/** native -> internal order statuses (the mock marketplace's own vocabulary) */
const NATIVE_TO_INTERNAL: Record<string, InternalOrderStatus> = {
  new: 'new', accepted: 'confirmed', packed: 'packed', shipped: 'dispatched', in_transit: 'in_transit', delivered: 'delivered', cancelled: 'cancelled', returned: 'returned',
};
const INTERNAL_TO_NATIVE: Partial<Record<InternalOrderStatus, string>> = { confirmed: 'accepted', packed: 'packed', dispatched: 'shipped', delivered: 'delivered', cancelled: 'cancelled' };

export const MOCK_CATEGORIES: Array<MarketplaceCategory & { requirements: ListingRequirement[] }> = [
  {
    id: 'mock-apparel', name: 'Apparel', path: 'Fashion > Apparel', parentId: null, leaf: true,
    requirements: [
      { name: 'brand', required: true, type: 'string', maxLength: 50, coreField: 'brand' },
      { name: 'color', required: true, type: 'string', maxLength: 30 },
      { name: 'size', required: true, type: 'enum', allowedValues: ['S', 'M', 'L', 'XL'] },
      { name: 'country_of_origin', required: false, type: 'string', coreField: 'country_of_origin' },
    ],
  },
  {
    id: 'mock-accessories', name: 'Accessories', path: 'Fashion > Accessories', parentId: null, leaf: true,
    requirements: [
      { name: 'brand', required: true, type: 'string', maxLength: 50, coreField: 'brand' },
      { name: 'material', required: true, type: 'string', maxLength: 40 },
    ],
  },
];

export class MockMarketplaceState {
  readonly sellers = new Map<string, MockSeller>();
  /** accessToken -> expiry epoch ms */
  readonly accessTokens = new Map<string, number>();
  /** valid refresh tokens (rotated on use) */
  readonly refreshTokens = new Map<string, string>();
  now: () => Date = () => new Date();
  /** seed 5 historic orders for every new seller (kept for the connector conformance tests) */
  seedOrders = true;
  /** how many status checks a new listing stays `pending` */
  publishDelayPolls = 1;

  seller(sellerId: string): MockSeller {
    let s = this.sellers.get(sellerId);
    if (!s) {
      s = { sellerId, products: new Map(), lifecycle: new Map(), orders: new Map(), returns: [], behavior: {}, calls: 0, listingSeq: 100, orderSeq: 2000, webhooks: [] };
      this.seed(s);
      this.sellers.set(sellerId, s);
    }
    return s;
  }

  private seed(s: MockSeller): void {
    const base = this.now().getTime();
    for (let i = 1; i <= 25; i++) {
      const sku = `MOCK-${s.sellerId}-SKU-${String(i).padStart(3, '0')}`;
      s.products.set(sku, {
        externalListingId: `MP-${String(i).padStart(5, '0')}`,
        externalSku: sku,
        title: `Sandbox Product ${i}`,
        brand: i % 2 ? 'SandboxBasics' : 'SandboxPro',
        priceMinor: 49_900 + i * 1_000,
        currency: 'INR',
        quantity: 10 * i,
        imageUrls: [`https://sandbox.mock-marketplace.local/img/${i}.jpg`],
        attributes: { color: i % 3 ? 'Blue' : 'Red', size: ['S', 'M', 'L'][i % 3] },
        category: { id: 'mock-apparel', name: 'Apparel' },
        status: 'active',
        marketplaceStatus: 'ACTIVE',
      });
    }
    if (!this.seedOrders) return;
    for (let i = 1; i <= 5; i++) {
      const sku = `MOCK-${s.sellerId}-SKU-${String(i).padStart(3, '0')}`;
      const unit = 49_900 + i * 1_000;
      const id = `MO-${s.sellerId}-${1000 + i}`;
      s.orders.set(id, {
        externalOrderId: id,
        status: 'new',
        marketplaceStatus: 'new',
        placedAt: new Date(base - i * DAY),
        currency: 'INR',
        totalMinor: unit * 2,
        items: [{ externalItemId: `${id}-1`, sku, title: `Sandbox Product ${i}`, quantity: 2, unitPriceMinor: unit, taxMinor: 0, discountMinor: 0 }],
        shippingAddress: { name: 'Sandbox Buyer', city: 'Bengaluru', pincode: '560001', country: 'IN' },
        raw: { sandbox: true },
      });
    }
    s.returns.push({ externalReturnId: `MR-${s.sellerId}-1`, externalOrderId: `MO-${s.sellerId}-1005`, status: 'requested', reason: 'size_issue', requestedAt: new Date(base - DAY) });
  }

  issueTokens(sellerId: string, ttlSeconds: number): { accessToken: string; refreshToken: string; expiresAt: Date } {
    const accessToken = `mock_at_${randomBytes(12).toString('hex')}`;
    const refreshToken = `mock_rt_${randomBytes(12).toString('hex')}`;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    this.accessTokens.set(accessToken, expiresAt.getTime());
    this.refreshTokens.set(refreshToken, sellerId);
    return { accessToken, refreshToken, expiresAt };
  }
}

/** Test/dev control surface for the sandbox. */
export const mockState = new MockMarketplaceState();
const WEBHOOK_SECRET_HEADER = 'x-mock-signature';

export const mockControl = {
  state: mockState,
  setBehavior(sellerId: string, behavior: MockBehavior): void { mockState.seller(sellerId).behavior = { ...behavior }; },
  calls(sellerId: string): number { return mockState.seller(sellerId).calls; },
  /** make every issued access token expire immediately */
  expireAllAccessTokens(): void { for (const k of mockState.accessTokens.keys()) mockState.accessTokens.set(k, 0); },
  /** settings that must be applied BEFORE a seller is first used (e.g. seedOrders=false) */
  configure(o: { seedOrders?: boolean; publishDelayPolls?: number }): void {
    if (o.seedOrders !== undefined) mockState.seedOrders = o.seedOrders;
    if (o.publishDelayPolls !== undefined) mockState.publishDelayPolls = o.publishDelayPolls;
  },
  /** a customer buys items on the marketplace: creates the order (native status "new") and lowers the displayed stock */
  placeOrder(sellerId: string, items: Array<{ sku: string; quantity: number }>, o: { cod?: boolean } = {}): NormalizedOrder {
    const s = mockState.seller(sellerId);
    const id = `MO-${sellerId}-${s.orderSeq++}`;
    const lines = items.map((it, i) => {
      const p = s.products.get(it.sku);
      if (!p) throw new Error(`Mock marketplace has no listing for SKU ${it.sku}`);
      p.quantity = Math.max(0, (p.quantity ?? 0) - it.quantity);
      return { externalItemId: `${id}-${i + 1}`, externalListingId: p.externalListingId, sku: it.sku, title: p.title, quantity: it.quantity, unitPriceMinor: p.priceMinor ?? 0, taxMinor: 0, discountMinor: 0 };
    });
    const total = lines.reduce((n, l) => n + l.unitPriceMinor * l.quantity, 0);
    const order: NormalizedOrder = {
      externalOrderId: id, status: 'new', marketplaceStatus: 'new', placedAt: mockState.now(), currency: 'INR', totalMinor: total, items: lines,
      buyer: { name: 'Sandbox Buyer', email: 'buyer@sandbox.example.invalid', phone: '+910000000000' },
      shippingAddress: { name: 'Sandbox Buyer', line1: '12 Test Street', city: 'Bengaluru', state: 'KA', pincode: '560001', country: 'IN' },
      payment: o.cod ? { method: 'cod', status: 'pending', codAmountMinor: total } : { method: 'prepaid', status: 'paid' },
      raw: { sandbox: true },
    };
    s.orders.set(id, order);
    s.webhooks.push({ type: 'order.created', orderId: id });
    return order;
  },
  /** the marketplace moves an order to a native status (e.g. "cancelled" by the buyer) */
  setOrderStatus(sellerId: string, orderId: string, nativeStatus: keyof typeof NATIVE_TO_INTERNAL): void {
    const o = mockState.seller(sellerId).orders.get(orderId);
    if (!o) throw new Error(`unknown mock order ${orderId}`);
    o.marketplaceStatus = nativeStatus;
    o.status = NATIVE_TO_INTERNAL[nativeStatus]!;
    mockState.seller(sellerId).webhooks.push({ type: nativeStatus === 'cancelled' ? 'order.cancelled' : 'order.updated', orderId });
  },
  order(sellerId: string, orderId: string): NormalizedOrder | undefined { return mockState.seller(sellerId).orders.get(orderId); },
  listing(sellerId: string, sku: string) { return { product: mockState.seller(sellerId).products.get(sku), lifecycle: mockState.seller(sellerId).lifecycle.get(sku) }; },
  quantity(sellerId: string, sku: string): number | undefined { return mockState.seller(sellerId).products.get(sku)?.quantity; },
  /** a signed webhook exactly as the marketplace would POST it to us */
  signedWebhook(event: { id: string; type: WebhookEventType; orderId?: string; sku?: string; status?: string }, secret: string): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify(event);
    return { rawBody, headers: { 'content-type': 'application/json', [WEBHOOK_SECRET_HEADER]: createHmac('sha256', secret).update(rawBody).digest('hex') } };
  },
  /** webhooks the marketplace "would have sent" since last drained */
  drainWebhooks(sellerId: string) { const s = mockState.seller(sellerId); return s.webhooks.splice(0); },
  reset(): void {
    mockState.sellers.clear();
    mockState.accessTokens.clear();
    mockState.refreshTokens.clear();
    mockState.now = () => new Date();
    mockState.seedOrders = true;
    mockState.publishDelayPolls = 1;
  },
};

const DEFAULT_TTL = 3600;

export class MockConnector implements MarketplaceConnector {
  readonly code = 'mock' as const;
  readonly displayName = 'Mock Marketplace (Sandbox)';
  readonly implementation = 'beta' as const;
  readonly readiness = { sandbox: true, live: false, notes: 'In-memory sandbox. There is no live mock marketplace.' };
  readonly webhook = { signatureHeader: 'x-mock-signature', algorithm: 'HMAC-SHA256 of the raw body', description: 'Sandbox events produced by mockControl.signedWebhook' };
  readonly capabilities: ConnectorCapabilities = {
    ...NO_CAPABILITIES,
    auth: { type: 'oauth2', refreshable: true, redirectFlow: true },
    account: { fetchProfile: true },
    catalog: { import: true },
    listings: { create: true, update: true, deactivate: true, fetch: true, requiresCategoryMapping: true, categorySearch: true, statusLookup: true },
    inventory: { push: true, pull: true, batch: true },
    pricing: { push: true, pull: true },
    orders: { fetch: true, webhook: true, acknowledge: true, updateStatus: true, cancel: true, maxLookbackDays: 90 },
    returns: { fetch: true, webhook: false },
    shipping: { createShipment: true, generateLabel: true, marketplaceManagedLogistics: false, manifest: false },
    limits: { requestsPerSecond: 50, burst: 100, maxBatchSize: 100 },
  };
  readonly polling = { orders: { intervalSeconds: 300, lookbackMinutes: 24 * 60, overlapMinutes: 10 }, listingStatus: { intervalSeconds: 120 } };

  constructor(private readonly state: MockMarketplaceState = mockState) {}

  // ------------------------------------------------------------------ authorization
  buildAuthorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const u = new URL('https://sandbox.mock-marketplace.local/oauth/authorize');
    u.searchParams.set('client_id', 'oms-sandbox');
    u.searchParams.set('state', state);
    u.searchParams.set('redirect_uri', redirectUri);
    return u.toString();
  }

  /** code = "sandbox-code[:sellerId[:ttlSeconds]]" */
  async exchangeAuthorizationCode({ code }: { code: string }): Promise<CredentialSet & { externalAccountId: string }> {
    const [prefix, sellerId = 'SANDBOX-001', ttl] = code.split(':');
    if (prefix !== 'sandbox-code') throw new ConnectorError('auth', 'Invalid authorization code', { code: 'invalid_grant' });
    return this.credentialSet(sellerId, ttl ? Number(ttl) : DEFAULT_TTL);
  }

  async authenticate({ credentials }: { credentials: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    const sellerId = typeof credentials.sellerId === 'string' ? credentials.sellerId : '';
    const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey : '';
    if (!sellerId || !apiKey.startsWith('sandbox_')) throw new ConnectorError('auth', 'Invalid sandbox API key (must start with "sandbox_")', { code: 'invalid_api_key' });
    return this.credentialSet(sellerId, typeof credentials.ttlSeconds === 'number' ? credentials.ttlSeconds : DEFAULT_TTL);
  }

  async refreshCredentials(ctx: ConnectorContext): Promise<CredentialSet> {
    await this.simulate(ctx, false);
    const rt = ctx.credentials.refreshToken;
    const sellerId = String(ctx.credentials.sellerId ?? ctx.externalAccountId ?? '');
    // Sandbox is lenient on purpose: any well-formed refresh token works, so credentials survive a process restart.
    if (typeof rt !== 'string' || !rt.startsWith('mock_rt_')) {
      throw new ConnectorError('auth', 'Refresh token rejected', { code: 'invalid_grant' });
    }
    this.state.refreshTokens.delete(rt);
    const set = this.credentialSet(sellerId, Number(ctx.credentials.ttlSeconds ?? DEFAULT_TTL));
    return { credentials: set.credentials, expiresAt: set.expiresAt, scopes: set.scopes };
  }

  async verifyConnection(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    await this.simulate(ctx);
    return { ok: true, message: `Sandbox seller ${this.sellerOf(ctx)} reachable` };
  }

  // ------------------------------------------------------------------ account / catalogue
  async getAccount(ctx: ConnectorContext): Promise<RemoteAccount> {
    await this.simulate(ctx);
    const id = this.sellerOf(ctx);
    return { externalAccountId: id, displayName: `Sandbox Seller ${id}`, region: 'IN', status: 'active', scopes: ['catalog', 'inventory', 'orders', 'returns', 'shipping'] };
  }

  async importProducts(ctx: ConnectorContext, { cursor, limit = 10 }: { cursor?: string | null; limit?: number }): Promise<Paged<NormalizedProduct>> {
    await this.simulate(ctx);
    const all = [...this.state.seller(this.sellerOf(ctx)).products.values()];
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
  }

  // ------------------------------------------------------------------ categories / listings
  async searchCategories(ctx: ConnectorContext, { query }: { query?: string; parentId?: string | null }): Promise<MarketplaceCategory[]> {
    await this.simulate(ctx);
    const q = query?.toLowerCase();
    return MOCK_CATEGORIES.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.path ?? '').toLowerCase().includes(q)).map(({ requirements: _r, ...c }) => c);
  }

  async getCategoryRequirements(ctx: ConnectorContext, { marketplaceCategoryId }: { marketplaceCategoryId: string }): Promise<ListingRequirement[]> {
    await this.simulate(ctx);
    const c = MOCK_CATEGORIES.find((x) => x.id === marketplaceCategoryId);
    if (!c) throw new ConnectorError('permanent', `Unknown category ${marketplaceCategoryId}`, { code: 'invalid_category' });
    return c.requirements;
  }

  previewListing(input: ListingInput): ListingPreview {
    const warnings: string[] = [];
    if (!input.imageUrls?.length) warnings.push('No images: the marketplace shows listings without images with low priority');
    return {
      endpoint: 'POST /sandbox/listings',
      warnings,
      payload: { sku: input.externalSku, title: input.title, description: input.description, brand: input.brand, category: input.marketplaceCategoryId, price: input.priceMinor, mrp: input.mrpMinor, currency: input.currency, stock: input.quantity ?? 0, attributes: input.attributes ?? {}, images: input.imageUrls ?? [] },
    };
  }

  private review(input: ListingInput): ListingIssue[] {
    const issues: ListingIssue[] = [];
    const err = (code: string, message: string, attribute?: string) => issues.push({ code, message, attribute, severity: 'error' });
    if (input.title.trim().length < 10) err('TITLE_TOO_SHORT', 'Title must be at least 10 characters', 'title');
    if (!(input.priceMinor > 0)) err('INVALID_PRICE', 'Price must be greater than zero', 'price');
    const cat = MOCK_CATEGORIES.find((c) => c.id === input.marketplaceCategoryId);
    if (!cat) { err('INVALID_CATEGORY', `Unknown category ${input.marketplaceCategoryId ?? '(none)'}`, 'category'); return issues; }
    for (const r of cat.requirements) {
      const v = input.attributes?.[r.name];
      if (v === undefined || v === '') { if (r.required) err('MISSING_ATTRIBUTE', `Required attribute "${r.name}" is missing`, r.name); continue; }
      if (r.type === 'enum' && r.allowedValues && !r.allowedValues.includes(String(v))) err('INVALID_VALUE', `"${r.name}" must be one of: ${r.allowedValues.join(', ')}`, r.name);
      if (r.maxLength && String(v).length > r.maxLength) err('VALUE_TOO_LONG', `"${r.name}" exceeds ${r.maxLength} characters`, r.name);
    }
    return issues;
  }

  private submit(s: MockSeller, input: ListingInput, existing?: NormalizedProduct): ListingResult {
    const issues = this.review(input);
    const banned = /\b(counterfeit|replica|fake)\b/i.test(`${input.title} ${input.description ?? ''}`);
    if (banned) issues.push({ code: 'POLICY_VIOLATION', message: 'Listing violates marketplace policy', severity: 'error' });
    const status: ListingReportStatus = banned ? 'rejected' : issues.length ? 'correction_required' : this.state.publishDelayPolls > 0 ? 'pending' : 'active';
    const externalListingId = existing?.externalListingId ?? `MP-${++s.listingSeq}`;
    s.products.set(input.externalSku, {
      externalListingId, externalSku: input.externalSku, title: input.title, description: input.description, brand: input.brand, barcode: input.barcode,
      priceMinor: input.priceMinor, mrpMinor: input.mrpMinor, currency: input.currency, quantity: input.quantity ?? existing?.quantity ?? 0,
      imageUrls: input.imageUrls, attributes: input.attributes, category: input.marketplaceCategoryId ? { id: input.marketplaceCategoryId } : undefined, status, marketplaceStatus: status.toUpperCase(),
    });
    s.lifecycle.set(input.externalSku, { status, pendingPolls: status === 'pending' ? this.state.publishDelayPolls : 0, issues, categoryId: input.marketplaceCategoryId });
    return { externalListingId, status, marketplaceStatus: status.toUpperCase(), issues };
  }

  async createListing(ctx: ConnectorContext, input: ListingInput): Promise<ListingResult> {
    await this.simulate(ctx);
    const s = this.state.seller(this.sellerOf(ctx));
    const existing = s.products.get(input.externalSku);
    if (existing && s.lifecycle.get(input.externalSku)?.status !== 'correction_required' && s.lifecycle.get(input.externalSku)?.status !== 'rejected' && existing.status !== 'inactive') {
      throw new ConnectorError('permanent', `SKU ${input.externalSku} already listed`, { code: 'duplicate_sku' });
    }
    return this.submit(s, input, existing);
  }

  async updateListing(ctx: ConnectorContext, input: ListingInput & { externalListingId: string }): Promise<ListingResult> {
    await this.simulate(ctx);
    const s = this.state.seller(this.sellerOf(ctx));
    const existing = [...s.products.values()].find((p) => p.externalListingId === input.externalListingId);
    if (!existing) throw new ConnectorError('permanent', 'Listing not found', { code: 'listing_not_found' });
    return this.submit(s, { ...input, externalSku: existing.externalSku }, existing);
  }

  async getListingStatus(ctx: ConnectorContext, { externalSku }: { externalSku: string; externalListingId?: string }): Promise<ListingStatusReport> {
    await this.simulate(ctx);
    const s = this.state.seller(this.sellerOf(ctx));
    const p = s.products.get(externalSku);
    if (!p) throw new ConnectorError('permanent', 'Listing not found', { code: 'listing_not_found' });
    const lc = s.lifecycle.get(externalSku);
    if (lc && lc.status === 'pending') {
      lc.pendingPolls = Math.max(0, lc.pendingPolls - 1);
      if (lc.pendingPolls === 0) { lc.status = 'active'; p.status = 'active'; p.marketplaceStatus = 'ACTIVE'; s.webhooks.push({ type: 'listing.status_changed', sku: externalSku }); }
    }
    const status = lc?.status ?? (p.status as ListingReportStatus) ?? 'active';
    return { externalSku, externalListingId: p.externalListingId, status, marketplaceStatus: status.toUpperCase(), issues: lc?.issues ?? [] };
  }

  async deactivateListing(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<OperationResult> {
    await this.simulate(ctx);
    const s = this.state.seller(this.sellerOf(ctx));
    const p = s.products.get(externalSku);
    if (!p) return { externalSku, ok: false, errorCode: 'SKU_NOT_FOUND', message: 'Unknown SKU' };
    p.status = 'inactive';
    p.marketplaceStatus = 'INACTIVE';
    s.lifecycle.set(externalSku, { status: 'inactive', pendingPolls: 0, issues: [] });
    return { externalSku, ok: true };
  }

  async pushInventory(ctx: ConnectorContext, updates: InventoryUpdate[]): Promise<OperationResult[]> {
    await this.simulate(ctx);
    const s = this.state.seller(this.sellerOf(ctx));
    return updates.map((u) => {
      const p = s.products.get(u.externalSku);
      if (!p) return { externalSku: u.externalSku, ok: false, errorCode: 'SKU_NOT_FOUND', message: 'Unknown SKU' };
      if (u.quantity < 0) return { externalSku: u.externalSku, ok: false, errorCode: 'INVALID_QUANTITY', message: 'Quantity must be >= 0' };
      p.quantity = u.quantity;
      return { externalSku: u.externalSku, ok: true };
    });
  }

  async pushPrices(ctx: ConnectorContext, updates: PriceUpdate[]): Promise<OperationResult[]> {
    await this.simulate(ctx);
    const s = this.state.seller(this.sellerOf(ctx));
    return updates.map((u) => {
      const p = s.products.get(u.externalSku);
      if (!p) return { externalSku: u.externalSku, ok: false, errorCode: 'SKU_NOT_FOUND', message: 'Unknown SKU' };
      p.priceMinor = u.priceMinor;
      p.currency = u.currency;
      return { externalSku: u.externalSku, ok: true };
    });
  }

  // ------------------------------------------------------------------ orders / returns / shipping
  async fetchOrders(ctx: ConnectorContext, { since, cursor }: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedOrder>> {
    await this.simulate(ctx);
    const all = [...this.state.seller(this.sellerOf(ctx)).orders.values()].filter((o) => o.placedAt >= since).sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + 3);
    return { items, nextCursor: start + 3 < all.length ? String(start + 3) : null };
  }

  async getOrder(ctx: ConnectorContext, { externalOrderId }: { externalOrderId: string }): Promise<NormalizedOrder | null> {
    await this.simulate(ctx);
    return this.state.seller(this.sellerOf(ctx)).orders.get(externalOrderId) ?? null;
  }

  canRequestOrderStatus(status: InternalOrderStatus): boolean { return status in INTERNAL_TO_NATIVE; }

  async updateOrderStatus(ctx: ConnectorContext, { externalOrderId, status }: { externalOrderId: string; status: InternalOrderStatus }): Promise<OperationResult & { marketplaceStatus?: string }> {
    await this.simulate(ctx);
    const native = INTERNAL_TO_NATIVE[status];
    if (!native) return { ok: false, errorCode: 'UNSUPPORTED_STATUS', message: `Cannot request ${status} on this marketplace` };
    const o = this.state.seller(this.sellerOf(ctx)).orders.get(externalOrderId);
    if (!o) return { ok: false, errorCode: 'ORDER_NOT_FOUND', message: 'Unknown order' };
    o.marketplaceStatus = native;
    o.status = NATIVE_TO_INTERNAL[native]!;
    return { ok: true, marketplaceStatus: native };
  }

  async cancelOrder(ctx: ConnectorContext, { externalOrderId }: { externalOrderId: string; reason?: string }): Promise<OperationResult> {
    await this.simulate(ctx);
    const o = this.state.seller(this.sellerOf(ctx)).orders.get(externalOrderId);
    if (!o) return { ok: false, errorCode: 'ORDER_NOT_FOUND', message: 'Unknown order' };
    if (o.marketplaceStatus === 'shipped' || o.marketplaceStatus === 'delivered') return { ok: false, errorCode: 'NOT_CANCELLABLE', message: `Order is ${o.marketplaceStatus}` };
    o.marketplaceStatus = 'cancelled';
    o.status = 'cancelled';
    return { ok: true };
  }

  async fetchReturns(ctx: ConnectorContext, { since }: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedReturn>> {
    await this.simulate(ctx);
    return { items: this.state.seller(this.sellerOf(ctx)).returns.filter((r) => r.requestedAt >= since), nextCursor: null };
  }

  async createShipment(ctx: ConnectorContext, { externalOrderId, carrier }: ShipmentInput): Promise<ShipmentResult> {
    await this.simulate(ctx);
    const o = this.state.seller(this.sellerOf(ctx)).orders.get(externalOrderId);
    if (!o) throw new ConnectorError('permanent', 'Unknown order', { code: 'order_not_found' });
    o.marketplaceStatus = 'shipped';
    o.status = 'dispatched';
    return { trackingNumber: `MOCKTRK${externalOrderId.replace(/\W/g, '').slice(-8)}`, carrier: carrier ?? 'SandboxExpress', labelUrl: `https://sandbox.mock-marketplace.local/labels/${externalOrderId}.pdf` };
  }

  // ------------------------------------------------------------------ webhooks
  verifyWebhook({ headers, rawBody, secret }: { headers: Record<string, string | undefined>; rawBody: Buffer; secret: string }): boolean {
    const sig = headers[WEBHOOK_SECRET_HEADER];
    if (!sig) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return timingSafeEqual(createHash('sha256').update(sig).digest(), createHash('sha256').update(expected).digest());
  }

  parseWebhook({ body }: { headers: Record<string, string | undefined>; body: unknown }): NormalizedWebhook | null {
    const b = body as { id?: string; type?: WebhookEventType; orderId?: string; sku?: string; status?: string; event?: string };
    const type = b.type ?? (b.event as WebhookEventType | undefined);
    if (!b.id || !type) return null;
    return {
      eventType: type, externalId: b.id, idempotencyKey: `mock-${b.id}`, payload: body,
      ...(b.orderId ? { externalOrderId: b.orderId } : {}),
      ...(type === 'listing.status_changed' && b.sku && b.status ? { listing: { externalSku: b.sku, externalListingId: b.sku, status: b.status as 'active' | 'pending' | 'rejected' | 'correction_required' | 'inactive', marketplaceStatus: b.status, issues: [] } } : {}),
    };
  }

  // ------------------------------------------------------------------ internals
  private credentialSet(sellerId: string, ttlSeconds: number): CredentialSet & { externalAccountId: string } {
    const t = this.state.issueTokens(sellerId, ttlSeconds);
    this.state.seller(sellerId);
    return {
      externalAccountId: sellerId,
      credentials: { sellerId, accessToken: t.accessToken, refreshToken: t.refreshToken, ttlSeconds },
      expiresAt: t.expiresAt,
      scopes: ['catalog', 'inventory', 'orders', 'returns', 'shipping'],
    };
  }

  private sellerOf(ctx: ConnectorContext): string {
    const id = ctx.externalAccountId ?? (typeof ctx.credentials.sellerId === 'string' ? ctx.credentials.sellerId : null);
    if (!id) throw new ConnectorError('permanent', 'No seller id on context');
    return id;
  }

  /** Applies scripted failures and (optionally) validates the access token. Called at the start of every operation. */
  private async simulate(ctx: ConnectorContext, requireToken = true): Promise<void> {
    const s = this.state.seller(this.sellerOf(ctx));
    s.calls++;
    const b = s.behavior;
    if (b.rateLimitNext && b.rateLimitNext > 0) {
      b.rateLimitNext--;
      throw new ConnectorError('rate_limited', 'Sandbox rate limit exceeded', { code: 'throttled', retryAfterMs: b.retryAfterMs ?? 10 });
    }
    if (b.failNext && b.failNext > 0) {
      b.failNext--;
      const kind = b.failKind ?? 'transient';
      throw new ConnectorError(kind, `Simulated ${kind} failure`, { code: `simulated_${kind}` });
    }
    if (requireToken) {
      const token = ctx.credentials.accessToken;
      const exp = typeof token === 'string' ? this.state.accessTokens.get(token) : undefined;
      if (exp === undefined || exp <= this.state.now().getTime()) throw new ConnectorError('auth', 'Access token expired or invalid', { code: 'token_expired' });
    }
  }
}

export const createMockConnector = (): MarketplaceConnector => new MockConnector();
