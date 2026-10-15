import {
  ConnectorError,
  type ConnectorContext, type ConnectorCredentials, type CredentialSet, type HttpTransport, type InternalOrderStatus, type InventoryUpdate, type ListingInput, type ListingPreview,
  type ListingRequirement, type ListingResult, type ListingStatusReport, type MarketplaceCategory, type MarketplaceConnector, type NormalizedOrder, type NormalizedProduct,
  type OperationResult, type Paged, type PriceUpdate, type RemoteAccount,
} from '@oms/marketplace-core';
import { MyntraAuth } from './auth';
import { capabilities, polling, readiness } from './capabilities';
import { MyntraClient } from './client';
import type { MynBulkResult } from './dto';
import { selectTarget, targetOf } from './environment';
import { buildStyle, mapRelease, mapRules, mapStyleReport, mapStyleToProduct, toIssues } from './mappers';
import { myntraSimulator } from './simulator';

export interface MyntraOptions { simulator?: HttpTransport; now?: () => number }

const SCOPES = ['partner'];
const FORWARD: Partial<Record<InternalOrderStatus, string>> = { confirmed: 'ACKNOWLEDGED', packed: 'PACKED', ready_to_dispatch: 'READY_TO_SHIP', dispatched: 'SHIPPED' };

const perItem = (sku: string, results: MynBulkResult): OperationResult => {
  const r = results.find((x) => x.skuCode === sku);
  return !r ? { externalSku: sku, ok: false, errorCode: 'NO_RESULT', message: 'Myntra returned no result for this SKU' } : r.success ? { externalSku: sku, ok: true } : { externalSku: sku, ok: false, errorCode: r.code, message: r.message };
};

export class MyntraConnector implements MarketplaceConnector {
  readonly code = 'myntra' as const;
  readonly displayName = 'Myntra Partner';
  readonly implementation = 'beta' as const;
  readonly capabilities = capabilities;
  readonly readiness = readiness;
  readonly polling = polling;

  private readonly simulator: HttpTransport;
  private readonly now: () => number;
  constructor(opts: MyntraOptions = {}) { this.simulator = opts.simulator ?? myntraSimulator; this.now = opts.now ?? Date.now; }

  private client(ctx: ConnectorContext): MyntraClient { const t = targetOf(ctx, this.simulator); return MyntraClient.from(ctx, t.transport, t.baseUrl); }

  // ---------------------------------------------------------------- authorization (API key -> session token)
  async authenticate({ credentials, mode, config }: { credentials: ConnectorCredentials; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey.trim() : '';
    const apiSecret = typeof credentials.apiSecret === 'string' ? credentials.apiSecret.trim() : '';
    if (!apiKey || !apiSecret) throw new ConnectorError('auth', 'apiKey and apiSecret are required', { code: 'invalid_credentials' });
    const target = selectTarget({ mode, config }, this.simulator);
    const session = await new MyntraAuth(target.transport, target.baseUrl, this.now).login(apiKey, apiSecret);
    const profile = await new MyntraClient(target.transport, target.baseUrl, session.accessToken).profile();
    if (!profile.active) throw new ConnectorError('auth', 'The Myntra partner account is not active', { code: 'partner_inactive' });
    return { externalAccountId: profile.partnerId, credentials: { apiKey, apiSecret, accessToken: session.accessToken, partnerId: profile.partnerId }, expiresAt: session.expiresAt, scopes: SCOPES };
  }

  async refreshCredentials(ctx: ConnectorContext): Promise<CredentialSet> {
    const t = targetOf(ctx, this.simulator);
    const session = await new MyntraAuth(t.transport, t.baseUrl, this.now).login(String(ctx.credentials.apiKey ?? ''), String(ctx.credentials.apiSecret ?? ''));
    return { credentials: { ...ctx.credentials, accessToken: session.accessToken }, expiresAt: session.expiresAt, scopes: SCOPES };
  }

  async verifyConnection(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    const p = await this.client(ctx).profile();
    return { ok: p.active, message: p.active ? `Partner ${p.partnerId} is active` : 'Partner account is not active' };
  }

  async getAccount(ctx: ConnectorContext): Promise<RemoteAccount> {
    const p = await this.client(ctx).profile();
    return { externalAccountId: p.partnerId, displayName: p.name, region: 'IN', status: p.active ? 'active' : 'inactive', scopes: SCOPES };
  }

  // ---------------------------------------------------------------- catalogue / categories
  async importProducts(ctx: ConnectorContext, { cursor, limit = 10 }: { cursor?: string | null; limit?: number }): Promise<Paged<NormalizedProduct>> {
    const offset = cursor ? Number(cursor) || 0 : 0;
    const page = await this.client(ctx).styles({ offset, limit: Math.min(limit, 20) });
    const next = offset + page.styles.length;
    return { items: page.styles.map(mapStyleToProduct), nextCursor: page.styles.length > 0 && next < page.total ? String(next) : null };
  }

  async searchCategories(ctx: ConnectorContext, { query }: { query?: string; parentId?: string | null }): Promise<MarketplaceCategory[]> {
    return (await this.client(ctx).articleTypes(query)).map((a) => ({ id: a.id, name: a.name, path: a.name, parentId: null, leaf: true }));
  }

  async getCategoryRequirements(ctx: ConnectorContext, { marketplaceCategoryId }: { marketplaceCategoryId: string }): Promise<ListingRequirement[]> {
    return mapRules(await this.client(ctx).rules(marketplaceCategoryId));
  }

  // ---------------------------------------------------------------- listings
  previewListing(input: ListingInput): ListingPreview {
    const warnings: string[] = [];
    if (!input.imageUrls?.length) warnings.push('No image URLs: Myntra will not take a style live without images');
    if (!input.mrpMinor) warnings.push('No MRP: Myntra requires MRP');
    return { endpoint: 'POST /partner/v1/styles', payload: { styles: [buildStyle(input)] }, warnings };
  }

  async createListing(ctx: ConnectorContext, input: ListingInput): Promise<ListingResult> {
    const [r] = await this.client(ctx).upsertStyle(buildStyle(input));
    // submission acknowledges the style; Myntra reviews it asynchronously (status is polled)
    if (r && !r.success) {
      const issues = toIssues(r.errors?.length ? r.errors : [{ code: r.code ?? 'INVALID', message: r.message ?? 'Rejected' }]);
      // a policy decision is final; anything else is something the seller can fix
      const policy = issues.some((i) => /^POLICY/i.test(i.code));
      return { externalListingId: input.externalSku, status: policy ? 'rejected' : 'correction_required', marketplaceStatus: policy ? 'REJECTED' : 'NEEDS_CHANGES', issues };
    }
    return { externalListingId: input.externalSku, status: 'pending', marketplaceStatus: 'IN_REVIEW', issues: [] };
  }

  async updateListing(ctx: ConnectorContext, input: ListingInput & { externalListingId: string }): Promise<ListingResult> {
    return { ...(await this.createListing(ctx, input)), externalListingId: input.externalListingId };
  }

  async getListingStatus(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<ListingStatusReport> { return mapStyleReport(await this.client(ctx).style(externalSku)); }

  async deactivateListing(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<OperationResult> {
    try { await this.client(ctx).disable(externalSku); return { externalSku, ok: true }; }
    catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { externalSku, ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }

  // ---------------------------------------------------------------- inventory / pricing (bulk)
  async pushInventory(ctx: ConnectorContext, updates: InventoryUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (let i = 0; i < updates.length; i += capabilities.limits.maxBatchSize) {
      const chunk = updates.slice(i, i + capabilities.limits.maxBatchSize);
      const results = await client.updateInventory(chunk.map((u) => ({ skuCode: u.externalSku, quantity: u.quantity })));
      for (const u of chunk) out.push(perItem(u.externalSku, results));
    }
    return out;
  }

  async pushPrices(ctx: ConnectorContext, updates: PriceUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (let i = 0; i < updates.length; i += capabilities.limits.maxBatchSize) {
      const chunk = updates.slice(i, i + capabilities.limits.maxBatchSize);
      const results = await client.updatePrices(chunk.map((u) => ({ skuCode: u.externalSku, sellingPrice: (u.priceMinor / 100).toFixed(2) })));
      for (const u of chunk) out.push(perItem(u.externalSku, results));
    }
    return out;
  }

  // ---------------------------------------------------------------- orders (polled)
  async fetchOrders(ctx: ConnectorContext, { since, cursor }: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedOrder>> {
    const offset = cursor ? Number(cursor) || 0 : 0;
    const page = await this.client(ctx).releases({ modifiedAfter: since, offset, limit: 20 });
    const next = offset + page.releases.length;
    return { items: page.releases.map(mapRelease), nextCursor: page.releases.length > 0 && next < page.total ? String(next) : null };
  }

  async getOrder(ctx: ConnectorContext, { externalOrderId }: { externalOrderId: string }): Promise<NormalizedOrder | null> {
    try { return mapRelease(await this.client(ctx).release(externalOrderId)); }
    catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent' && e.code === 'not_found') return null;
      throw e;
    }
  }

  canRequestOrderStatus(status: InternalOrderStatus): boolean { return status in FORWARD; }

  async updateOrderStatus(ctx: ConnectorContext, input: { externalOrderId: string; status: InternalOrderStatus; tracking?: { number: string; carrier: string } }): Promise<OperationResult & { marketplaceStatus?: string }> {
    const to = FORWARD[input.status];
    if (!to) return { ok: false, errorCode: 'UNSUPPORTED_STATUS', message: `Myntra cannot be told "${input.status}"` };
    try {
      await this.client(ctx).transition(input.externalOrderId, { status: to, ...(to === 'SHIPPED' ? { courier: input.tracking?.carrier ?? 'Other', awb: input.tracking?.number ?? 'NA' } : {}) });
      return { ok: true, marketplaceStatus: to };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }
}
