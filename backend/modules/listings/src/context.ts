import { and, asc, eq, inArray, isNull, schema, type Tx } from '@oms/database';
import type { ListingInput } from '@oms/marketplace-core';
import { Errors } from '@oms/shared';
import type { Container } from '@oms/module-kit';
import { contentHash } from './domain';

const L = schema.marketplaceListings;
const V = schema.productVariants;
const P = schema.products;

export type ListingRow = typeof L.$inferSelect;

export const CORE_FIELDS = ['title', 'description', 'brand', 'barcode', 'sku', 'price', 'mrp', 'hsn_code', 'country_of_origin', 'weight_grams', 'manufacturer'] as const;
export type CoreField = (typeof CORE_FIELDS)[number];

export async function getListingRow(tx: Tx, vendorId: string, id: string): Promise<ListingRow> {
  const [l] = await tx.select().from(L).where(and(eq(L.id, id), eq(L.vendorId, vendorId)));
  if (!l) throw Errors.notFound('Listing', id);
  return l;
}

export interface ListingContext {
  listing: ListingRow;
  variant: typeof V.$inferSelect;
  product: typeof P.$inferSelect;
  account: typeof schema.marketplaceAccounts.$inferSelect;
  /** everything the connector receives (signed image URLs included) */
  input: ListingInput;
  /** what the approval hash covers */
  hash: string;
  imageKeys: string[];
  /** requirement names that were filled from a mapping / suggestion / option (for the preview) */
  attributeSources: Record<string, string>;
}

/** value of a core field for a variant/product, as text/number (null when unset) */
export function coreValue(field: string, p: ListingContext['product'], v: ListingContext['variant'], priceMinor: number, mrpMinor: number | null): string | number | null {
  switch (field) {
    case 'title': return p.title;
    case 'description': return p.description;
    case 'brand': return p.brand;
    case 'manufacturer': return p.manufacturer;
    case 'barcode': return v.barcode;
    case 'sku': return v.sku;
    case 'price': return priceMinor / 100;
    case 'mrp': return mrpMinor === null ? null : mrpMinor / 100;
    case 'hsn_code': return p.hsnCode;
    case 'country_of_origin': return p.countryOfOrigin;
    case 'weight_grams': return v.weightGrams;
    default: return null;
  }
}

/**
 * Builds the marketplace-neutral ListingInput for a listing: product data + listing overrides, attributes resolved from
 *   1. listing.attributeValues       (the merchant's explicit values, highest priority)
 *   2. attribute mappings            (category-specific: core field / vendor attribute / static value, with value maps)
 *   3. requirement.coreField hints   (title, brand, description... are filled without any setup)
 *   4. variant option values         (a requirement named "color"/"size" takes the variant's colour/size)
 */
export async function loadListingContext(
  tx: Tx, c: Pick<Container, 'storage'>, vendorId: string, listingId: string,
  opts: { requirements?: Array<{ name: string; coreField?: string }>; signImages?: boolean } = {},
): Promise<ListingContext> {
  const listing = await getListingRow(tx, vendorId, listingId);
  const [variant] = await tx.select().from(V).where(and(eq(V.id, listing.variantId), eq(V.vendorId, vendorId)));
  if (!variant) throw Errors.notFound('Variant', listing.variantId);
  const [product] = await tx.select().from(P).where(and(eq(P.id, variant.productId), eq(P.vendorId, vendorId)));
  if (!product) throw Errors.notFound('Product', variant.productId);
  const [account] = await tx.select().from(schema.marketplaceAccounts).where(and(eq(schema.marketplaceAccounts.id, listing.marketplaceAccountId), eq(schema.marketplaceAccounts.vendorId, vendorId)));
  if (!account) throw Errors.notFound('Marketplace account', listing.marketplaceAccountId);

  const priceMinor = listing.priceMinor ?? variant.sellingPriceMinor ?? 0;
  const mrpMinor = listing.mrpMinor ?? variant.mrpMinor ?? null;

  // images: primary first, then by sort order; only usable files
  const docs = await tx
    .select()
    .from(schema.productDocuments)
    .where(and(eq(schema.productDocuments.vendorId, vendorId), eq(schema.productDocuments.productId, product.id), eq(schema.productDocuments.kind, 'image'), isNull(schema.productDocuments.deletedAt), inArray(schema.productDocuments.status, ['uploaded', 'processed'])))
    .orderBy(asc(schema.productDocuments.sortOrder), asc(schema.productDocuments.createdAt));
  docs.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const imageKeys = docs.map((d) => d.storageKey);
  const imageUrls = opts.signImages === false ? [] : await Promise.all(imageKeys.map((k) => c.storage.presignDownload(k, 3600)));

  const marketplaceCategoryId = listing.marketplaceCategoryId ?? (await mappedCategory(tx, vendorId, account.marketplace, product.categoryId)) ?? undefined;

  // attribute resolution
  const mappings = marketplaceCategoryId
    ? await tx.select().from(schema.attributeMappings).where(and(eq(schema.attributeMappings.vendorId, vendorId), eq(schema.attributeMappings.marketplace, account.marketplace), eq(schema.attributeMappings.marketplaceCategoryId, marketplaceCategoryId)))
    : [];
  const attrValues = mappings.some((m) => m.sourceType === 'attribute') ? await productAttributeValues(tx, vendorId, product.id, variant.id) : new Map<string, string | number | boolean>();
  const attributes: Record<string, string | number | boolean> = {};
  const sources: Record<string, string> = {};
  const put = (name: string, value: string | number | boolean | null | undefined, source: string, valueMap?: Record<string, string>) => {
    if (value === null || value === undefined || value === '') return;
    const mapped = valueMap && typeof value !== 'boolean' && valueMap[String(value)] !== undefined ? valueMap[String(value)]! : value;
    attributes[name] = mapped;
    sources[name] = source;
  };
  for (const m of mappings) {
    const map = m.valueMap as Record<string, string>;
    if (m.sourceType === 'core_field') put(m.marketplaceAttribute, coreValue(m.coreField!, product, variant, priceMinor, mrpMinor), `core:${m.coreField}`, map);
    else if (m.sourceType === 'attribute') put(m.marketplaceAttribute, attrValues.get(m.attributeId!), 'attribute', map);
    else put(m.marketplaceAttribute, m.staticValue, 'static', map);
  }
  const options = Object.fromEntries(Object.entries(variant.optionValues ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
  for (const req of opts.requirements ?? []) {
    if (attributes[req.name] !== undefined) continue;
    if (req.coreField && (CORE_FIELDS as readonly string[]).includes(req.coreField)) put(req.name, coreValue(req.coreField, product, variant, priceMinor, mrpMinor), `core:${req.coreField}`);
    if (attributes[req.name] === undefined && options[req.name.toLowerCase()] !== undefined) put(req.name, options[req.name.toLowerCase()], 'option');
  }
  for (const [k, val] of Object.entries(listing.attributeValues)) put(k, val, 'listing');

  const input: ListingInput = {
    externalSku: listing.externalSku, title: product.title, description: product.description ?? undefined, brand: product.brand ?? undefined, barcode: variant.barcode ?? undefined,
    priceMinor, mrpMinor: mrpMinor ?? undefined, currency: (listing.currency ?? variant.currency).trim(), attributes,
    ...(marketplaceCategoryId ? { marketplaceCategoryId } : {}), imageUrls,
  };
  return { listing, variant, product, account, input, hash: contentHash(input, imageKeys), imageKeys, attributeSources: sources };
}

async function mappedCategory(tx: Tx, vendorId: string, marketplace: string, categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  const [m] = await tx.select().from(schema.categoryMappings).where(and(eq(schema.categoryMappings.vendorId, vendorId), eq(schema.categoryMappings.marketplace, marketplace), eq(schema.categoryMappings.categoryId, categoryId)));
  return m?.marketplaceCategoryId ?? null;
}

/** typed value of each vendor attribute for a product (variant-level overrides product-level), keyed by attribute id */
async function productAttributeValues(tx: Tx, vendorId: string, productId: string, variantId: string): Promise<Map<string, string | number | boolean>> {
  const rows = await tx.select().from(schema.productAttributeValues).where(and(eq(schema.productAttributeValues.vendorId, vendorId), eq(schema.productAttributeValues.productId, productId)));
  const out = new Map<string, string | number | boolean>();
  const typed = (r: (typeof rows)[number]): string | number | boolean | null => r.valueText ?? (r.valueNumber !== null ? Number(r.valueNumber) : null) ?? r.valueBool ?? (r.valueDate ?? null);
  for (const r of rows.filter((x) => x.variantId === null)) { const v = typed(r); if (v !== null) out.set(r.attributeId, v); }
  for (const r of rows.filter((x) => x.variantId === variantId)) { const v = typed(r); if (v !== null) out.set(r.attributeId, v); }
  return out;
}
