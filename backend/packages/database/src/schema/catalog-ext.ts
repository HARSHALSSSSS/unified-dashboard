import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, inList, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors } from './identity';
import { categories, productVariants, products } from './catalog';

// ---------------------------------------------------------------------------------------------
// Generic attribute system. Nothing marketplace-specific lives here: marketplace-specific
// requirements/values are stored in `product_marketplace_data` (below) and in connector mappings.
// ---------------------------------------------------------------------------------------------
export const ATTRIBUTE_TYPES = ['text', 'number', 'boolean', 'date', 'enum'] as const;
export const ATTRIBUTE_APPLIES_TO = ['product', 'variant'] as const;

export const attributeDefinitions = pgTable('attribute_definitions', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  /** stable machine code, e.g. "color", "fabric" */
  code: text('code').notNull(),
  name: text('name').notNull(),
  dataType: text('data_type').notNull().default('text'),
  appliesTo: text('applies_to').notNull().default('product'),
  unit: text('unit'),
  description: text('description'),
  version: version(),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  unique('attribute_definitions_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('attribute_definitions_vendor_code_uq').on(t.vendorId, t.code).where(sql`${t.deletedAt} IS NULL`),
  check('attribute_definitions_type_chk', inList('data_type', ATTRIBUTE_TYPES)),
  check('attribute_definitions_applies_chk', inList('applies_to', ATTRIBUTE_APPLIES_TO)),
]);

/** Allowed values for `enum` attributes. */
export const attributeValues = pgTable('attribute_values', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  attributeId: uuid('attribute_id').notNull(),
  value: text('value').notNull(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps(),
  deletedAt: deletedAt(),
}, (t) => [
  unique('attribute_values_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('attribute_values_attr_value_uq').on(t.attributeId, t.value).where(sql`${t.deletedAt} IS NULL`),
  index('attribute_values_vendor_attr_idx').on(t.vendorId, t.attributeId, t.sortOrder),
  foreignKey({ columns: [t.vendorId, t.attributeId], foreignColumns: [attributeDefinitions.vendorId, attributeDefinitions.id], name: 'attribute_values_attribute_fk' }),
]);

/** Which attributes a category expects (and whether they are required before a product is "ready"). */
export const categoryAttributes = pgTable('category_attributes', {
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull(),
  attributeId: uuid('attribute_id').notNull(),
  isRequired: boolean('is_required').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.categoryId, t.attributeId] }),
  index('category_attributes_vendor_idx').on(t.vendorId, t.categoryId),
  foreignKey({ columns: [t.vendorId, t.categoryId], foreignColumns: [categories.vendorId, categories.id], name: 'category_attributes_category_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.attributeId], foreignColumns: [attributeDefinitions.vendorId, attributeDefinitions.id], name: 'category_attributes_attribute_fk' }).onDelete('cascade'),
]);

/** A product's (or variant's) value for an attribute. Exactly one typed value column is used per row. */
export const productAttributeValues = pgTable('product_attribute_values', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull(),
  variantId: uuid('variant_id'),
  attributeId: uuid('attribute_id').notNull(),
  valueText: text('value_text'),
  valueNumber: numeric('value_number'),
  valueBool: boolean('value_bool'),
  valueDate: date('value_date'),
  attributeValueId: uuid('attribute_value_id'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('product_attribute_values_uq').on(t.productId, sql`coalesce(${t.variantId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.attributeId),
  index('product_attribute_values_vendor_product_idx').on(t.vendorId, t.productId),
  index('product_attribute_values_vendor_attr_idx').on(t.vendorId, t.attributeId),
  foreignKey({ columns: [t.vendorId, t.productId], foreignColumns: [products.vendorId, products.id], name: 'product_attribute_values_product_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'product_attribute_values_variant_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.attributeId], foreignColumns: [attributeDefinitions.vendorId, attributeDefinitions.id], name: 'product_attribute_values_attribute_fk' }),
  foreignKey({ columns: [t.vendorId, t.attributeValueId], foreignColumns: [attributeValues.vendorId, attributeValues.id], name: 'product_attribute_values_value_fk' }),
]);

/**
 * Marketplace-SPECIFIC data for a product (category ids, bullet points, search terms, ...), keyed by marketplace code.
 * Kept out of the core product model on purpose: the core stays marketplace-neutral.
 */
export const productMarketplaceData = pgTable('product_marketplace_data', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull(),
  marketplace: text('marketplace').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  version: version(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('product_marketplace_data_uq').on(t.productId, t.marketplace),
  index('product_marketplace_data_vendor_idx').on(t.vendorId, t.productId),
  foreignKey({ columns: [t.vendorId, t.productId], foreignColumns: [products.vendorId, products.id], name: 'product_marketplace_data_product_fk' }).onDelete('cascade'),
]);

export const DATA_JOB_KINDS = ['import', 'export'] as const;
export const DATA_JOB_STATUSES = ['awaiting_upload', 'queued', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled'] as const;

/** Bulk import/export runs (products). Files live in object storage; processing happens in the worker. */
export const dataJobs = pgTable('data_jobs', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  entity: text('entity').notNull().default('products'),
  status: text('status').notNull(),
  format: text('format').notNull().default('csv'),
  inputKey: text('input_key'),
  outputKey: text('output_key'),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
  /** first N row-level errors */
  errors: jsonb('errors').$type<Array<{ row: number; message: string }>>().notNull().default([]),
  requestedBy: uuid('requested_by'),
  startedAt: tz('started_at'),
  finishedAt: tz('finished_at'),
  ...timestamps(),
}, (t) => [
  unique('data_jobs_vendor_id_id_uq').on(t.vendorId, t.id),
  index('data_jobs_vendor_created_idx').on(t.vendorId, t.createdAt.desc(), t.id),
  check('data_jobs_kind_chk', inList('kind', DATA_JOB_KINDS)),
  check('data_jobs_status_chk', inList('status', DATA_JOB_STATUSES)),
]);
