import { MarketplaceHttpClient, type ConnectorContext, type HttpResponse, type HttpTransport } from '@oms/marketplace-core';
import type {
  AmzListingsItem, AmzListingsSearchPage, AmzMarketplaceParticipation, AmzOrder, AmzOrderItemsPage, AmzOrdersPage, AmzProductTypeSearch, AmzSubmission,
} from './dto';
import { mapAmazonError } from './errors';

const LISTINGS = '/listings/2021-08-01/items';

/** Typed SP-API calls. All HTTP concerns (headers, errors) live here; mapping to platform models lives in mappers.ts. */
export class AmazonClient {
  private readonly http: MarketplaceHttpClient;
  /** last observed steady-state rate (requests/second) reported by Amazon */
  lastRateLimit?: number;

  constructor(transport: HttpTransport, baseUrl: string, accessToken: string, readonly sellerId: string, readonly marketplaceId: string) {
    this.http = new MarketplaceHttpClient({
      baseUrl,
      transport,
      headers: { 'x-amz-access-token': accessToken, 'user-agent': 'OMS-Platform/1.0 (Language=TypeScript)' },
      mapError: (res) => mapAmazonError(res),
      onResponse: (res: HttpResponse) => { const l = Number(res.headers['x-amzn-ratelimit-limit']); if (Number.isFinite(l) && l > 0) this.lastRateLimit = l; },
    });
  }

  static from(ctx: ConnectorContext, transport: HttpTransport, baseUrl: string, marketplaceId: string): AmazonClient {
    return new AmazonClient(transport, baseUrl, String(ctx.credentials.accessToken ?? ''), String(ctx.credentials.sellerId ?? ctx.externalAccountId ?? ''), marketplaceId);
  }

  async participations(): Promise<AmzMarketplaceParticipation[]> {
    return (await this.http.get<{ payload: AmzMarketplaceParticipation[] }>('/sellers/v1/marketplaceParticipations')).body.payload;
  }

  listOrders(o: { lastUpdatedAfter: Date; nextToken?: string | null }): Promise<{ body: AmzOrdersPage }> {
    return this.http.get<AmzOrdersPage>('/orders/v0/orders', o.nextToken
      ? { MarketplaceIds: this.marketplaceId, NextToken: o.nextToken }
      : { MarketplaceIds: this.marketplaceId, LastUpdatedAfter: o.lastUpdatedAfter.toISOString() });
  }

  async getOrder(orderId: string): Promise<AmzOrder> { return (await this.http.get<{ payload: AmzOrder }>(`/orders/v0/orders/${encodeURIComponent(orderId)}`)).body.payload; }

  orderItems(orderId: string) { return this.http.get<AmzOrderItemsPage>(`/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`); }

  async confirmShipment(orderId: string, body: unknown): Promise<void> {
    await this.http.post(`/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`, body);
  }

  async getListing(sku: string, includedData = 'summaries,issues,offers,fulfillmentAvailability'): Promise<AmzListingsItem> {
    return (await this.http.get<AmzListingsItem>(`${LISTINGS}/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(sku)}`, { marketplaceIds: this.marketplaceId, includedData })).body;
  }

  async putListing(sku: string, body: unknown): Promise<AmzSubmission> {
    return (await this.http.put<AmzSubmission>(`${LISTINGS}/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(sku)}`, body, { marketplaceIds: this.marketplaceId, issueLocale: 'en_IN' })).body;
  }

  async patchListing(sku: string, body: unknown): Promise<AmzSubmission> {
    return (await this.http.patch<AmzSubmission>(`${LISTINGS}/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(sku)}`, body, { marketplaceIds: this.marketplaceId, issueLocale: 'en_IN' })).body;
  }

  async deleteListing(sku: string): Promise<AmzSubmission> {
    return (await this.http.delete<AmzSubmission>(`${LISTINGS}/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(sku)}`, { marketplaceIds: this.marketplaceId })).body;
  }

  async searchListings(o: { pageToken?: string | null; pageSize: number }): Promise<AmzListingsSearchPage> {
    return (await this.http.get<AmzListingsSearchPage>(`${LISTINGS}/${encodeURIComponent(this.sellerId)}`, {
      marketplaceIds: this.marketplaceId, pageSize: o.pageSize, includedData: 'summaries,attributes,offers,fulfillmentAvailability', ...(o.pageToken ? { pageToken: o.pageToken } : {}),
    })).body;
  }

  async searchProductTypes(keywords?: string): Promise<AmzProductTypeSearch> {
    return (await this.http.get<AmzProductTypeSearch>('/definitions/2020-09-01/productTypes', { marketplaceIds: this.marketplaceId, ...(keywords ? { keywords } : {}) })).body;
  }
}
