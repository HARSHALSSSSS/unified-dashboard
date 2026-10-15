import {
  fromMinor, toMinor,
  type InternalOrderStatus, type ListingInput, type ListingIssue, type ListingReportStatus, type ListingRequirement, type ListingStatusReport, type NormalizedOrder, type NormalizedProduct,
} from '@oms/marketplace-core';
import type { FkAttributeDef, FkListingError, FkListingRecord, FkListingState, FkShipment, FkShipmentState } from './dto';

/** Flipkart shipment state -> internal. The original word stays on the order as `marketplaceStatus`. */
export const ORDER_STATUS_MAP: Record<FkShipmentState, InternalOrderStatus> = {
  PENDING: 'new',
  APPROVED: 'confirmed',
  PACKING_IN_PROGRESS: 'picking',
  PACKED: 'packed',
  READY_TO_DISPATCH: 'ready_to_dispatch',
  PICKUP_COMPLETE: 'dispatched',
  SHIPPED: 'dispatched',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  RETURN_REQUESTED: 'returned',
  RETURNED: 'returned',
};
export const toInternalOrderStatus = (s: string): InternalOrderStatus => ORDER_STATUS_MAP[s as FkShipmentState] ?? 'new';

/** Flipkart prices are decimal numbers per unit (sellingPrice) and per line (totalPrice). The platform stores the unit price. */
export function mapShipment(s: FkShipment): NormalizedOrder {
  // one shipment can hold lines with differing states; the most advanced non-terminal state represents the order
  const state = s.orderItems[0]?.status ?? 'PENDING';
  const lines = s.orderItems.map((i) => ({
    externalItemId: i.orderItemId,
    externalListingId: i.listingId ?? i.fsn,
    sku: i.sku,
    title: i.title,
    quantity: i.quantity,
    unitPriceMinor: toMinor(i.priceComponents.sellingPrice),
    taxMinor: toMinor(i.priceComponents.taxAmount),
    discountMinor: toMinor((i.priceComponents.flipkartDiscount ?? 0) + (i.priceComponents.sellerDiscount ?? 0)),
  }));
  const total = s.orderItems.reduce((n, i) => n + toMinor(i.priceComponents.totalPrice), 0);
  const a = s.deliveryAddress;
  const buyerName = [s.buyerDetails?.firstName, s.buyerDetails?.lastName].filter(Boolean).join(' ') || undefined;
  return {
    externalOrderId: s.shipmentId,
    status: toInternalOrderStatus(state),
    marketplaceStatus: state,
    placedAt: new Date(s.orderDate),
    currency: 'INR',
    totalMinor: total,
    buyer: { name: buyerName, email: s.buyerDetails?.email, phone: s.buyerDetails?.phone },
    shippingAddress: a ? { name: buyerName, line1: a.addressLine1, line2: a.addressLine2, city: a.city, state: a.state, pincode: a.pinCode, country: a.country ?? 'IN' } : undefined,
    payment: { method: s.paymentType === 'COD' ? 'cod' : 'prepaid', ...(s.paymentType === 'COD' ? { codAmountMinor: total } : {}) },
    items: lines,
    raw: s,
  };
}

// ---------------------------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------------------------
export const LISTING_STATE_MAP: Record<FkListingState, ListingReportStatus> = {
  ACTIVE: 'active', INACTIVE: 'inactive', PENDING_REVIEW: 'pending', REJECTED: 'rejected', CORRECTION_NEEDED: 'correction_required',
};
export const toListingStatus = (s: string): ListingReportStatus => LISTING_STATE_MAP[s as FkListingState] ?? 'pending';

export const toIssues = (errors: FkListingError[] | undefined): ListingIssue[] =>
  (errors ?? []).map((e) => ({ code: e.code, message: e.message, attribute: e.attribute, severity: e.level === 'WARNING' ? 'warning' : 'error' }));

export function mapListingReport(r: FkListingRecord): ListingStatusReport {
  return { externalSku: r.sku, externalListingId: r.listingId ?? r.fsn ?? r.sku, status: toListingStatus(r.state), marketplaceStatus: r.state, issues: toIssues(r.errors) };
}

export function mapListingToProduct(r: FkListingRecord): NormalizedProduct {
  const report = mapListingReport(r);
  return {
    externalListingId: report.externalListingId,
    externalSku: r.sku,
    title: r.title ?? r.sku,
    brand: r.brand,
    category: r.category ? { id: r.category, name: r.category } : undefined,
    priceMinor: r.price?.sellingPrice !== undefined ? toMinor(r.price.sellingPrice) : undefined,
    mrpMinor: r.price?.mrp !== undefined ? toMinor(r.price.mrp) : undefined,
    currency: r.price?.currency ?? 'INR',
    quantity: r.inventory,
    imageUrls: r.images,
    attributes: r.attributes ?? {},
    status: report.status,
    marketplaceStatus: report.marketplaceStatus,
    raw: r,
  };
}

export function mapRequirements(defs: FkAttributeDef[]): ListingRequirement[] {
  const core: Record<string, ListingRequirement['coreField']> = { title: 'title', brand: 'brand', description: 'description' };
  return defs.map((d) => ({
    name: d.name, label: d.displayName ?? d.name, required: d.mandatory,
    type: d.type === 'NUMBER' ? 'number' : d.type === 'BOOLEAN' ? 'boolean' : d.type === 'ENUM' ? 'enum' : 'string',
    allowedValues: d.values, maxLength: d.maxLength, coreField: core[d.name],
  }));
}

/** ListingInput -> Flipkart listing record (one record per SKU) */
export function buildListingRecord(input: ListingInput) {
  return {
    sku: input.externalSku,
    title: input.title,
    brand: input.brand,
    description: input.description,
    category: input.marketplaceCategoryId,
    barcode: input.barcode,
    price: { mrp: input.mrpMinor ? Number(fromMinor(input.mrpMinor)) : undefined, sellingPrice: Number(fromMinor(input.priceMinor)), currency: input.currency },
    inventory: input.quantity,
    attributes: input.attributes ?? {},
    images: input.imageUrls ?? [],
  };
}
