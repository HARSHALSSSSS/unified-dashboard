import {
  toMinor,
  type InternalOrderStatus, type ListingInput, type ListingIssue, type ListingReportStatus, type ListingRequirement, type ListingStatusReport, type NormalizedOrder, type NormalizedProduct,
} from '@oms/marketplace-core';
import type { SdFieldRule, SdOrder, SdOrderState, SdProduct, SdProductIssue, SdProductState } from './dto';

export const ORDER_STATUS_MAP: Record<SdOrderState, InternalOrderStatus> = {
  NEW: 'new', CONFIRMED: 'confirmed', PACKED: 'packed', MANIFESTED: 'ready_to_dispatch', HANDED_OVER: 'dispatched', IN_TRANSIT: 'in_transit', DELIVERED: 'delivered', CANCELLED: 'cancelled', RETURNED: 'returned',
};
export const toInternalOrderStatus = (s: string): InternalOrderStatus => ORDER_STATUS_MAP[s as SdOrderState] ?? 'new';

/** Snapdeal sellingPrice is the per-unit decimal price; taxAmount/discount are per suborder (line). */
export function mapOrder(o: SdOrder): NormalizedOrder {
  const items = o.suborders.map((s) => ({
    externalItemId: s.suborderCode, externalListingId: s.supc, sku: s.sellerSku, title: s.productName, quantity: s.qty,
    unitPriceMinor: toMinor(s.sellingPrice), taxMinor: toMinor(s.taxAmount), discountMinor: toMinor(s.discount),
  }));
  const total = items.reduce((n, i) => n + i.unitPriceMinor * i.quantity + i.taxMinor - i.discountMinor, 0);
  return {
    externalOrderId: o.orderCode, status: toInternalOrderStatus(o.state), marketplaceStatus: o.state, placedAt: new Date(o.orderDate), currency: 'INR', totalMinor: total,
    buyer: { name: o.customer?.name, email: o.customer?.email, phone: o.customer?.mobile },
    shippingAddress: o.shipTo ? { name: o.customer?.name, line1: o.shipTo.address, city: o.shipTo.city, state: o.shipTo.state, pincode: o.shipTo.pincode, country: o.shipTo.country } : undefined,
    payment: { method: o.paymentType === 'COD' ? 'cod' : 'prepaid', ...(o.paymentType === 'COD' ? { codAmountMinor: total } : {}) },
    items, raw: o,
  };
}

export const PRODUCT_STATE_MAP: Record<SdProductState, ListingReportStatus> = { LIVE: 'active', QC_PENDING: 'pending', QC_FAILED: 'rejected', NEEDS_INFO: 'correction_required', INACTIVE: 'inactive' };
export const toListingStatus = (s: string): ListingReportStatus => PRODUCT_STATE_MAP[s as SdProductState] ?? 'pending';
export const toIssues = (i?: SdProductIssue[]): ListingIssue[] => (i ?? []).map((x) => ({ code: x.code, message: x.message, attribute: x.field, severity: x.advisory ? 'warning' : 'error' }));

export function mapProductReport(p: SdProduct): ListingStatusReport {
  return { externalSku: p.sellerSku, externalListingId: p.supc ?? p.sellerSku, status: toListingStatus(p.state), marketplaceStatus: p.state, issues: toIssues(p.issues) };
}

export function mapProduct(p: SdProduct): NormalizedProduct {
  const r = mapProductReport(p);
  return {
    externalListingId: r.externalListingId, externalSku: p.sellerSku, title: p.productName ?? p.sellerSku, brand: p.brand, category: p.categoryId ? { id: p.categoryId, name: p.categoryId } : undefined,
    priceMinor: p.sellingPrice !== undefined ? toMinor(p.sellingPrice) : undefined, mrpMinor: p.mrp !== undefined ? toMinor(p.mrp) : undefined, currency: 'INR', quantity: p.stock, imageUrls: p.images,
    attributes: p.attributes ?? {}, status: r.status, marketplaceStatus: r.marketplaceStatus, raw: p,
  };
}

export const mapFields = (fields: SdFieldRule[]): ListingRequirement[] =>
  fields.map((f) => ({
    name: f.key, label: f.title ?? f.key, required: f.mandatory, type: f.dataType === 'LIST' ? 'enum' : f.dataType === 'NUMBER' ? 'number' : f.dataType === 'BOOLEAN' ? 'boolean' : 'string',
    allowedValues: f.allowed, maxLength: f.max, coreField: f.key === 'productName' ? 'title' : f.key === 'brand' ? 'brand' : f.key === 'description' ? 'description' : undefined,
  }));

export const buildProduct = (i: ListingInput) => ({
  sellerSku: i.externalSku, productName: i.title, brand: i.brand, description: i.description, categoryId: i.marketplaceCategoryId, barcode: i.barcode,
  mrp: i.mrpMinor ? i.mrpMinor / 100 : undefined, sellingPrice: i.priceMinor / 100, stock: i.quantity, attributes: i.attributes ?? {}, images: i.imageUrls ?? [],
});
