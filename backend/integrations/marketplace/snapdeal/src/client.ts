import { MarketplaceHttpClient, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';
import type { SdBulkResult, SdCategory, SdFieldRule, SdOrder, SdOrdersPage, SdProduct, SdProductsPage } from './dto';
import { mapSnapdealError } from './errors';

/** Snapdeal authenticates every call with the seller's static auth token + seller id (no OAuth, nothing to refresh). */
export class SnapdealClient {
  private readonly http: MarketplaceHttpClient;
  constructor(transport: HttpTransport, baseUrl: string, sellerId: string, authToken: string) {
    this.http = new MarketplaceHttpClient({ baseUrl, transport, mapError: (res) => mapSnapdealError(res), headers: { 'x-seller-id': sellerId, 'x-auth-token': authToken, 'user-agent': 'OMS-Platform/1.0' } });
  }
  static from(ctx: ConnectorContext, transport: HttpTransport, baseUrl: string): SnapdealClient {
    return new SnapdealClient(transport, baseUrl, String(ctx.credentials.sellerId ?? ctx.externalAccountId ?? ''), String(ctx.credentials.authToken ?? ''));
  }

  async profile(): Promise<{ sellerId: string; storeName: string; active: boolean }> { return (await this.http.get<{ sellerId: string; storeName: string; active: boolean }>('/seller/v1/profile')).body; }

  async orders(o: { updatedSince?: Date; page: number; pageSize: number }): Promise<SdOrdersPage> {
    return (await this.http.get<SdOrdersPage>('/seller/v1/orders', { page: o.page, pageSize: o.pageSize, ...(o.updatedSince ? { updatedSince: o.updatedSince.toISOString() } : {}) })).body;
  }
  async order(code: string): Promise<SdOrder> { return (await this.http.get<SdOrder>(`/seller/v1/orders/${encodeURIComponent(code)}`)).body; }
  async changeState(code: string, body: { state: string; courier?: string; awb?: string; reason?: string }): Promise<void> { await this.http.put(`/seller/v1/orders/${encodeURIComponent(code)}/state`, body); }

  async products(o: { page: number; pageSize: number }): Promise<SdProductsPage> { return (await this.http.get<SdProductsPage>('/seller/v1/products', { page: o.page, pageSize: o.pageSize })).body; }
  async product(sku: string): Promise<SdProduct> { return (await this.http.get<SdProduct>(`/seller/v1/products/${encodeURIComponent(sku)}`)).body; }
  async upsertProduct(body: unknown): Promise<SdBulkResult> { return (await this.http.post<{ results: SdBulkResult }>('/seller/v1/products', { products: [body] })).body.results; }
  async stock(items: Array<{ sellerSku: string; stock: number }>): Promise<SdBulkResult> { return (await this.http.post<{ results: SdBulkResult }>('/seller/v1/stock/bulk', { items })).body.results; }
  async prices(items: Array<{ sellerSku: string; sellingPrice: number }>): Promise<SdBulkResult> { return (await this.http.post<{ results: SdBulkResult }>('/seller/v1/prices/bulk', { items })).body.results; }
  async deactivate(sku: string): Promise<void> { await this.http.put(`/seller/v1/products/${encodeURIComponent(sku)}/deactivate`, {}); }

  async categories(q?: string): Promise<SdCategory[]> { return (await this.http.get<{ categories: SdCategory[] }>('/seller/v1/categories', q ? { q } : {})).body.categories; }
  async fieldRules(categoryId: string): Promise<SdFieldRule[]> { return (await this.http.get<{ fields: SdFieldRule[] }>(`/seller/v1/categories/${encodeURIComponent(categoryId)}/fields`)).body.fields; }
}
