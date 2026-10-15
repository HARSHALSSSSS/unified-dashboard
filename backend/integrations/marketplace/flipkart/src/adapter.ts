import {
  ConnectorError,
  type ConnectorContext, type ConnectorCredentials, type CredentialSet, type HttpTransport, type InternalOrderStatus, type InventoryUpdate, type ListingInput, type ListingPreview,
  type ListingRequirement, type ListingResult, type ListingStatusReport, type MarketplaceCategory, type MarketplaceConnector, type NormalizedOrder, type NormalizedProduct,
  type NormalizedWebhook, type OperationResult, type Paged, type PriceUpdate, type RemoteAccount,
} from '@oms/marketplace-core';
import { FlipkartAuth } from './auth';
import { buildAuthorizeUrl } from './authorization';
import { capabilities, polling, readiness } from './capabilities';
import { FlipkartClient } from './client';
import type { FkBulkResult } from './dto';
import { selectTarget, targetOf, type FlipkartAppCredentials, type Target } from './environment';
import { buildListingRecord, mapListingReport, mapListingToProduct, mapRequirements, mapShipment, toIssues, toListingStatus } from './mappers';
import { flipkartSimulator } from './simulator';
import { parseWebhook, verifyWebhook } from './webhooks';

export interface FlipkartOptions {
  /** platform-level Flipkart application (FLIPKART_APP_ID / _SECRET) for the authorization-code flow. Sandbox needs none. */
  app?: FlipkartAppCredentials;
  simulator?: HttpTransport;
  now?: () => number;
}

const SANDBOX_APP: FlipkartAppCredentials = { appId: 'sandbox-app', appSecret: 'sandbox-secret' };
const SCOPES = ['Seller_Api'];

const itemResult = (sku: string, r: FkBulkResult[string] | undefined): OperationResult =>
  !r ? { externalSku: sku, ok: false, errorCode: 'NO_RESULT', message: 'Flipkart returned no result for this SKU' }
    : r.status === 'SUCCESS' ? { externalSku: sku, ok: true } : { externalSku: sku, ok: false, errorCode: r.errors?.[0]?.code, message: r.errors?.[0]?.message };

export class FlipkartConnector implements MarketplaceConnector {
  readonly code = 'flipkart' as const;
  readonly displayName = 'Flipkart Seller API';
  readonly implementation = 'beta' as const;
  readonly capabilities = capabilities;
  readonly readiness = readiness;
  readonly polling = polling;
  readonly webhook = { signatureHeader: 'x-flipkart-signature', algorithm: 'HMAC-SHA256 (base64) of the raw body', description: 'Register this URL as the callback in the Flipkart seller dashboard and set the secret below as the signing secret (signature scheme is provisional until verified against Flipkart)' };

  private readonly app: FlipkartAppCredentials;
  private readonly simulator: HttpTransport;
  private readonly now: () => number;

  constructor(opts: FlipkartOptions = {}) {
    this.app = opts.app ?? SANDBOX_APP;
    this.simulator = opts.simulator ?? flipkartSimulator;
    this.now = opts.now ?? Date.now;
  }

  private client(ctx: ConnectorContext): FlipkartClient { const t = targetOf(ctx, this.simulator); return FlipkartClient.from(ctx, t.transport, t.baseUrl); }
  private auth(target: Target, app: FlipkartAppCredentials): FlipkartAuth { return new FlipkartAuth(target.transport, target.baseUrl, app.appId, app.appSecret, this.now); }

  // ---------------------------------------------------------------- authorization
  buildAuthorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string { return buildAuthorizeUrl(this.app, state, redirectUri); }

  async exchangeAuthorizationCode(input: { code: string; redirectUri?: string; externalAccountId?: string; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    const target = selectTarget(input, this.simulator);
    const tokens = await this.auth(target, this.app).exchangeCode(input.code, input.redirectUri ?? '');
    const profile = await new FlipkartClient(target.transport, target.baseUrl, tokens.accessToken).profile();
    if (!profile.active) throw new ConnectorError('auth', 'The Flipkart seller account is not active', { code: 'seller_inactive' });
    return { externalAccountId: profile.sellerId, credentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, sellerId: profile.sellerId }, expiresAt: tokens.expiresAt, scopes: SCOPES };
  }

  /** self-access: the seller's own application { appId, appSecret } (client-credentials grant) */
  async authenticate({ credentials, mode, config }: { credentials: ConnectorCredentials; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    const appId = typeof credentials.appId === 'string' ? credentials.appId.trim() : '';
    const appSecret = typeof credentials.appSecret === 'string' ? credentials.appSecret.trim() : '';
    if (!appId || !appSecret) throw new ConnectorError('auth', 'appId and appSecret are required', { code: 'invalid_credentials' });
    const target = selectTarget({ mode, config }, this.simulator);
    const tokens = await this.auth(target, { appId, appSecret }).clientCredentials();
    const profile = await new FlipkartClient(target.transport, target.baseUrl, tokens.accessToken).profile();
    if (!profile.active) throw new ConnectorError('auth', 'The Flipkart seller account is not active', { code: 'seller_inactive' });
    return { externalAccountId: profile.sellerId, credentials: { appId, appSecret, accessToken: tokens.accessToken, sellerId: profile.sellerId }, expiresAt: tokens.expiresAt, scopes: SCOPES };
  }

  async refreshCredentials(ctx: ConnectorContext): Promise<CredentialSet> {
    const target = targetOf(ctx, this.simulator);
    const refreshToken = typeof ctx.credentials.refreshToken === 'string' ? ctx.credentials.refreshToken : undefined;
    if (refreshToken) {
      const t = await this.auth(target, this.app).refresh(refreshToken);
      return { credentials: { ...ctx.credentials, accessToken: t.accessToken, refreshToken: t.refreshToken ?? refreshToken }, expiresAt: t.expiresAt, scopes: SCOPES };
    }
    const t = await this.auth(target, { appId: String(ctx.credentials.appId ?? ''), appSecret: String(ctx.credentials.appSecret ?? '') }).clientCredentials();
    return { credentials: { ...ctx.credentials, accessToken: t.accessToken }, expiresAt: t.expiresAt, scopes: SCOPES };
  }

  async verifyConnection(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    const p = await this.client(ctx).profile();
    return { ok: p.active, message: p.active ? `Seller ${p.sellerId} is active` : 'Seller account is not active' };
  }

  async getAccount(ctx: ConnectorContext): Promise<RemoteAccount> {
    const p = await this.client(ctx).profile();
    return { externalAccountId: p.sellerId, displayName: p.name, region: 'IN', status: p.active ? 'active' : 'inactive', scopes: SCOPES };
  }

  // ---------------------------------------------------------------- catalogue / categories
  async importProducts(ctx: ConnectorContext, { cursor, limit = 10 }: { cursor?: string | null; limit?: number }): Promise<Paged<NormalizedProduct>> {
    const page = await this.client(ctx).listings({ pageToken: cursor, pageSize: Math.min(limit, 50) });
    return { items: page.listings.map(mapListingToProduct), nextCursor: page.hasMore ? page.nextPageToken ?? null : null };
  }

  async searchCategories(ctx: ConnectorContext, { query }: { query?: string; parentId?: string | null }): Promise<MarketplaceCategory[]> {
    return (await this.client(ctx).categories(query)).map((c) => ({ id: c.id, name: c.name, path: c.path ?? c.name, parentId: null, leaf: c.leaf }));
  }

  async getCategoryRequirements(ctx: ConnectorContext, { marketplaceCategoryId }: { marketplaceCategoryId: string }): Promise<ListingRequirement[]> {
    return mapRequirements(await this.client(ctx).attributes(marketplaceCategoryId));
  }

  // ---------------------------------------------------------------- listings
  previewListing(input: ListingInput): ListingPreview {
    const warnings: string[] = [];
    if (!input.imageUrls?.length) warnings.push('No image URLs: Flipkart will not activate a listing without images');
    if (!input.mrpMinor) warnings.push('No MRP: Flipkart requires MRP for most categories');
    return { endpoint: 'POST /sellers/v3/listings', payload: { listings: [buildListingRecord(input)] }, warnings };
  }

  async createListing(ctx: ConnectorContext, input: ListingInput): Promise<ListingResult> {
    const results = await this.client(ctx).upsertListings([buildListingRecord(input)]);
    const r = results[input.externalSku];
    const issues = toIssues(r?.errors);
    const failed = r?.status === 'FAILURE';
    const status = failed ? (issues.some((i) => i.severity === 'error' && !i.attribute) ? 'rejected' : 'correction_required') : 'pending';
    return { externalListingId: input.externalSku, status, marketplaceStatus: failed ? 'REJECTED_AT_SUBMISSION' : 'PENDING_REVIEW', issues };
  }

  async updateListing(ctx: ConnectorContext, input: ListingInput & { externalListingId: string }): Promise<ListingResult> {
    return { ...(await this.createListing(ctx, input)), externalListingId: input.externalListingId };
  }

  async getListingStatus(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<ListingStatusReport> {
    return mapListingReport(await this.client(ctx).getListing(externalSku));
  }

  async deactivateListing(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<OperationResult> {
    try { await this.client(ctx).deactivate(externalSku); return { externalSku, ok: true }; }
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
      const results = await client.updateInventory(chunk.map((u) => ({ sku: u.externalSku, quantity: u.quantity })));
      for (const u of chunk) out.push(itemResult(u.externalSku, results[u.externalSku]));
    }
    return out;
  }

  async pushPrices(ctx: ConnectorContext, updates: PriceUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (let i = 0; i < updates.length; i += capabilities.limits.maxBatchSize) {
      const chunk = updates.slice(i, i + capabilities.limits.maxBatchSize);
      const results = await client.updatePrices(chunk.map((u) => ({ sku: u.externalSku, sellingPrice: u.priceMinor / 100, currency: u.currency })));
      for (const u of chunk) out.push(itemResult(u.externalSku, results[u.externalSku]));
    }
    return out;
  }

  // ---------------------------------------------------------------- orders
  async fetchOrders(ctx: ConnectorContext, { since, cursor }: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedOrder>> {
    const page = await this.client(ctx).searchShipments({ updatedAfter: since, pageToken: cursor, pageSize: 20 });
    return { items: page.shipments.map(mapShipment), nextCursor: page.hasMore ? page.nextPageToken ?? null : null };
  }

  async getOrder(ctx: ConnectorContext, { externalOrderId }: { externalOrderId: string }): Promise<NormalizedOrder | null> {
    try { return mapShipment(await this.client(ctx).getShipment(externalOrderId)); }
    catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent' && e.code === 'not_found') return null;
      throw e;
    }
  }

  canRequestOrderStatus(status: InternalOrderStatus): boolean { return status === 'dispatched' || status === 'cancelled'; }

  async updateOrderStatus(ctx: ConnectorContext, input: { externalOrderId: string; status: InternalOrderStatus; items?: Array<{ externalItemId: string; sku: string; quantity: number }>; tracking?: { number: string; carrier: string } }): Promise<OperationResult & { marketplaceStatus?: string }> {
    if (!this.canRequestOrderStatus(input.status)) return { ok: false, errorCode: 'UNSUPPORTED_STATUS', message: `Flipkart cannot be told "${input.status}"` };
    const client = this.client(ctx);
    try {
      if (input.status === 'dispatched') {
        await client.dispatch(input.externalOrderId, { trackingId: input.tracking?.number ?? 'NA', courierName: input.tracking?.carrier ?? 'Other' });
        return { ok: true, marketplaceStatus: 'SHIPPED' };
      }
      await client.cancelShipment(input.externalOrderId, 'Cancelled by seller');
      return { ok: true, marketplaceStatus: 'CANCELLED' };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }

  // ---------------------------------------------------------------- webhooks
  verifyWebhook = verifyWebhook;
  parseWebhook(input: { headers: Record<string, string | undefined>; body: unknown }): NormalizedWebhook | null { return parseWebhook(input); }
}

export { toListingStatus };
