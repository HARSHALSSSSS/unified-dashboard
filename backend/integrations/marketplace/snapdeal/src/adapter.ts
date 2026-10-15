import {
  ConnectorError,
  type ConnectorContext, type ConnectorCredentials, type CredentialSet, type HttpTransport, type InternalOrderStatus, type InventoryUpdate, type ListingInput, type ListingPreview,
  type ListingRequirement, type ListingResult, type ListingStatusReport, type MarketplaceCategory, type MarketplaceConnector, type NormalizedOrder, type NormalizedProduct,
  type OperationResult, type Paged, type PriceUpdate, type RemoteAccount,
} from '@oms/marketplace-core';
import { capabilities, polling, readiness } from './capabilities';
import { SnapdealClient } from './client';
import type { SdBulkResult } from './dto';
import { selectTarget, targetOf } from './environment';
import { buildProduct, mapFields, mapOrder, mapProduct, mapProductReport, toIssues } from './mappers';
import { snapdealSimulator } from './simulator';

export interface SnapdealOptions { simulator?: HttpTransport }

const SCOPES = ['seller'];
const FORWARD: Partial<Record<InternalOrderStatus, string>> = { confirmed: 'CONFIRMED', packed: 'PACKED', ready_to_dispatch: 'MANIFESTED', dispatched: 'HANDED_OVER', cancelled: 'CANCELLED' };

const perItem = (sku: string, results: SdBulkResult): OperationResult => {
  const r = results.find((x) => x.sellerSku === sku);
  return !r ? { externalSku: sku, ok: false, errorCode: 'NO_RESULT', message: 'Snapdeal returned no result for this SKU' } : r.ok ? { externalSku: sku, ok: true } : { externalSku: sku, ok: false, errorCode: r.errorCode, message: r.errorMessage };
};

export class SnapdealConnector implements MarketplaceConnector {
  readonly code = 'snapdeal' as const;
  readonly displayName = 'Snapdeal Seller';
  readonly implementation = 'beta' as const;
  readonly capabilities = capabilities;
  readonly readiness = readiness;
  readonly polling = polling;

  private readonly simulator: HttpTransport;
  constructor(opts: SnapdealOptions = {}) { this.simulator = opts.simulator ?? snapdealSimulator; }

  private client(ctx: ConnectorContext): SnapdealClient { const t = targetOf(ctx, this.simulator); return SnapdealClient.from(ctx, t.transport, t.baseUrl); }

  // ---------------------------------------------------------------- authorization (static seller token)
  async authenticate({ credentials, mode, config }: { credentials: ConnectorCredentials; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    const sellerId = typeof credentials.sellerId === 'string' ? credentials.sellerId.trim() : '';
    const authToken = typeof credentials.authToken === 'string' ? credentials.authToken.trim() : '';
    if (!sellerId || !authToken) throw new ConnectorError('auth', 'sellerId and authToken are required', { code: 'invalid_credentials' });
    const target = selectTarget({ mode, config }, this.simulator);
    const profile = await new SnapdealClient(target.transport, target.baseUrl, sellerId, authToken).profile();
    if (!profile.active) throw new ConnectorError('auth', 'The Snapdeal seller account is not active', { code: 'seller_inactive' });
    // the token is static: no expiry, nothing to refresh
    return { externalAccountId: profile.sellerId, credentials: { sellerId: profile.sellerId, authToken }, scopes: SCOPES };
  }

  async verifyConnection(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    const p = await this.client(ctx).profile();
    return { ok: p.active, message: p.active ? `Seller ${p.sellerId} is active` : 'Seller account is not active' };
  }

  async getAccount(ctx: ConnectorContext): Promise<RemoteAccount> {
    const p = await this.client(ctx).profile();
    return { externalAccountId: p.sellerId, displayName: p.storeName, region: 'IN', status: p.active ? 'active' : 'inactive', scopes: SCOPES };
  }

  // ---------------------------------------------------------------- catalogue / categories (page-number cursor)
  async importProducts(ctx: ConnectorContext, { cursor, limit = 10 }: { cursor?: string | null; limit?: number }): Promise<Paged<NormalizedProduct>> {
    const page = cursor ? Number(cursor) || 1 : 1;
    const res = await this.client(ctx).products({ page, pageSize: Math.min(limit, 20) });
    return { items: res.products.map(mapProduct), nextCursor: res.products.length > 0 && page < res.totalPages ? String(page + 1) : null };
  }

  async searchCategories(ctx: ConnectorContext, { query }: { query?: string; parentId?: string | null }): Promise<MarketplaceCategory[]> {
    return (await this.client(ctx).categories(query)).map((c) => ({ id: c.id, name: c.name, path: c.path, parentId: null, leaf: true }));
  }

  async getCategoryRequirements(ctx: ConnectorContext, { marketplaceCategoryId }: { marketplaceCategoryId: string }): Promise<ListingRequirement[]> {
    return mapFields(await this.client(ctx).fieldRules(marketplaceCategoryId));
  }

  // ---------------------------------------------------------------- listings
  previewListing(input: ListingInput): ListingPreview {
    const warnings: string[] = [];
    if (!input.imageUrls?.length) warnings.push('No image URLs: Snapdeal QC rejects products without images');
    if (!input.mrpMinor) warnings.push('No MRP: Snapdeal requires MRP');
    return { endpoint: 'POST /seller/v1/products', payload: { products: [buildProduct(input)] }, warnings };
  }

  async createListing(ctx: ConnectorContext, input: ListingInput): Promise<ListingResult> {
    const [r] = await this.client(ctx).upsertProduct(buildProduct(input));
    if (r && !r.ok) {
      const issues = toIssues(r.issues?.length ? r.issues : [{ code: r.errorCode ?? 'INVALID', message: r.errorMessage ?? 'Rejected' }]);
      const policy = issues.some((i) => /^POLICY/i.test(i.code));
      return { externalListingId: input.externalSku, status: policy ? 'rejected' : 'correction_required', marketplaceStatus: policy ? 'QC_FAILED' : 'NEEDS_INFO', issues };
    }
    return { externalListingId: input.externalSku, status: 'pending', marketplaceStatus: 'QC_PENDING', issues: [] };
  }

  async updateListing(ctx: ConnectorContext, input: ListingInput & { externalListingId: string }): Promise<ListingResult> {
    return { ...(await this.createListing(ctx, input)), externalListingId: input.externalListingId };
  }

  async getListingStatus(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<ListingStatusReport> { return mapProductReport(await this.client(ctx).product(externalSku)); }

  async deactivateListing(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<OperationResult> {
    try { await this.client(ctx).deactivate(externalSku); return { externalSku, ok: true }; }
    catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { externalSku, ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }

  // ---------------------------------------------------------------- inventory / pricing (bulk, 20 per call)
  async pushInventory(ctx: ConnectorContext, updates: InventoryUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (let i = 0; i < updates.length; i += capabilities.limits.maxBatchSize) {
      const chunk = updates.slice(i, i + capabilities.limits.maxBatchSize);
      const results = await client.stock(chunk.map((u) => ({ sellerSku: u.externalSku, stock: u.quantity })));
      for (const u of chunk) out.push(perItem(u.externalSku, results));
    }
    return out;
  }

  async pushPrices(ctx: ConnectorContext, updates: PriceUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (let i = 0; i < updates.length; i += capabilities.limits.maxBatchSize) {
      const chunk = updates.slice(i, i + capabilities.limits.maxBatchSize);
      const results = await client.prices(chunk.map((u) => ({ sellerSku: u.externalSku, sellingPrice: u.priceMinor / 100 })));
      for (const u of chunk) out.push(perItem(u.externalSku, results));
    }
    return out;
  }

  // ---------------------------------------------------------------- orders (polled)
  async fetchOrders(ctx: ConnectorContext, { since, cursor }: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedOrder>> {
    const page = cursor ? Number(cursor) || 1 : 1;
    const res = await this.client(ctx).orders({ updatedSince: since, page, pageSize: 20 });
    return { items: res.orders.map(mapOrder), nextCursor: res.orders.length > 0 && page < res.totalPages ? String(page + 1) : null };
  }

  async getOrder(ctx: ConnectorContext, { externalOrderId }: { externalOrderId: string }): Promise<NormalizedOrder | null> {
    try { return mapOrder(await this.client(ctx).order(externalOrderId)); }
    catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent' && e.code === 'not_found') return null;
      throw e;
    }
  }

  canRequestOrderStatus(status: InternalOrderStatus): boolean { return status in FORWARD; }

  async updateOrderStatus(ctx: ConnectorContext, input: { externalOrderId: string; status: InternalOrderStatus; tracking?: { number: string; carrier: string } }): Promise<OperationResult & { marketplaceStatus?: string }> {
    const to = FORWARD[input.status];
    if (!to) return { ok: false, errorCode: 'UNSUPPORTED_STATUS', message: `Snapdeal cannot be told "${input.status}"` };
    try {
      await this.client(ctx).changeState(input.externalOrderId, { state: to, ...(to === 'HANDED_OVER' ? { courier: input.tracking?.carrier ?? 'Other', awb: input.tracking?.number ?? 'NA' } : {}), ...(to === 'CANCELLED' ? { reason: 'Cancelled by seller' } : {}) });
      return { ok: true, marketplaceStatus: to };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }
}
