import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { deletedAt, inList, minor, pk, tenantId, timestamps, version } from './_helpers';
import { vendors } from './identity';

/**
 * Tenant integrity pattern: every tenant table has UNIQUE (vendor_id, id) and children reference the
 * COMPOSITE (vendor_id, parent_id). A row can therefore never point at another vendor's row, even through
 * a bug - the database itself rejects it.
 */
export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export const VARIANT_STATUSES = ['active', 'inactive'] as const;
export const DOCUMENT_KINDS = ['image', 'document', 'video'] as const;
export const DOCUMENT_STATUSES = ['pending_upload', 'uploaded', 'processed', 'rejected'] as const;
export const DOCUMENT_PURPOSES = ['product_image', 'product_document', 'listing_document'] as const;

export const categories = pgTable('categories', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  /** materialised path of slugs, e.g. "apparel/men/shirts" (cheap subtree queries via LIKE 'path/%') */
  path: text('path').notNull(),
  attributeSchema: jsonb('attribute_schema').$type<Record<string, unknown>>().notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  unique('categories_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('categories_vendor_slug_uq').on(t.vendorId, t.slug).where(sql`${t.deletedAt} IS NULL`),
  index('categories_vendor_parent_idx').on(t.vendorId, t.parentId),
  index('categories_vendor_path_idx').on(t.vendorId, t.path.op('text_pattern_ops')),
  foreignKey({ columns: [t.vendorId, t.parentId], foreignColumns: [t.vendorId, t.id], name: 'categories_parent_fk' }),
]);

export const products = pgTable('products', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  /** vendor-chosen stable code (style code / parent SKU) */
  productCode: text('product_code').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  brand: text('brand'),
  manufacturer: text('manufacturer'),
  countryOfOrigin: text('country_of_origin'),
  /** India GST: HSN/SAC code and default GST rate in basis points (variants may override) */
  hsnCode: text('hsn_code'),
  gstRateBps: integer('gst_rate_bps'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  categoryId: uuid('category_id'),
  status: text('status').notNull().default('draft'),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  unique('products_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('products_vendor_code_uq').on(t.vendorId, t.productCode).where(sql`${t.deletedAt} IS NULL`),
  index('products_vendor_status_idx').on(t.vendorId, t.status, t.id),
  index('products_vendor_category_idx').on(t.vendorId, t.categoryId),
  index('products_vendor_created_idx').on(t.vendorId, t.createdAt.desc(), t.id),
  index('products_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  foreignKey({ columns: [t.vendorId, t.categoryId], foreignColumns: [categories.vendorId, categories.id], name: 'products_category_fk' }),
  check('products_status_chk', inList('status', PRODUCT_STATUSES)),
]);

export const productVariants = pgTable('product_variants', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull(),
  sku: text('sku').notNull(),
  barcode: text('barcode'),
  optionValues: jsonb('option_values').$type<Record<string, string>>().notNull().default({}),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  mrpMinor: minor('mrp_minor'),
  sellingPriceMinor: minor('selling_price_minor'),
  costPriceMinor: minor('cost_price_minor'),
  taxRateBps: integer('tax_rate_bps'),
  weightGrams: integer('weight_grams'),
  dimensionsMm: jsonb('dimensions_mm').$type<{ l: number; w: number; h: number }>(),
  status: text('status').notNull().default('active'),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  unique('product_variants_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('product_variants_vendor_sku_uq').on(t.vendorId, t.sku).where(sql`${t.deletedAt} IS NULL`),
  index('product_variants_vendor_product_idx').on(t.vendorId, t.productId),
  uniqueIndex('product_variants_vendor_barcode_uq').on(t.vendorId, t.barcode).where(sql`${t.barcode} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  foreignKey({ columns: [t.vendorId, t.productId], foreignColumns: [products.vendorId, products.id], name: 'product_variants_product_fk' }),
  check('product_variants_status_chk', inList('status', VARIANT_STATUSES)),
  check('product_variants_price_chk', sql`(mrp_minor IS NULL OR mrp_minor >= 0) AND (selling_price_minor IS NULL OR selling_price_minor >= 0)`),
]);

export const productDocuments = pgTable('product_documents', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull(),
  variantId: uuid('variant_id'),
  kind: text('kind').notNull().default('image'),
  /** object-storage key, always under vendors/<vendorId>/ (see @oms/storage) */
  storageKey: text('storage_key').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  checksumSha256: text('checksum_sha256'),
  width: integer('width'),
  height: integer('height'),
  sortOrder: integer('sort_order').notNull().default(0),
  /** product_image | product_document | listing_document */
  purpose: text('purpose').notNull().default('product_image'),
  /** set for listing documents; FK to marketplace_listings is added with the Listings module */
  listingId: uuid('listing_id'),
  isPrimary: boolean('is_primary').notNull().default(false),
  status: text('status').notNull().default('pending_upload'),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  uniqueIndex('product_documents_storage_key_uq').on(t.storageKey),
  index('product_documents_vendor_product_idx').on(t.vendorId, t.productId, t.sortOrder),
  uniqueIndex('product_documents_primary_uq').on(t.vendorId, t.productId).where(sql`${t.isPrimary} AND ${t.deletedAt} IS NULL`),
  foreignKey({ columns: [t.vendorId, t.productId], foreignColumns: [products.vendorId, products.id], name: 'product_documents_product_fk' }),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'product_documents_variant_fk' }),
  check('product_documents_kind_chk', inList('kind', DOCUMENT_KINDS)),
  check('product_documents_purpose_chk', inList('purpose', DOCUMENT_PURPOSES)),
  check('product_documents_status_chk', inList('status', DOCUMENT_STATUSES)),
]);
