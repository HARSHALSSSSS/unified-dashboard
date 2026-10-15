import {
  ConnectorError,
  type ConnectorContext, type ConnectorCredentials, type CredentialSet, type HttpTransport, type InternalOrderStatus, type InventoryUpdate, type ListingInput, type ListingPreview,
  type ListingRequirement, type ListingResult, type ListingStatusReport, type MarketplaceCategory, type MarketplaceConnector, type NormalizedOrder, type NormalizedProduct,
  type NormalizedWebhook, type OperationResult, type Paged, type PriceUpdate, type RemoteAccount,
} from '@oms/marketplace-core';
import { LwaAuth } from './auth';
import { buildConsentUrl } from './authorization';
import { PRODUCT_TYPE_REQUIREMENTS, capabilities, polling, readiness } from './capabilities';
import { AmazonClient } from './client';
import { INDIA_MARKETPLACE_ID, marketplaceIdOf, selectTarget, targetOf, type AmazonAppCredentials, type Target } from './environment';
import { buildPutBody, inventoryPatch, mapListingReport, mapListingToProduct, mapOrder, mapSubmission, pricePatch } from './mappers';
import { amazonSimulator } from './simulator';
import { parseWebhook, verifyWebhook } from './webhooks';

export interface AmazonOptions {
  /** platform-level SP-API application credentials (AMAZON_IN_LWA_CLIENT_ID / _SECRET). Sandbox needs none. */
  app?: AmazonAppCredentials;
  /** transport used for sandbox accounts whose target is "simulator" */
  simulator?: HttpTransport;
  now?: () => number;
}

const SCOPES = ['orders', 'listings', 'catalog', 'notifications'];
const SANDBOX_APP: AmazonAppCredentials = { clientId: 'sandbox-client-id', clientSecret: 'sandbox-client-secret' };

export class AmazonIndiaConnector implements MarketplaceConnector {
  readonly code = 'amazon_in' as const;
  readonly displayName = 'Amazon India (SP-API)';
  readonly implementation = 'beta' as const;
  readonly capabilities = capabilities;
  readonly readiness = readiness;
  readonly polling = polling;
  readonly webhook = { signatureHeader: 'x-oms-signature', algorithm: 'HMAC-SHA256 (hex) of the raw body', description: 'SP-API notifications arrive via SQS/EventBridge; the ingress bridge re-posts each one to this URL signed with the secret below' };

  private readonly app: AmazonAppCredentials;
  private readonly simulator: HttpTransport;
  private readonly now: () => number;

  constructor(private readonly opts: AmazonOptions = {}) {
    this.app = opts.app ?? SANDBOX_APP;
    this.simulator = opts.simulator ?? amazonSimulator;
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------- plumbing
  private auth(target: Target): LwaAuth { return new LwaAuth(target.transport, target.lwaBaseUrl, this.app, this.now); }
  private client(ctx: ConnectorContext): AmazonClient {
    const t = targetOf(ctx, this.simulator);
    return AmazonClient.from(ctx, t.transport, t.baseUrl, marketplaceIdOf(ctx.config));
  }
  private async assertParticipates(target: Target, sellerId: string, accessToken: string, marketplaceId: string): Promise<void> {
    const c = new AmazonClient(target.transport, target.baseUrl, accessToken, sellerId, marketplaceId);
    const p = await c.participations();
    if (!p.some((x) => x.marketplace.id === marketplaceId && x.participation.isParticipating)) {
      throw new ConnectorError('auth', 'This seller account does not participate in Amazon.in', { code: 'not_participating' });
    }
  }

  // ---------------------------------------------------------------- authorization
  buildAuthorizationUrl({ state }: { state: string; redirectUri: string }): string {
    return buildConsentUrl(this.app, state);
  }

  async exchangeAuthorizationCode(input: { code: string; redirectUri?: string; externalAccountId?: string; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    if (!input.externalAccountId) throw new ConnectorError('permanent', 'selling_partner_id (returned by Amazon with the authorization code) is required', { code: 'missing_selling_partner_id' });
    const target = selectTarget(input, this.simulator);
    const tokens = await this.auth(target).exchangeCode(input.code, input.redirectUri);
    if (!tokens.refreshToken) throw new ConnectorError('auth', 'Amazon did not return a refresh token', { code: 'no_refresh_token' });
    const marketplaceId = marketplaceIdOf(input.config);
    await this.assertParticipates(target, input.externalAccountId, tokens.accessToken, marketplaceId);
    return { externalAccountId: input.externalAccountId, credentials: { sellerId: input.externalAccountId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, marketplaceId }, expiresAt: tokens.expiresAt, scopes: SCOPES };
  }

  /** Self-authorized seller: { sellerId, refreshToken } (private application) */
  async authenticate({ credentials, mode, config }: { credentials: ConnectorCredentials; mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }): Promise<CredentialSet & { externalAccountId: string }> {
    const sellerId = typeof credentials.sellerId === 'string' ? credentials.sellerId.trim() : '';
    const refreshToken = typeof credentials.refreshToken === 'string' ? credentials.refreshToken.trim() : '';
    if (!sellerId || !refreshToken) throw new ConnectorError('auth', 'sellerId and refreshToken are required', { code: 'invalid_credentials' });
    const target = selectTarget({ mode, config }, this.simulator);
    const tokens = await this.auth(target).refresh(refreshToken);
    const marketplaceId = marketplaceIdOf(config);
    await this.assertParticipates(target, sellerId, tokens.accessToken, marketplaceId);
    return { externalAccountId: sellerId, credentials: { sellerId, refreshToken, accessToken: tokens.accessToken, marketplaceId }, expiresAt: tokens.expiresAt, scopes: SCOPES };
  }

  async refreshCredentials(ctx: ConnectorContext): Promise<CredentialSet> {
    const refreshToken = String(ctx.credentials.refreshToken ?? '');
    const tokens = await this.auth(targetOf(ctx, this.simulator)).refresh(refreshToken);
    return { credentials: { ...ctx.credentials, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? refreshToken }, expiresAt: tokens.expiresAt, scopes: SCOPES };
  }

  async verifyConnection(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    const marketplaceId = marketplaceIdOf(ctx.config);
    const p = await this.client(ctx).participations();
    const ok = p.some((x) => x.marketplace.id === marketplaceId && x.participation.isParticipating);
    return { ok, message: ok ? 'Participating in Amazon.in' : 'Seller does not participate in Amazon.in' };
  }

  async getAccount(ctx: ConnectorContext): Promise<RemoteAccount> {
    const p = await this.client(ctx).participations();
    const mp = p.find((x) => x.marketplace.id === marketplaceIdOf(ctx.config)) ?? p[0];
    return { externalAccountId: String(ctx.externalAccountId ?? ctx.credentials.sellerId), displayName: `${mp?.marketplace.name ?? 'Amazon.in'} seller ${ctx.externalAccountId}`, region: mp?.marketplace.countryCode ?? 'IN', status: mp?.participation.isParticipating ? 'active' : 'inactive', scopes: SCOPES };
  }

  // ---------------------------------------------------------------- catalogue / categories
  async importProducts(ctx: ConnectorContext, { cursor, limit = 10 }: { cursor?: string | null; limit?: number }): Promise<Paged<NormalizedProduct>> {
    const page = await this.client(ctx).searchListings({ pageToken: cursor, pageSize: Math.min(limit, 20) });
    return { items: page.items.map((i) => mapListingToProduct(i, marketplaceIdOf(ctx.config))), nextCursor: page.pagination?.nextToken ?? null };
  }

  async searchCategories(ctx: ConnectorContext, { query }: { query?: string; parentId?: string | null }): Promise<MarketplaceCategory[]> {
    const r = await this.client(ctx).searchProductTypes(query);
    return r.productTypes.map((p) => ({ id: p.name, name: p.displayName, path: p.displayName, parentId: null, leaf: true }));
  }

  async getCategoryRequirements(_ctx: ConnectorContext, { marketplaceCategoryId }: { marketplaceCategoryId: string }): Promise<ListingRequirement[]> {
    const reqs = PRODUCT_TYPE_REQUIREMENTS[marketplaceCategoryId];
    if (!reqs) throw new ConnectorError('permanent', `Requirements for product type ${marketplaceCategoryId} are not configured in this connector`, { code: 'unknown_product_type', field: 'marketplaceCategoryId' });
    return reqs;
  }

  // ---------------------------------------------------------------- listings
  previewListing(input: ListingInput): ListingPreview {
    const warnings: string[] = [];
    if (!input.imageUrls?.length) warnings.push('No main image URL: Amazon will not make the listing buyable without images');
    if (!input.barcode) warnings.push('No EAN: the listing may require a GTIN exemption or brand registry');
    return { endpoint: `PUT /listings/2021-08-01/items/{sellerId}/${encodeURIComponent(input.externalSku)}?marketplaceIds=${INDIA_MARKETPLACE_ID}`, payload: buildPutBody(input, INDIA_MARKETPLACE_ID), warnings };
  }

  async createListing(ctx: ConnectorContext, input: ListingInput): Promise<ListingResult> {
    const sub = await this.client(ctx).putListing(input.externalSku, buildPutBody(input, marketplaceIdOf(ctx.config)));
    return mapSubmission(sub);
  }

  async updateListing(ctx: ConnectorContext, input: ListingInput & { externalListingId: string }): Promise<ListingResult> {
    // PUT replaces the listing; the SKU is the stable identifier. Keep the id the caller already knows (an ASIN once assigned).
    return { ...(await this.createListing(ctx, input)), externalListingId: input.externalListingId };
  }

  async getListingStatus(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<ListingStatusReport> {
    return mapListingReport(await this.client(ctx).getListing(externalSku));
  }

  async deactivateListing(ctx: ConnectorContext, { externalSku }: { externalSku: string }): Promise<OperationResult> {
    try {
      await this.client(ctx).deleteListing(externalSku);
      return { externalSku, ok: true };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { externalSku, ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }

  // ---------------------------------------------------------------- inventory / pricing (one SKU per call on Amazon)
  async pushInventory(ctx: ConnectorContext, updates: InventoryUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (const u of updates) {
      try {
        const type = (await client.getListing(u.externalSku, 'summaries')).summaries?.[0]?.productType ?? 'PRODUCT';
        const sub = await client.patchListing(u.externalSku, inventoryPatch(type, u.quantity));
        out.push(sub.status === 'INVALID' ? { externalSku: u.externalSku, ok: false, errorCode: sub.issues[0]?.code, message: sub.issues[0]?.message } : { externalSku: u.externalSku, ok: true });
      } catch (e) {
        // permanent per-SKU problems are reported per item; auth / rate limit / outages abort the batch so the host can retry
        if (e instanceof ConnectorError && e.kind === 'permanent') out.push({ externalSku: u.externalSku, ok: false, errorCode: e.code, message: e.message });
        else throw e;
      }
    }
    return out;
  }

  async pushPrices(ctx: ConnectorContext, updates: PriceUpdate[]): Promise<OperationResult[]> {
    const client = this.client(ctx);
    const out: OperationResult[] = [];
    for (const u of updates) {
      try {
        const type = (await client.getListing(u.externalSku, 'summaries')).summaries?.[0]?.productType ?? 'PRODUCT';
        await client.patchListing(u.externalSku, pricePatch(type, marketplaceIdOf(ctx.config), u.currency, u.priceMinor));
        out.push({ externalSku: u.externalSku, ok: true });
      } catch (e) {
        if (e instanceof ConnectorError && e.kind === 'permanent') out.push({ externalSku: u.externalSku, ok: false, errorCode: e.code, message: e.message });
        else throw e;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- orders
  async fetchOrders(ctx: ConnectorContext, { since, cursor }: { since: Date; cursor?: string | null }): Promise<Paged<NormalizedOrder>> {
    const client = this.client(ctx);
    const { body } = await client.listOrders({ lastUpdatedAfter: since, nextToken: cursor });
    const orders: NormalizedOrder[] = [];
    for (const o of body.payload.Orders) orders.push(mapOrder(o, (await client.orderItems(o.AmazonOrderId)).body.payload.OrderItems));
    return { items: orders, nextCursor: body.payload.NextToken ?? null };
  }

  async getOrder(ctx: ConnectorContext, { externalOrderId }: { externalOrderId: string }): Promise<NormalizedOrder | null> {
    const client = this.client(ctx);
    try {
      const order = await client.getOrder(externalOrderId);
      return mapOrder(order, (await client.orderItems(externalOrderId)).body.payload.OrderItems);
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent' && e.code === 'NotFound') return null;
      throw e;
    }
  }

  canRequestOrderStatus(status: InternalOrderStatus): boolean { return status === 'dispatched'; }

  async updateOrderStatus(ctx: ConnectorContext, input: { externalOrderId: string; status: InternalOrderStatus; items?: Array<{ externalItemId: string; sku: string; quantity: number }>; tracking?: { number: string; carrier: string } }): Promise<OperationResult & { marketplaceStatus?: string }> {
    if (input.status !== 'dispatched') return { ok: false, errorCode: 'UNSUPPORTED_STATUS', message: 'Amazon only accepts a shipment confirmation (dispatched)' };
    const client = this.client(ctx);
    try {
      const items = input.items ?? (await client.orderItems(input.externalOrderId)).body.payload.OrderItems.map((i) => ({ externalItemId: i.OrderItemId, sku: i.SellerSKU, quantity: i.QuantityOrdered }));
      await client.confirmShipment(input.externalOrderId, {
        marketplaceId: marketplaceIdOf(ctx.config),
        packageDetail: {
          packageReferenceId: '1', carrierCode: 'Other', carrierName: input.tracking?.carrier ?? 'Other', trackingNumber: input.tracking?.number ?? 'NA',
          shipDate: new Date(this.now()).toISOString(), orderItems: items.map((i) => ({ orderItemId: i.externalItemId, quantity: i.quantity })),
        },
      });
      return { ok: true, marketplaceStatus: 'Shipped' };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'permanent') return { ok: false, errorCode: e.code, message: e.message };
      throw e;
    }
  }

  // ---------------------------------------------------------------- webhooks
  verifyWebhook = verifyWebhook;
  parseWebhook(input: { headers: Record<string, string | undefined>; body: unknown }): NormalizedWebhook | null { return parseWebhook(input); }

}
