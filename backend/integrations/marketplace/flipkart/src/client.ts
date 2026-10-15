import { MarketplaceHttpClient, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';
import type { FkAttributeDef, FkBulkResult, FkCategory, FkListingRecord, FkListingsPage, FkShipment, FkShipmentsPage } from './dto';
import { mapFlipkartError } from './errors';

/** Typed Flipkart Seller API calls. HTTP concerns live here; mapping to platform models lives in mappers.ts. */
export class FlipkartClient {
  private readonly http: MarketplaceHttpClient;

  constructor(transport: HttpTransport, baseUrl: string, accessToken: string) {
    this.http = new MarketplaceHttpClient({
      baseUrl, transport, mapError: (res) => mapFlipkartError(res),
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'OMS-Platform/1.0' },
    });
  }

  static from(ctx: ConnectorContext, transport: HttpTransport, baseUrl: string): FlipkartClient {
    return new FlipkartClient(transport, baseUrl, String(ctx.credentials.accessToken ?? ''));
  }

  async profile(): Promise<{ sellerId: string; name: string; active: boolean }> {
    return (await this.http.get<{ sellerId: string; name: string; active: boolean }>('/sellers/v3/profile')).body;
  }

  async searchShipments(o: { updatedAfter?: Date; pageToken?: string | null; pageSize: number }): Promise<FkShipmentsPage> {
    return (await this.http.post<FkShipmentsPage>('/sellers/v3/shipments/filter', {
      filter: { ...(o.updatedAfter ? { modifiedAfter: o.updatedAfter.toISOString() } : {}) }, pagination: { pageSize: o.pageSize, ...(o.pageToken ? { pageToken: o.pageToken } : {}) },
    })).body;
  }

  async getShipment(id: string): Promise<FkShipment> {
    return (await this.http.get<{ shipments: FkShipment[] }>('/sellers/v3/shipments', { shipmentIds: id })).body.shipments[0] as FkShipment;
  }

  async dispatch(shipmentId: string, body: { trackingId: string; courierName: string }): Promise<void> {
    await this.http.post('/sellers/v3/shipments/dispatch', { shipments: [{ shipmentId, ...body }] });
  }

  async cancelShipment(shipmentId: string, reason: string): Promise<void> {
    await this.http.post('/sellers/v3/shipments/cancel', { shipments: [{ shipmentId, reason }] });
  }

  async listings(o: { pageToken?: string | null; pageSize: number }): Promise<FkListingsPage> {
    return (await this.http.get<FkListingsPage>('/sellers/v3/listings', { pageSize: o.pageSize, ...(o.pageToken ? { pageToken: o.pageToken } : {}) })).body;
  }

  async getListing(sku: string): Promise<FkListingRecord> {
    return (await this.http.get<FkListingRecord>(`/sellers/v3/listings/${encodeURIComponent(sku)}`)).body;
  }

  /** create-or-replace: one record per SKU, per-SKU result map (Flipkart's bulk style) */
  async upsertListings(records: unknown[]): Promise<FkBulkResult> {
    return (await this.http.post<{ results: FkBulkResult }>('/sellers/v3/listings', { listings: records })).body.results;
  }

  async updateInventory(items: Array<{ sku: string; quantity: number }>): Promise<FkBulkResult> {
    return (await this.http.post<{ results: FkBulkResult }>('/sellers/v3/listings/inventory', { items })).body.results;
  }

  async updatePrices(items: Array<{ sku: string; sellingPrice: number; currency: string }>): Promise<FkBulkResult> {
    return (await this.http.post<{ results: FkBulkResult }>('/sellers/v3/listings/price', { items })).body.results;
  }

  async deactivate(sku: string): Promise<void> {
    await this.http.post(`/sellers/v3/listings/${encodeURIComponent(sku)}/deactivate`, {});
  }

  async categories(q?: string): Promise<FkCategory[]> {
    return (await this.http.get<{ categories: FkCategory[] }>('/sellers/v3/categories', q ? { q } : {})).body.categories;
  }

  async attributes(categoryId: string): Promise<FkAttributeDef[]> {
    return (await this.http.get<{ attributes: FkAttributeDef[] }>(`/sellers/v3/categories/${encodeURIComponent(categoryId)}/attributes`)).body.attributes;
  }
}
