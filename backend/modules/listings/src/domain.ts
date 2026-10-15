import { createHash } from 'node:crypto';
import type { ListingIssue, ListingInput, ListingReportStatus, ListingRequirement } from '@oms/marketplace-core';

/** Pure listing/channel rules: no I/O, fully unit-tested. */

// ------------------------------------------------------------------------------------------------
// status
// ------------------------------------------------------------------------------------------------
export type ListingStatus = 'draft' | 'ready' | 'approved' | 'pending' | 'active' | 'rejected' | 'correction_required' | 'unpublished';

/** marketplace-reported status -> our lifecycle (`inactive` on the marketplace = we show `unpublished`) */
export const fromReport = (s: ListingReportStatus): ListingStatus => (s === 'inactive' ? 'unpublished' : s);

/** statuses in which the merchant may still edit content (an active/pending listing is live: unpublish first) */
export const EDITABLE: readonly ListingStatus[] = ['draft', 'ready', 'approved', 'rejected', 'correction_required', 'unpublished'];
/** statuses that exist on the marketplace */
export const SUBMITTED: readonly ListingStatus[] = ['pending', 'active', 'rejected', 'correction_required', 'unpublished'];

// ------------------------------------------------------------------------------------------------
// hashing: approval is bound to the exact content that was reviewed
// ------------------------------------------------------------------------------------------------
const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  return v;
};
export const stableHash = (v: unknown): string => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

/** What the merchant approves. Image KEYS (not signed URLs, which change every call) and no quantity (it syncs on its own). */
export const contentHash = (input: ListingInput, imageKeys: string[]): string =>
  stableHash({
    sku: input.externalSku, title: input.title, description: input.description, brand: input.brand, barcode: input.barcode, price: input.priceMinor, mrp: input.mrpMinor, currency: input.currency,
    category: input.marketplaceCategoryId, attributes: input.attributes ?? {}, images: imageKeys,
  });

// ------------------------------------------------------------------------------------------------
// validation
// ------------------------------------------------------------------------------------------------
export interface ValidationIssue { code: string; message: string; attribute?: string }
export interface ValidationResult { ready: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

export interface ValidateArgs {
  input: ListingInput;
  /** requirements of the mapped marketplace category (empty when the connector has none) */
  requirements: ListingRequirement[];
  categoryRequired: boolean;
  imageCount: number;
}

export function validateListingInput({ input, requirements, categoryRequired, imageCount }: ValidateArgs): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, attribute?: string) => errors.push({ code, message, ...(attribute ? { attribute } : {}) });
  const warn = (code: string, message: string, attribute?: string) => warnings.push({ code, message, ...(attribute ? { attribute } : {}) });

  if (!input.title || input.title.trim().length < 3) err('title_missing', 'The product needs a title of at least 3 characters', 'title');
  if (!Number.isInteger(input.priceMinor) || input.priceMinor <= 0) err('price_missing', 'A selling price greater than zero is required (set it on the variant or on the listing)', 'price');
  if (input.mrpMinor !== undefined && input.priceMinor > input.mrpMinor) err('price_above_mrp', 'The selling price cannot be higher than the MRP', 'price');
  if (input.mrpMinor === undefined) warn('mrp_missing', 'No MRP: most marketplaces require it for apparel and electronics', 'mrp');
  if (!/^[A-Z]{3}$/.test(input.currency)) err('currency_invalid', 'Currency must be a 3-letter ISO code', 'currency');
  if (categoryRequired && !input.marketplaceCategoryId) err('category_missing', 'Map this product to a marketplace category first', 'category');
  if (imageCount === 0) warn('images_missing', 'No product images: the marketplace is likely to reject or suppress the listing', 'images');
  if (!input.barcode) warn('barcode_missing', 'No barcode (EAN/GTIN): some categories require one', 'barcode');

  const values = input.attributes ?? {};
  for (const req of requirements) {
    const v = values[req.name];
    const label = req.label ?? req.name;
    if (v === undefined || v === '' || v === null) {
      if (req.required) err('attribute_missing', `${label} is required by the marketplace category`, req.name);
      continue;
    }
    if (req.type === 'number' && Number.isNaN(Number(v))) err('attribute_invalid', `${label} must be a number`, req.name);
    if (req.type === 'boolean' && typeof v !== 'boolean' && !['true', 'false'].includes(String(v))) err('attribute_invalid', `${label} must be true or false`, req.name);
    if (req.allowedValues?.length && !req.allowedValues.includes(String(v))) err('attribute_not_allowed', `${label} must be one of: ${req.allowedValues.join(', ')}`, req.name);
    if (req.maxLength !== undefined && String(v).length > req.maxLength) err('attribute_too_long', `${label} is longer than ${req.maxLength} characters`, req.name);
  }
  return { ready: errors.length === 0, errors, warnings };
}

// ------------------------------------------------------------------------------------------------
// channel quantity
// ------------------------------------------------------------------------------------------------
export interface ChannelPolicy { mode: 'sync' | 'paused'; safetyBuffer: number; allocationPercent: number; maxQuantity: number | null }
export const DEFAULT_POLICY: ChannelPolicy = { mode: 'sync', safetyBuffer: 0, allocationPercent: 100, maxQuantity: null };

/**
 * What a channel may SELL, from what the warehouses can still fulfil:
 *   share    = floor(available * allocation%)        (stock reserved for other channels / own use)
 *   sellable = share - safety buffer                  (cushion against races and cancellations)
 *   capped at the channel / listing maximum, never below zero, never above `available`.
 * `available` already excludes reservations, so a unit promised to an order is not sold again (overselling protection).
 */
export function computeSellable(available: number, policy: ChannelPolicy, override: { buffer?: number | null; max?: number | null } = {}): number {
  const avail = Math.max(0, Math.floor(available));
  const share = Math.floor((avail * policy.allocationPercent) / 100);
  const buffer = override.buffer ?? policy.safetyBuffer;
  let sellable = Math.max(0, share - Math.max(0, buffer));
  const max = override.max ?? policy.maxQuantity;
  if (max !== null && max !== undefined) sellable = Math.min(sellable, Math.max(0, max));
  return Math.min(sellable, avail);
}

export const issuesToText = (issues: ListingIssue[]): string => issues.map((i) => `${i.attribute ? `${i.attribute}: ` : ''}${i.message}`).join('; ');
