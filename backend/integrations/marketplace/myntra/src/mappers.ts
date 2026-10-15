import {
  fromMinor, toMinor,
  type InternalOrderStatus, type ListingInput, type ListingIssue, type ListingReportStatus, type ListingRequirement, type ListingStatusReport, type NormalizedOrder, type NormalizedProduct,
} from '@oms/marketplace-core';
import type { MynAttributeRule, MynRelease, MynReleaseStatus, MynStyle, MynStyleError, MynStyleStatus } from './dto';

export const ORDER_STATUS_MAP: Record<MynReleaseStatus, InternalOrderStatus> = {
  CREATED: 'new', ACKNOWLEDGED: 'confirmed', PACKED: 'packed', READY_TO_SHIP: 'ready_to_dispatch', SHIPPED: 'dispatched', DELIVERED: 'delivered', CANCELLED: 'cancelled', RETURNED: 'returned',
};
export const toInternalOrderStatus = (s: string): InternalOrderStatus => ORDER_STATUS_MAP[s as MynReleaseStatus] ?? 'new';

/** a Myntra "release" is the order; its lines are the items. unitPrice/tax/discount are decimal strings per line. */
export function mapRelease(r: MynRelease): NormalizedOrder {
  const items = r.lines.map((l) => ({
    externalItemId: l.orderLineId, externalListingId: l.styleId, sku: l.skuCode, title: l.name, quantity: l.quantity,
    unitPriceMinor: toMinor(l.unitPrice), taxMinor: toMinor(l.tax), discountMinor: toMinor(l.discount),
  }));
  const total = items.reduce((n, i) => n + i.unitPriceMinor * i.quantity + i.taxMinor - i.discountMinor, 0);
  return {
    externalOrderId: r.releaseId, status: toInternalOrderStatus(r.status), marketplaceStatus: r.status, placedAt: new Date(r.createdOn), currency: 'INR', totalMinor: total,
    buyer: { name: r.customerName, email: r.customerEmail, phone: r.customerMobile },
    shippingAddress: r.address ? { name: r.customerName, line1: r.address.line1, city: r.address.city, state: r.address.state, pincode: r.address.zipcode, country: r.address.country } : undefined,
    payment: { method: r.paymentMode === 'COD' ? 'cod' : 'prepaid', ...(r.paymentMode === 'COD' ? { codAmountMinor: total } : {}) },
    items, raw: r,
  };
}

export const STYLE_STATUS_MAP: Record<MynStyleStatus, ListingReportStatus> = { LIVE: 'active', IN_REVIEW: 'pending', REJECTED: 'rejected', NEEDS_CHANGES: 'correction_required', DISABLED: 'inactive' };
export const toListingStatus = (s: string): ListingReportStatus => STYLE_STATUS_MAP[s as MynStyleStatus] ?? 'pending';
export const toIssues = (e?: MynStyleError[]): ListingIssue[] => (e ?? []).map((x) => ({ code: x.code, message: x.message, attribute: x.field, severity: x.warning ? 'warning' : 'error' }));

export function mapStyleReport(s: MynStyle): ListingStatusReport {
  return { externalSku: s.skuCode, externalListingId: s.styleId ?? s.skuCode, status: toListingStatus(s.status), marketplaceStatus: s.status, issues: toIssues(s.errors) };
}

export function mapStyleToProduct(s: MynStyle): NormalizedProduct {
  const r = mapStyleReport(s);
  return {
    externalListingId: r.externalListingId, externalSku: s.skuCode, title: s.name ?? s.skuCode, brand: s.brand, category: s.articleType ? { id: s.articleType, name: s.articleType } : undefined,
    priceMinor: s.sellingPrice ? toMinor(s.sellingPrice) : undefined, mrpMinor: s.mrp ? toMinor(s.mrp) : undefined, currency: 'INR', quantity: s.quantity, imageUrls: s.images,
    attributes: s.attributes ?? {}, status: r.status, marketplaceStatus: r.marketplaceStatus, raw: s,
  };
}

export const mapRules = (rules: MynAttributeRule[]): ListingRequirement[] =>
  rules.map((r) => ({
    name: r.field, label: r.label ?? r.field, required: r.required, type: r.kind === 'list' ? 'enum' : r.kind === 'text' ? 'string' : r.kind, allowedValues: r.options, maxLength: r.maxLen,
    coreField: r.field === 'name' ? 'title' : r.field === 'brand' ? 'brand' : r.field === 'description' ? 'description' : undefined,
  }));

export const buildStyle = (i: ListingInput) => ({
  skuCode: i.externalSku, name: i.title, brand: i.brand, description: i.description, articleType: i.marketplaceCategoryId, barcode: i.barcode,
  mrp: i.mrpMinor ? fromMinor(i.mrpMinor) : undefined, sellingPrice: fromMinor(i.priceMinor), quantity: i.quantity, attributes: i.attributes ?? {}, images: i.imageUrls ?? [],
});
