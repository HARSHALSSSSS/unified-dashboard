import { and, eq, escapeLike, gte, ilike, inArray, isNull, keyset, lte, or, schema, sql, type SQL, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { enforceLimit } from '@oms/mod-billing';
import { getCategory } from '@oms/mod-categories';
import { getProductAttributeValues, setProductAttributeValues, type ProductValueInput } from '@oms/mod-attributes';
import type { Effects } from './effects';

export type ProductRow = typeof schema.products.$inferSelect;
export type VariantRow = typeof schema.productVariants.$inferSelect;

const P = schema.products;
const V = schema.productVariants;

// ------------------------------------------------------------------------------------------------
// mappers
// ------------------------------------------------------------------------------------------------
export const toProductDto = (p: ProductRow, variantCount = 0) => ({
  id: p.id,
  productCode: p.productCode,
  title: p.title,
  description: p.description,
  brand: p.brand,
  manufacturer: p.manufacturer,
  countryOfOrigin: p.countryOfOrigin,
  categoryId: p.categoryId,
  hsnCode: p.hsnCode,
  gstRateBps: p.gstRateBps,
  tags: p.tags,
  status: p.status as 'draft' | 'active' | 'archived',
  variantCount,
  version: p.version,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const toVariantDto = (v: VariantRow) => ({
  id: v.id,
  productId: v.productId,
  sku: v.sku,
  barcode: v.barcode,
  optionValues: v.optionValues as Record<string, string>,
  currency: v.currency.trim(),
  mrpMinor: v.mrpMinor,
  sellingPriceMinor: v.sellingPriceMinor,
  costPriceMinor: v.costPriceMinor,
  taxRateBps: v.taxRateBps,
  weightGrams: v.weightGrams,
  dimensionsMm: v.dimensionsMm ? { length: v.dimensionsMm.l, width: v.dimensionsMm.w, height: v.dimensionsMm.h } : null,
  status: v.status as 'active' | 'inactive',
  version: v.version,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

const liveProduct = (vendorId: string) => and(eq(P.vendorId, vendorId), isNull(P.deletedAt));
const liveVariant = (vendorId: string) => and(eq(V.vendorId, vendorId), isNull(V.deletedAt));

// ------------------------------------------------------------------------------------------------
// inputs
// ------------------------------------------------------------------------------------------------
export interface VariantInput {
  sku: string; barcode?: string | null; optionValues?: Record<string, string>; currency?: string;
  mrpMinor?: number | null; sellingPriceMinor?: number | null; costPriceMinor?: number | null; taxRateBps?: number | null;
  weightGrams?: number | null; dimensionsMm?: { length: number; width: number; height: number } | null; status?: 'active' | 'inactive';
}
export interface ProductInput {
  productCode: string; title: string; description?: string | null; brand?: string | null; manufacturer?: string | null; countryOfOrigin?: string | null;
  categoryId?: string | null; hsnCode?: string | null; gstRateBps?: number | null; tags?: string[]; status?: 'draft' | 'active' | 'archived';
  variants?: VariantInput[]; attributeValues?: ProductValueInput[];
}

function assertPrices(v: { mrpMinor?: number | null; sellingPriceMinor?: number | null; sku?: string }) {
  if (v.mrpMinor != null && v.sellingPriceMinor != null && v.sellingPriceMinor > v.mrpMinor) {
    throw Errors.validation({ issues: [{ path: 'sellingPriceMinor', message: `selling price cannot exceed MRP${v.sku ? ` (SKU ${v.sku})` : ''}` }] });
  }
}

const variantColumns = (v: Partial<VariantInput>) => ({
  ...(v.sku !== undefined ? { sku: v.sku } : {}),
  ...(v.barcode !== undefined ? { barcode: v.barcode ?? null } : {}),
  ...(v.optionValues !== undefined ? { optionValues: v.optionValues } : {}),
  ...(v.currency !== undefined ? { currency: v.currency } : {}),
  ...(v.mrpMinor !== undefined ? { mrpMinor: v.mrpMinor } : {}),
  ...(v.sellingPriceMinor !== undefined ? { sellingPriceMinor: v.sellingPriceMinor } : {}),
  ...(v.costPriceMinor !== undefined ? { costPriceMinor: v.costPriceMinor } : {}),
  ...(v.taxRateBps !== undefined ? { taxRateBps: v.taxRateBps } : {}),
  ...(v.weightGrams !== undefined ? { weightGrams: v.weightGrams } : {}),
  ...(v.dimensionsMm !== undefined ? { dimensionsMm: v.dimensionsMm ? { l: v.dimensionsMm.length, w: v.dimensionsMm.width, h: v.dimensionsMm.height } : null } : {}),
  ...(v.status !== undefined ? { status: v.status } : {}),
});

// ------------------------------------------------------------------------------------------------
// reads
// ------------------------------------------------------------------------------------------------
export async function getProductRow(tx: Tx, vendorId: string, id: string): Promise<ProductRow> {
  const [p] = await tx.select().from(P).where(and(eq(P.id, id), liveProduct(vendorId)));
  if (!p) throw Errors.notFound('Product', id);
  return p;
}

export async function getProductDetail(tx: Tx, vendorId: string, id: string) {
  const p = await getProductRow(tx, vendorId, id);
  const variants = await tx.select().from(V).where(and(liveVariant(vendorId), eq(V.productId, id))).orderBy(V.createdAt, V.id);
  return { ...toProductDto(p, variants.length), variants: variants.map(toVariantDto), attributeValues: await getProductAttributeValues(tx, vendorId, id) };
}

export interface ProductListInput {
  limit: number; cursor?: string; q?: string; status?: string; categoryId?: string; brand?: string; createdFrom?: string; createdTo?: string;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

export function productFilter(vendorId: string, f: Pick<ProductListInput, 'q' | 'status' | 'categoryId' | 'brand' | 'createdFrom' | 'createdTo'>): SQL | undefined {
  const like = f.q ? `%${escapeLike(f.q)}%` : null;
  const search: SQL | undefined = like
    ? or(
        ilike(P.title, like), ilike(P.productCode, like), ilike(P.brand, like),
        sql`exists (select 1 from product_variants pv where pv.product_id = "products"."id" and pv.deleted_at is null and (pv.sku ilike ${like} or pv.barcode ilike ${like}))`,
      )
    : undefined;
  return and(
    liveProduct(vendorId),
    f.status ? eq(P.status, f.status) : undefined,
    f.categoryId ? eq(P.categoryId, f.categoryId) : undefined,
    f.brand ? ilike(P.brand, escapeLike(f.brand)) : undefined,
    f.createdFrom ? gte(P.createdAt, new Date(f.createdFrom)) : undefined,
    f.createdTo ? lte(P.createdAt, new Date(f.createdTo)) : undefined,
    search,
  );
}

const variantCountSql = sql<number>`(select count(*)::int from product_variants pv where pv.product_id = "products"."id" and pv.deleted_at is null)`;

export async function listProducts(tx: Tx, vendorId: string, input: ProductListInput) {
  const ks = keyset<{ p: ProductRow; variantCount: number }>({
    sorts: {
      createdAt: { column: P.createdAt, kind: 'timestamp' }, updatedAt: { column: P.updatedAt, kind: 'timestamp' },
      title: { column: P.title, kind: 'text' }, productCode: { column: P.productCode, kind: 'text' },
    },
    idColumn: P.id,
    sort: input.sort,
    defaultSort: { field: 'createdAt', direction: 'desc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const field = input.sort?.[0]?.field ?? 'createdAt';
  const rows = await tx
    .select({ p: P, variantCount: variantCountSql })
    .from(P)
    .where(and(productFilter(vendorId, input), ks.where))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  const page = ks.finish(rows, ({ p }) => ({ sortValue: field === 'title' ? p.title : field === 'productCode' ? p.productCode : field === 'updatedAt' ? p.updatedAt : p.createdAt, id: p.id }));
  return { items: page.items.map(({ p, variantCount }) => toProductDto(p, variantCount)), nextCursor: page.nextCursor };
}

// ------------------------------------------------------------------------------------------------
// product writes
// ------------------------------------------------------------------------------------------------
async function assertCanActivate(tx: Tx, vendorId: string, productId: string): Promise<void> {
  const [row] = await tx.select({ id: V.id }).from(V).where(and(liveVariant(vendorId), eq(V.productId, productId), eq(V.status, 'active'))).limit(1);
  if (!row) throw new AppError('CONFLICT', 'A product needs at least one active variant (SKU) before it can be activated', { details: { rule: 'needs_variant' } });
}

export async function createProduct(tx: Tx, vendorId: string, input: ProductInput, fx: Effects) {
  if (input.categoryId) await getCategory(tx, vendorId, input.categoryId);
  await enforceLimit(tx, vendorId, 'products'); // reports always; rejects only when the platform enabled billing.enforce_limits for this vendor
  for (const v of input.variants ?? []) assertPrices(v);
  const skus = (input.variants ?? []).map((v) => v.sku);
  if (new Set(skus).size !== skus.length) throw Errors.validation({ issues: [{ path: 'variants', message: 'duplicate SKU in request' }] });

  const [p] = await tx
    .insert(P)
    .values({
      vendorId, productCode: input.productCode, title: input.title, description: input.description ?? null, brand: input.brand ?? null,
      manufacturer: input.manufacturer ?? null, countryOfOrigin: input.countryOfOrigin ?? null, categoryId: input.categoryId ?? null,
      hsnCode: input.hsnCode ?? null, gstRateBps: input.gstRateBps ?? null, tags: input.tags ?? [], status: 'draft',
    })
    .returning();
  const productId = p!.id;

  for (const v of input.variants ?? []) {
    const [row] = await tx.insert(V).values({ vendorId, productId, sku: v.sku, ...variantColumns(v) }).returning();
    await fx.event({ type: 'variant.created', aggregateType: 'variant', aggregateId: row!.id, payload: { productId, sku: v.sku } });
  }
  if (input.attributeValues?.length) {
    if (input.attributeValues.some((a) => a.variantId)) throw Errors.validation({ issues: [{ path: 'attributeValues', message: 'variant-level values can be set after the product is created' }] });
    await setProductAttributeValues(tx, vendorId, productId, input.attributeValues);
  }
  if (input.status === 'active') {
    await assertCanActivate(tx, vendorId, productId);
    await tx.update(P).set({ status: 'active' }).where(eq(P.id, productId));
  }
  await fx.event({ type: 'product.created', aggregateType: 'product', aggregateId: productId, payload: { productCode: input.productCode, status: input.status ?? 'draft' } });
  await fx.audit({ action: 'product.create', resourceType: 'product', resourceId: productId, after: { productCode: input.productCode, title: input.title, variants: skus } });
  return getProductDetail(tx, vendorId, productId);
}

export type ProductPatch = Partial<Omit<ProductInput, 'variants' | 'attributeValues'>> & { version?: number };

export async function updateProduct(tx: Tx, vendorId: string, id: string, patch: ProductPatch, fx: Effects) {
  const before = await getProductRow(tx, vendorId, id);
  if (patch.version !== undefined && patch.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  if (patch.categoryId) await getCategory(tx, vendorId, patch.categoryId);
  if (patch.status === 'active' && before.status !== 'active') await assertCanActivate(tx, vendorId, id);

  const set: Partial<typeof schema.products.$inferInsert> = {};
  for (const k of ['productCode', 'title', 'description', 'brand', 'manufacturer', 'countryOfOrigin', 'categoryId', 'hsnCode', 'gstRateBps', 'tags', 'status'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  const [after] = await tx.update(P).set({ ...set, version: sql`${P.version} + 1` as never }).where(eq(P.id, id)).returning();

  const archived = patch.status === 'archived' && before.status !== 'archived';
  await fx.event({ type: archived ? 'product.archived' : 'product.updated', aggregateType: 'product', aggregateId: id, payload: { fields: Object.keys(set) } });
  await fx.audit({
    action: archived ? 'product.archive' : 'product.update', resourceType: 'product', resourceId: id,
    before: { title: before.title, status: before.status, productCode: before.productCode }, after: { title: after!.title, status: after!.status, productCode: after!.productCode },
  });
  return getProductDetail(tx, vendorId, id);
}

/** Soft delete: product and its variants disappear from every API; rows stay for audit/order history. */
/** a variant with reserved stock or a live listing cannot be deleted: orders / marketplaces still point at it */
async function assertNoCommitments(tx: Tx, vendorId: string, variantIds: string[]): Promise<void> {
  if (variantIds.length === 0) return;
  const [res] = await tx.select({ n: sql<number>`coalesce(sum(${schema.inventory.quantityReserved}), 0)::int` }).from(schema.inventory).where(and(eq(schema.inventory.vendorId, vendorId), inArray(schema.inventory.variantId, variantIds)));
  if ((res?.n ?? 0) > 0) throw new AppError('CONFLICT', 'Units of this item are reserved for open orders', { details: { rule: 'has_reservations', reserved: res!.n } });
  const [live] = await tx.select({ id: schema.marketplaceListings.id }).from(schema.marketplaceListings).where(and(eq(schema.marketplaceListings.vendorId, vendorId), inArray(schema.marketplaceListings.variantId, variantIds), inArray(schema.marketplaceListings.status, ['active', 'pending', 'approved']))).limit(1);
  if (live) throw new AppError('CONFLICT', 'This item still has a live marketplace listing; unpublish it first', { details: { rule: 'has_live_listing', listingId: live.id } });
}

export async function deleteProduct(tx: Tx, vendorId: string, id: string, fx: Effects) {
  const p = await getProductRow(tx, vendorId, id);
  await assertNoCommitments(tx, vendorId, (await tx.select({ id: V.id }).from(V).where(and(liveVariant(vendorId), eq(V.productId, id)))).map((r) => r.id));
  const now = new Date();
  await tx.update(V).set({ deletedAt: now }).where(and(liveVariant(vendorId), eq(V.productId, id)));
  await tx.update(P).set({ deletedAt: now, status: 'archived' }).where(eq(P.id, id));
  await fx.event({ type: 'product.archived', aggregateType: 'product', aggregateId: id, payload: { deleted: true } });
  await fx.audit({ action: 'product.delete', resourceType: 'product', resourceId: id, before: { productCode: p.productCode, title: p.title } });
  return p;
}

// ------------------------------------------------------------------------------------------------
// variants
// ------------------------------------------------------------------------------------------------
export async function getVariantRow(tx: Tx, vendorId: string, id: string): Promise<VariantRow> {
  const [v] = await tx.select().from(V).where(and(eq(V.id, id), liveVariant(vendorId)));
  if (!v) throw Errors.notFound('Variant', id);
  return v;
}

export async function listProductVariants(tx: Tx, vendorId: string, productId: string) {
  await getProductRow(tx, vendorId, productId);
  const rows = await tx.select().from(V).where(and(liveVariant(vendorId), eq(V.productId, productId))).orderBy(V.createdAt, V.id);
  return rows.map(toVariantDto);
}

export async function createVariant(tx: Tx, vendorId: string, productId: string, input: VariantInput, fx: Effects) {
  await getProductRow(tx, vendorId, productId);
  assertPrices(input);
  const [row] = await tx.insert(V).values({ vendorId, productId, sku: input.sku, ...variantColumns(input) }).returning();
  await fx.event({ type: 'variant.created', aggregateType: 'variant', aggregateId: row!.id, payload: { productId, sku: input.sku } });
  await fx.audit({ action: 'variant.create', resourceType: 'variant', resourceId: row!.id, after: { sku: input.sku, productId } });
  return toVariantDto(row!);
}

export async function updateVariant(tx: Tx, vendorId: string, id: string, patch: Partial<VariantInput> & { version?: number }, fx: Effects) {
  const before = await getVariantRow(tx, vendorId, id);
  if (patch.version !== undefined && patch.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  assertPrices({ mrpMinor: patch.mrpMinor !== undefined ? patch.mrpMinor : before.mrpMinor, sellingPriceMinor: patch.sellingPriceMinor !== undefined ? patch.sellingPriceMinor : before.sellingPriceMinor, sku: before.sku });

  const cols = variantColumns(patch);
  const [after] = await tx.update(V).set({ ...cols, version: sql`${V.version} + 1` as never }).where(eq(V.id, id)).returning();
  const priceChanged = after!.sellingPriceMinor !== before.sellingPriceMinor || after!.mrpMinor !== before.mrpMinor;
  await fx.event({ type: priceChanged ? 'variant.price_changed' : 'variant.updated', aggregateType: 'variant', aggregateId: id, payload: { productId: before.productId, sku: after!.sku, fields: Object.keys(cols), ...(priceChanged ? { price: { before: { sellingPriceMinor: before.sellingPriceMinor, mrpMinor: before.mrpMinor }, after: { sellingPriceMinor: after!.sellingPriceMinor, mrpMinor: after!.mrpMinor } } } : {}) } });
  await fx.audit({
    action: 'variant.update', resourceType: 'variant', resourceId: id,
    before: { sku: before.sku, sellingPriceMinor: before.sellingPriceMinor, mrpMinor: before.mrpMinor, status: before.status },
    after: { sku: after!.sku, sellingPriceMinor: after!.sellingPriceMinor, mrpMinor: after!.mrpMinor, status: after!.status },
  });
  return toVariantDto(after!);
}

export async function deleteVariant(tx: Tx, vendorId: string, id: string, fx: Effects) {
  const v = await getVariantRow(tx, vendorId, id);
  await assertNoCommitments(tx, vendorId, [id]);
  const p = await getProductRow(tx, vendorId, v.productId);
  if (p.status === 'active' && v.status === 'active') {
    const [other] = await tx.select({ id: V.id }).from(V).where(and(liveVariant(vendorId), eq(V.productId, p.id), eq(V.status, 'active'), sql`${V.id} <> ${id}`)).limit(1);
    if (!other) throw new AppError('CONFLICT', 'An active product needs at least one active variant; deactivate or archive the product first', { details: { rule: 'needs_variant' } });
  }
  await tx.update(V).set({ deletedAt: new Date(), status: 'inactive' }).where(eq(V.id, id));
  await fx.event({ type: 'variant.updated', aggregateType: 'variant', aggregateId: id, payload: { productId: p.id, deleted: true } });
  await fx.audit({ action: 'variant.delete', resourceType: 'variant', resourceId: id, before: { sku: v.sku } });
  return v;
}

export interface VariantListInput {
  limit: number; cursor?: string; q?: string; sku?: string; barcode?: string; status?: string; productId?: string;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

export async function listVariants(tx: Tx, vendorId: string, input: VariantListInput) {
  const ks = keyset<{ v: VariantRow; productCode: string; productTitle: string }>({
    sorts: { sku: { column: V.sku, kind: 'text' }, createdAt: { column: V.createdAt, kind: 'timestamp' }, updatedAt: { column: V.updatedAt, kind: 'timestamp' } },
    idColumn: V.id,
    sort: input.sort,
    defaultSort: { field: 'sku', direction: 'asc' },
    cursor: input.cursor,
    limit: input.limit,
  });
  const like = input.q ? `%${escapeLike(input.q)}%` : null;
  const field = input.sort?.[0]?.field ?? 'sku';
  const rows = await tx
    .select({ v: V, productCode: P.productCode, productTitle: P.title })
    .from(V)
    .innerJoin(P, and(eq(P.id, V.productId), eq(P.vendorId, V.vendorId)))
    .where(and(
      liveVariant(vendorId), isNull(P.deletedAt),
      input.sku ? eq(V.sku, input.sku) : undefined,
      input.barcode ? eq(V.barcode, input.barcode) : undefined,
      input.status ? eq(V.status, input.status) : undefined,
      input.productId ? eq(V.productId, input.productId) : undefined,
      like ? or(ilike(V.sku, like), ilike(V.barcode, like), ilike(P.title, like)) : undefined,
      ks.where,
    ))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  const page = ks.finish(rows, ({ v }) => ({ sortValue: field === 'createdAt' ? v.createdAt : field === 'updatedAt' ? v.updatedAt : v.sku, id: v.id }));
  return { items: page.items.map(({ v, productCode, productTitle }) => ({ ...toVariantDto(v), productCode, productTitle })), nextCursor: page.nextCursor };
}

// ------------------------------------------------------------------------------------------------
// bulk
// ------------------------------------------------------------------------------------------------
export interface BulkItemResult { index: number; id: string | null; ok: boolean; error: { code: string; message: string } | null }

/**
 * Runs `fn` for each item in its own SAVEPOINT: one failing item (duplicate SKU, bad category...) rolls back only
 * itself, the rest of the batch still commits. Returns a per-item report (HTTP 200 with partial success).
 */
export async function runBulk<T>(tx: Tx, items: T[], fn: (inner: Tx, item: T, index: number) => Promise<string | null>): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const id = await tx.transaction((inner) => fn(inner as unknown as Tx, item, index));
      results.push({ index, id, ok: true, error: null });
    } catch (e) {
      const ae = e instanceof AppError ? e : null;
      const pg = (e as { cause?: { code?: string; constraint?: string } })?.cause;
      const duplicate = pg?.code === '23505';
      results.push({ index, id: null, ok: false, error: { code: ae?.code ?? (duplicate ? 'CONFLICT' : 'INTERNAL'), message: ae ? ae.message : duplicate ? `Duplicate value (${pg?.constraint ?? 'unique constraint'})` : 'Unexpected error' } });
      if (!ae && !duplicate) throw e; // genuine bug: abort the whole request rather than hide it
    }
  }
  return results;
}

export async function findProductsByIds(tx: Tx, vendorId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx.select({ id: P.id }).from(P).where(and(liveProduct(vendorId), inArray(P.id, ids)));
  return new Set(rows.map((r) => r.id));
}

