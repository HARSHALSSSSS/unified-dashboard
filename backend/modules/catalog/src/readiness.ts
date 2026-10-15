import { and, eq, inArray, isNull, schema, type Tx } from '@oms/database';
import { requiredAttributesForCategory, getProductAttributeValues } from '@oms/mod-attributes';
import { hasCapability, type MarketplaceConnector } from '@oms/marketplace-core';
import { Errors } from '@oms/shared';
import { getProductRow } from './service';

export interface Check { code: string; ok: boolean; severity: 'error' | 'warning'; message: string; variantId?: string | null }

/**
 * "Is this product ready to be listed on a marketplace?" Generic, marketplace-neutral completeness checks that
 * every marketplace needs (title, brand, category, HSN/GST, SKU price/MRP, an image, required category attributes).
 * When a connector is supplied, its declared capabilities add marketplace-aware checks WITHOUT any marketplace
 * field leaking into the core product model.
 */
export async function evaluateReadiness(tx: Tx, vendorId: string, productId: string, connector?: MarketplaceConnector) {
  const p = await getProductRow(tx, vendorId, productId);
  const variants = await tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.vendorId, vendorId), eq(schema.productVariants.productId, productId), isNull(schema.productVariants.deletedAt)));
  const checks: Check[] = [];
  const add = (code: string, ok: boolean, severity: 'error' | 'warning', message: string, variantId?: string) => checks.push({ code, ok, severity, message, ...(variantId ? { variantId } : {}) });

  add('title', p.title.trim().length >= 10, 'warning', 'Title should be at least 10 characters to rank and convert');
  add('description', Boolean(p.description && p.description.trim().length >= 20), 'warning', 'Add a description (20+ characters)');
  add('brand', Boolean(p.brand), 'error', 'Brand is required by all marketplaces');
  add('category', Boolean(p.categoryId), 'error', 'Assign a category');
  add('hsn', Boolean(p.hsnCode), 'error', 'HSN code is required for GST invoicing');
  add('gst', p.gstRateBps != null || variants.every((v) => v.taxRateBps != null) && variants.length > 0, 'error', 'GST rate is required (on the product or on every variant)');
  add('origin', Boolean(p.countryOfOrigin), 'warning', 'Country of origin is required by most marketplaces');
  const active = variants.filter((v) => v.status === 'active');
  add('variants', active.length > 0, 'error', 'At least one active variant (SKU) is required');

  for (const v of active) {
    add('price', v.sellingPriceMinor != null && v.sellingPriceMinor > 0, 'error', `SKU ${v.sku}: selling price is required`, v.id);
    add('mrp', v.mrpMinor != null && v.mrpMinor > 0, 'error', `SKU ${v.sku}: MRP is required`, v.id);
    add('barcode', Boolean(v.barcode), 'warning', `SKU ${v.sku}: barcode (EAN/UPC) is recommended`, v.id);
    add('weight', v.weightGrams != null, 'warning', `SKU ${v.sku}: weight is needed for shipping`, v.id);
  }

  const [img] = await tx
    .select({ id: schema.productDocuments.id })
    .from(schema.productDocuments)
    .where(and(eq(schema.productDocuments.vendorId, vendorId), eq(schema.productDocuments.productId, productId), eq(schema.productDocuments.kind, 'image'), inArray(schema.productDocuments.status, ['uploaded', 'processed']), isNull(schema.productDocuments.deletedAt)))
    .limit(1);
  add('image', Boolean(img), 'error', 'Upload at least one product image');

  if (p.categoryId) {
    const required = await requiredAttributesForCategory(tx, vendorId, p.categoryId);
    if (required.length) {
      const values = await getProductAttributeValues(tx, vendorId, productId);
      for (const attr of required) {
        const filled = attr.appliesTo === 'product'
          ? values.some((v) => v.attributeId === attr.id && v.value !== null)
          : active.length > 0 && active.every((variant) => values.some((v) => v.attributeId === attr.id && v.variantId === variant.id && v.value !== null));
        add(`attribute:${attr.code}`, filled, 'error', `Required attribute "${attr.name}" is missing`);
      }
    }
  }

  if (connector) {
    if (!hasCapability(connector, 'listings.create')) add('marketplace_listing_support', false, 'error', `${connector.displayName} does not support creating listings through the API`);
    if (connector.capabilities.listings.requiresCategoryMapping) {
      const [md] = await tx.select().from(schema.productMarketplaceData).where(and(eq(schema.productMarketplaceData.productId, productId), eq(schema.productMarketplaceData.marketplace, connector.code)));
      add('marketplace_category_mapping', Boolean(md && Object.keys(md.data).length), 'error', `${connector.displayName} needs marketplace-specific data (category mapping): PUT /products/{id}/marketplace-data/${connector.code}`);
    }
  }

  const errors = checks.filter((c) => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning').length;
  return { productId, marketplace: connector?.code ?? null, ready: errors === 0, errors, warnings, checks };
}

// ------------------------------------------------------------------------------------------------
// marketplace-specific data (kept outside the core product)
// ------------------------------------------------------------------------------------------------
export async function listMarketplaceData(tx: Tx, vendorId: string, productId: string) {
  await getProductRow(tx, vendorId, productId);
  const rows = await tx.select().from(schema.productMarketplaceData).where(and(eq(schema.productMarketplaceData.vendorId, vendorId), eq(schema.productMarketplaceData.productId, productId)));
  return rows.map((r) => ({ marketplace: r.marketplace, data: r.data, version: r.version, updatedAt: r.updatedAt.toISOString() }));
}

export async function putMarketplaceData(tx: Tx, vendorId: string, productId: string, marketplace: string, data: Record<string, unknown>) {
  await getProductRow(tx, vendorId, productId);
  const [existing] = await tx.select().from(schema.productMarketplaceData).where(and(eq(schema.productMarketplaceData.productId, productId), eq(schema.productMarketplaceData.marketplace, marketplace)));
  const [row] = existing
    ? await tx.update(schema.productMarketplaceData).set({ data, version: existing.version + 1 }).where(eq(schema.productMarketplaceData.id, existing.id)).returning()
    : await tx.insert(schema.productMarketplaceData).values({ vendorId, productId, marketplace, data }).returning();
  return { marketplace: row!.marketplace, data: row!.data, version: row!.version, updatedAt: row!.updatedAt.toISOString() };
}

export async function deleteMarketplaceData(tx: Tx, vendorId: string, productId: string, marketplace: string) {
  await getProductRow(tx, vendorId, productId);
  const rows = await tx.delete(schema.productMarketplaceData).where(and(eq(schema.productMarketplaceData.vendorId, vendorId), eq(schema.productMarketplaceData.productId, productId), eq(schema.productMarketplaceData.marketplace, marketplace))).returning({ id: schema.productMarketplaceData.id });
  if (!rows.length) throw Errors.notFound('Marketplace data', marketplace);
}
