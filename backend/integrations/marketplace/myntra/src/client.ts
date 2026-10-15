import { MarketplaceHttpClient, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';
import type { MynArticleType, MynAttributeRule, MynBulkResult, MynRelease, MynReleasesPage, MynStyle, MynStylesPage } from './dto';
import { mapMyntraError } from './errors';

export class MyntraClient {
  private readonly http: MarketplaceHttpClient;
  constructor(transport: HttpTransport, baseUrl: string, token: string) {
    this.http = new MarketplaceHttpClient({ baseUrl, transport, mapError: (res) => mapMyntraError(res), headers: { 'x-myntra-token': token, 'user-agent': 'OMS-Platform/1.0' } });
  }
  static from(ctx: ConnectorContext, transport: HttpTransport, baseUrl: string): MyntraClient { return new MyntraClient(transport, baseUrl, String(ctx.credentials.accessToken ?? '')); }

  async profile(): Promise<{ partnerId: string; name: string; active: boolean }> { return (await this.http.get<{ partnerId: string; name: string; active: boolean }>('/partner/v1/profile')).body; }

  async releases(o: { modifiedAfter?: Date; offset: number; limit: number }): Promise<MynReleasesPage> {
    return (await this.http.get<MynReleasesPage>('/partner/v1/releases', { offset: o.offset, limit: o.limit, ...(o.modifiedAfter ? { modifiedAfter: o.modifiedAfter.toISOString() } : {}) })).body;
  }
  async release(id: string): Promise<MynRelease> { return (await this.http.get<MynRelease>(`/partner/v1/releases/${encodeURIComponent(id)}`)).body; }
  async transition(id: string, body: { status: string; courier?: string; awb?: string }): Promise<void> { await this.http.post(`/partner/v1/releases/${encodeURIComponent(id)}/status`, body); }

  async styles(o: { offset: number; limit: number }): Promise<MynStylesPage> { return (await this.http.get<MynStylesPage>('/partner/v1/styles', { offset: o.offset, limit: o.limit })).body; }
  async style(sku: string): Promise<MynStyle> { return (await this.http.get<MynStyle>(`/partner/v1/styles/${encodeURIComponent(sku)}`)).body; }
  async upsertStyle(body: unknown): Promise<MynBulkResult> { return (await this.http.post<{ results: MynBulkResult }>('/partner/v1/styles', { styles: [body] })).body.results; }
  async updateInventory(items: Array<{ skuCode: string; quantity: number }>): Promise<MynBulkResult> { return (await this.http.post<{ results: MynBulkResult }>('/partner/v1/inventory', { items })).body.results; }
  async updatePrices(items: Array<{ skuCode: string; sellingPrice: string }>): Promise<MynBulkResult> { return (await this.http.post<{ results: MynBulkResult }>('/partner/v1/prices', { items })).body.results; }
  async disable(sku: string): Promise<void> { await this.http.post(`/partner/v1/styles/${encodeURIComponent(sku)}/disable`, {}); }

  async articleTypes(q?: string): Promise<MynArticleType[]> { return (await this.http.get<{ articleTypes: MynArticleType[] }>('/partner/v1/article-types', q ? { q } : {})).body.articleTypes; }
  async rules(articleType: string): Promise<MynAttributeRule[]> { return (await this.http.get<{ rules: MynAttributeRule[] }>(`/partner/v1/article-types/${encodeURIComponent(articleType)}/rules`)).body.rules; }
}
