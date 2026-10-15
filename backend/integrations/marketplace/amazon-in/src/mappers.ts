import {
  fromMinor, toMinor,
  type InternalOrderStatus, type ListingInput, type ListingIssue, type ListingReportStatus, type ListingResult, type ListingStatusReport, type NormalizedOrder, type NormalizedProduct,
} from '@oms/marketplace-core';
import type { AmzIssue, AmzListingsItem, AmzOrder, AmzOrderItem, AmzOrderStatus, AmzSubmission } from './dto';

// ---------------------------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------------------------
/** Amazon order status -> internal. The original word stays on the order as `marketplaceStatus`. */
export const ORDER_STATUS_MAP: Record<AmzOrderStatus, InternalOrderStatus> = {
  PendingAvailability: 'new',
  Pending: 'new', // payment not yet confirmed
  Unshipped: 'confirmed', // payment confirmed, ready for the seller to ship
  PartiallyShipped: 'dispatched',
  Shipped: 'dispatched',
  InvoiceUnconfirmed: 'dispatched',
  Canceled: 'cancelled',
  Unfulfillable: 'cancelled',
};
export const toInternalOrderStatus = (s: string): InternalOrderStatus => ORDER_STATUS_MAP[s as AmzOrderStatus] ?? 'new';

export function mapOrder(o: AmzOrder, items: AmzOrderItem[]): NormalizedOrder {
  const lines = items.map((i) => ({
    externalItemId: i.OrderItemId,
    externalListingId: i.ASIN,
    sku: i.SellerSKU,
    title: i.Title ?? i.SellerSKU,
    quantity: i.QuantityOrdered,
    // Amazon's ItemPrice is the LINE total; the platform stores the unit price
    unitPriceMinor: i.QuantityOrdered > 0 ? Math.round(toMinor(i.ItemPrice?.Amount) / i.QuantityOrdered) : 0,
    taxMinor: toMinor(i.ItemTax?.Amount),
    discountMinor: toMinor(i.PromotionDiscount?.Amount),
  }));
  const total = o.OrderTotal ? toMinor(o.OrderTotal.Amount) : lines.reduce((n, l) => n + l.unitPriceMinor * l.quantity + l.taxMinor - l.discountMinor, 0);
  const a = o.ShippingAddress;
  return {
    externalOrderId: o.AmazonOrderId,
    status: toInternalOrderStatus(o.OrderStatus),
    marketplaceStatus: o.OrderStatus,
    placedAt: new Date(o.PurchaseDate),
    currency: o.OrderTotal?.CurrencyCode ?? 'INR',
    totalMinor: total,
    buyer: { name: o.BuyerInfo?.BuyerName ?? a?.Name, email: o.BuyerInfo?.BuyerEmail, phone: a?.Phone },
    shippingAddress: a ? { name: a.Name, line1: a.AddressLine1, line2: a.AddressLine2, city: a.City, state: a.StateOrRegion, pincode: a.PostalCode, country: a.CountryCode } : undefined,
    payment: { method: o.PaymentMethod === 'COD' ? 'cod' : o.PaymentMethod ? 'prepaid' : 'unknown', ...(o.PaymentMethod === 'COD' ? { codAmountMinor: total } : {}) },
    items: lines,
    raw: { order: o, items },
  };
}

// ---------------------------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------------------------
export const toIssues = (issues: AmzIssue[] | undefined): ListingIssue[] =>
  (issues ?? []).filter((i) => i.severity !== 'INFO').map((i) => ({ code: i.code, message: i.message, attribute: i.attributeNames?.[0], severity: i.severity === 'ERROR' ? 'error' : 'warning' }));

/**
 * Listing state from a Listings Items record:
 *  BUYABLE/DISCOVERABLE      -> active
 *  ERROR issue on attributes -> correction_required (the seller can fix it)
 *  ERROR issue, no attribute -> rejected (policy / account level)
 *  nothing yet               -> pending (submitted, still being processed)
 */
export function listingStatusOf(item: Pick<AmzListingsItem, 'summaries' | 'issues'>): ListingReportStatus {
  const flags = item.summaries?.[0]?.status ?? [];
  const errors = (item.issues ?? []).filter((i) => i.severity === 'ERROR');
  if (flags.includes('BUYABLE') || flags.includes('DISCOVERABLE')) return errors.length ? 'correction_required' : 'active';
  if (errors.length) return errors.some((e) => e.attributeNames?.length) ? 'correction_required' : 'rejected';
  return 'pending';
}

export function mapListingReport(item: AmzListingsItem): ListingStatusReport {
  const status = listingStatusOf(item);
  const s = item.summaries?.[0];
  return { externalSku: item.sku, externalListingId: s?.asin ?? item.sku, status, marketplaceStatus: (s?.status ?? []).join(',') || 'SUBMITTED', issues: toIssues(item.issues) };
}

export function mapSubmission(sub: AmzSubmission): ListingResult {
  const issues = toIssues(sub.issues);
  const hasError = issues.some((i) => i.severity === 'error');
  const status: ListingReportStatus = sub.status === 'INVALID' || hasError ? (sub.issues.some((i) => i.severity === 'ERROR' && !i.attributeNames?.length) ? 'rejected' : 'correction_required') : 'pending';
  return { externalListingId: sub.sku, status, marketplaceStatus: sub.status, issues };
}

export function mapListingToProduct(item: AmzListingsItem, marketplaceId: string): NormalizedProduct {
  const attr = (n: string) => item.attributes?.[n]?.[0]?.value;
  const s = item.summaries?.[0];
  const offer = item.offers?.find((o) => o.marketplaceId === marketplaceId) ?? item.offers?.[0];
  const report = mapListingReport(item);
  return {
    externalListingId: s?.asin ?? item.sku,
    externalSku: item.sku,
    title: s?.itemName ?? String(attr('item_name') ?? item.sku),
    description: attr('product_description') as string | undefined,
    brand: attr('brand') as string | undefined,
    category: s?.productType ? { id: s.productType, name: s.productType } : undefined,
    priceMinor: offer ? toMinor(offer.price.amount) : undefined,
    currency: offer?.price.currencyCode ?? 'INR',
    quantity: item.fulfillmentAvailability?.find((f) => f.fulfillmentChannelCode === 'DEFAULT')?.quantity,
    attributes: Object.fromEntries(Object.entries(item.attributes ?? {}).map(([k, v]) => [k, v[0]?.value]).filter(([k]) => !['item_name', 'brand', 'product_description', 'purchasable_offer', 'fulfillment_availability'].includes(k as string))),
    status: report.status,
    marketplaceStatus: report.marketplaceStatus,
    raw: item,
  };
}

const lang = 'en_IN';
const wrap = (marketplaceId: string, value: unknown) => [{ value, marketplace_id: marketplaceId, language_tag: lang }];

/** ListingInput -> Listings Items PUT body (productType = the mapped Amazon product type). */
export function buildPutBody(input: ListingInput, marketplaceId: string): { productType: string; requirements: 'LISTING'; attributes: Record<string, unknown> } {
  const a: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => { if (value !== undefined && value !== '') a[name] = wrap(marketplaceId, value); };
  // core fields first; explicitly mapped attributes (which the vendor reviewed) take precedence
  set('item_name', input.title);
  set('brand', input.brand);
  set('product_description', input.description);
  if (input.barcode) a.externally_assigned_product_identifier = [{ type: 'ean', value: input.barcode, marketplace_id: marketplaceId }];
  for (const [k, v] of Object.entries(input.attributes ?? {})) set(k, v);
  a.purchasable_offer = [{ marketplace_id: marketplaceId, currency: input.currency, our_price: [{ schedule: [{ value_with_tax: Number(fromMinor(input.priceMinor)) }] }], ...(input.mrpMinor ? { list_price: [{ value_with_tax: Number(fromMinor(input.mrpMinor)) }] } : {}) }];
  if (input.quantity !== undefined) a.fulfillment_availability = [{ fulfillment_channel_code: 'DEFAULT', quantity: input.quantity }];
  if (input.imageUrls?.[0]) a.main_product_image_locator = wrap(marketplaceId, input.imageUrls[0]).map((x) => ({ media_location: x.value, marketplace_id: marketplaceId }));
  return { productType: input.marketplaceCategoryId ?? 'PRODUCT', requirements: 'LISTING', attributes: a };
}

export const inventoryPatch = (productType: string, quantity: number) => ({ productType, patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity }] }] });
export const pricePatch = (productType: string, marketplaceId: string, currency: string, priceMinor: number) => ({
  productType, patches: [{ op: 'replace', path: '/attributes/purchasable_offer', value: [{ marketplace_id: marketplaceId, currency, our_price: [{ schedule: [{ value_with_tax: Number(fromMinor(priceMinor)) }] }] }] }],
});
