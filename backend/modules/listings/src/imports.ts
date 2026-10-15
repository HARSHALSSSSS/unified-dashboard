/* eslint-disable @typescript-eslint/no-explicit-any -- marketplace wire payloads are untyped JSON */
import { and, desc, eq, inArray, keyset, schema, sql, withVendor, type Tx } from '@oms/database';
import { requireCapability, type NormalizedProduct } from '@oms/marketplace-core';
import { AppError, Errors } from '@oms/shared';
import { createProduct } from '@oms/mod-catalog';
import { receiveStock } from '@oms/mod-inventory';
import { enqueueSyncJob, type SyncRunner } from '@oms/mod-sync';
import { allocationOrder } from '@oms/mod-warehouses';
import { assertAccount } from './channel';
import type { Ctx } from './ctx';
import { fx } from './ctx';
import { fromReport, stableHash, type ListingStatus } from './domain';

const IP = schema.importedProducts;
const L = schema.marketplaceListings;
const V = schema.productVariants;

// ------------------------------------------------------------------------------------------------
// import runner:  marketplace product -> connector mapper -> NORMALISED product (imported_products) ; master product comes later
// ------------------------------------------------------------------------------------------------
const PAGE = 50;

export const catalogImportRunner: SyncRunner = async (ctx) => {
  const { c, vendorId, accountId, host } = ctx;
  if (!accountId) throw new AppError('BAD_REQUEST', 'catalog import needs an account');
  const db = c.database.db;
  const stats = { fetched: 0, created: 0, updated: 0, unchanged: 0, linked: 0 };
  // a retry resumes where the previous attempt stopped (cursor persisted after every committed page)
  let cursor: string | null = ((ctx.job.cursor as { cursor?: string | null } | null)?.cursor) ?? null;
  const resumed = cursor !== null;
  if (resumed) await ctx.log('info', 'resuming import from the saved cursor');

  do {
    const page = await host.run(vendorId, accountId, async (conn, cctx) => {
      requireCapability(conn, 'catalog.import');
      return conn.importProducts!(cctx, { cursor, limit: PAGE });
    });
    await withVendor(db, vendorId, async (tx) => {
      const existing = await tx.select().from(IP).where(and(eq(IP.marketplaceAccountId, accountId), inArray(IP.externalSku, page.items.map((p) => p.externalSku))));
      const bySku = new Map(existing.map((e) => [e.externalSku, e]));
      const listings = await tx.select({ id: L.id, sku: L.externalSku, variantId: L.variantId }).from(L).where(and(eq(L.marketplaceAccountId, accountId), inArray(L.externalSku, page.items.map((p) => p.externalSku))));
      const listingBySku = new Map(listings.map((l) => [l.sku, l]));
      for (const p of page.items) {
        stats.fetched++;
        const normalized = toNormalizedRecord(p);
        const hash = stableHash(normalized);
        const have = bySku.get(p.externalSku);
        if (!have) {
          const known = listingBySku.get(p.externalSku);
          await tx.insert(IP).values({
            vendorId, marketplaceAccountId: accountId, externalListingId: p.externalListingId, externalSku: p.externalSku, title: p.title, normalized, raw: p.raw ?? null, contentHash: hash,
            status: known ? 'linked' : 'new', variantId: known?.variantId ?? null, listingId: known?.id ?? null, syncJobId: ctx.job.id,
          });
          stats.created++;
          if (known) stats.linked++;
        } else if (have.contentHash !== hash) {
          await tx.update(IP).set({ title: p.title, normalized, raw: p.raw ?? null, contentHash: hash, externalListingId: p.externalListingId, importedAt: new Date(), syncJobId: ctx.job.id }).where(eq(IP.id, have.id));
          stats.updated++;
        } else stats.unchanged++;
      }
    });
    cursor = page.nextCursor;
    await ctx.setCursor(cursor ? { cursor } : null);
    await ctx.progress({ done: stats.fetched });
  } while (cursor);
  return { stats };
};

/** the stored shape: marketplace-neutral, never the marketplace's own DTO */
export function toNormalizedRecord(p: NormalizedProduct): Record<string, unknown> {
  return {
    externalListingId: p.externalListingId, externalSku: p.externalSku, title: p.title, description: p.description ?? null, brand: p.brand ?? null, barcode: p.barcode ?? null,
    category: p.category ?? null, priceMinor: p.priceMinor ?? null, mrpMinor: p.mrpMinor ?? null, currency: p.currency ?? 'INR', quantity: p.quantity ?? null, imageUrls: p.imageUrls ?? [],
    attributes: p.attributes ?? {}, status: p.status ?? 'active', marketplaceStatus: p.marketplaceStatus ?? null,
  };
}

export async function requestImport(ctx: Ctx, accountId: string) {
  const { c, vendorId } = ctx;
  await withVendor(c.database.db, vendorId, async (tx) => {
    const acc = await assertAccount(tx, vendorId, accountId);
    const conn = c.connectors.get(acc.marketplace);
    requireCapability(conn, 'catalog.import');
    if (acc.status !== 'active') throw new AppError('ACCOUNT_NOT_CONNECTED', undefined, { details: { status: acc.status } });
  });
  return enqueueSyncJob(c, { vendorId, accountId, type: 'catalog_import', trigger: 'manual', coalesce: true, idempotencyKey: `catalog-import:${accountId}:${Date.now()}`, requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : null });
}

// ------------------------------------------------------------------------------------------------
// imported products: read + operator actions
// ------------------------------------------------------------------------------------------------
export type ImportedRow = typeof IP.$inferSelect;

export const toImportedDto = (r: ImportedRow, suggestion: { variantId: string; sku: string } | null) => {
  const n = r.normalized as Record<string, any>;
  return {
    id: r.id, marketplaceAccountId: r.marketplaceAccountId, externalListingId: r.externalListingId, externalSku: r.externalSku, title: r.title, status: r.status as 'new' | 'linked' | 'ignored',
    brand: (n.brand ?? null) as string | null, priceMinor: (n.priceMinor ?? null) as number | null, mrpMinor: (n.mrpMinor ?? null) as number | null, currency: String(n.currency ?? 'INR'), quantity: (n.quantity ?? null) as number | null,
    categoryId: (n.category?.id ?? null) as string | null, marketplaceStatus: (n.marketplaceStatus ?? null) as string | null, listingStatus: String(n.status ?? 'active'),
    variantId: r.variantId, listingId: r.listingId, suggestedMatch: suggestion, importedAt: r.importedAt.toISOString(),
  };
};

export async function listImported(tx: Tx, vendorId: string, f: { limit: number; cursor?: string; accountId?: string; status?: string; q?: string }) {
  const ks = keyset<ImportedRow>({ sorts: { importedAt: { column: IP.importedAt, kind: 'timestamp' } }, idColumn: IP.id, defaultSort: { field: 'importedAt', direction: 'desc' }, cursor: f.cursor, limit: f.limit });
  const rows = await tx
    .select().from(IP)
    .where(and(eq(IP.vendorId, vendorId), f.accountId ? eq(IP.marketplaceAccountId, f.accountId) : undefined, f.status ? eq(IP.status, f.status) : undefined, f.q ? sql`(${IP.title} ILIKE ${'%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'} OR ${IP.externalSku} ILIKE ${'%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'})` : undefined, ks.where))
    .orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.importedAt, id: r.id }));
  // suggest a master variant with the same SKU for rows not linked yet
  const open = page.items.filter((r) => r.status === 'new');
  const variants = open.length ? await tx.select({ id: V.id, sku: V.sku }).from(V).where(and(eq(V.vendorId, vendorId), inArray(V.sku, open.map((r) => r.externalSku)), sql`${V.deletedAt} IS NULL`)) : [];
  const bySku = new Map(variants.map((v) => [v.sku, v]));
  return { items: page.items.map((r) => toImportedDto(r, bySku.has(r.externalSku) ? { variantId: bySku.get(r.externalSku)!.id, sku: r.externalSku } : null)), nextCursor: page.nextCursor };
}

async function getImported(tx: Tx, vendorId: string, id: string): Promise<ImportedRow> {
  const [r] = await tx.select().from(IP).where(and(eq(IP.id, id), eq(IP.vendorId, vendorId)));
  if (!r) throw Errors.notFound('Imported product', id);
  return r;
}

const safeSku = (s: string): string => (s.replace(/[^A-Za-z0-9._\-/]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'IMPORTED');

/** an existing marketplace listing becomes a tracked listing of a master variant (no publish: it is already live) */
async function adoptListing(tx: Tx, ctx: Ctx, imp: ImportedRow, variantId: string) {
  const n = imp.normalized as Record<string, any>;
  const [acc] = await tx.select().from(schema.marketplaceAccounts).where(and(eq(schema.marketplaceAccounts.id, imp.marketplaceAccountId), eq(schema.marketplaceAccounts.vendorId, ctx.vendorId)));
  const status: ListingStatus = fromReport((n.status ?? 'active') as never);
  const [dup] = await tx.select({ id: L.id }).from(L).where(and(eq(L.marketplaceAccountId, imp.marketplaceAccountId), eq(L.variantId, variantId)));
  if (dup) throw new AppError('CONFLICT', 'This variant already has a listing on that marketplace account', { details: { listingId: dup.id } });
  const [row] = await tx
    .insert(L)
    .values({
      vendorId: ctx.vendorId, marketplaceAccountId: imp.marketplaceAccountId, variantId, externalListingId: imp.externalListingId, externalSku: imp.externalSku, status, externalStatus: n.marketplaceStatus ?? null,
      source: 'imported', marketplaceCategoryId: n.category?.id ?? null, currency: String(n.currency ?? 'INR'), publishedAt: status === 'active' ? new Date() : null, attributeValues: {},
    })
    .returning();
  await tx.update(IP).set({ status: 'linked', variantId, listingId: row!.id }).where(eq(IP.id, imp.id));
  const f = fx(tx, ctx);
  await f.event({ type: 'listing.created', aggregateType: 'listing', aggregateId: row!.id, payload: { marketplace: acc!.marketplace, variantId, accountId: acc!.id, source: 'imported' } });
  await f.audit({ action: 'listing.import_link', resourceType: 'listing', resourceId: row!.id, after: { importedProductId: imp.id, sku: imp.externalSku, status } });
  return row!;
}

/** Marketplace Product -> Normalised Product -> MASTER PRODUCT (+ variant) -> tracked listing. Optionally seeds opening stock. */
export async function createMasterFromImported(tx: Tx, ctx: Ctx, id: string, opts: { productCode?: string; initialQuantity?: number; warehouseId?: string } = {}) {
  const imp = await getImported(tx, ctx.vendorId, id);
  if (imp.status !== 'new') throw new AppError('INVALID_STATE', `This imported product is already ${imp.status}`, { details: { status: imp.status } });
  const n = imp.normalized as Record<string, any>;
  const sku = safeSku(imp.externalSku);
  const [clash] = await tx.select({ id: V.id }).from(V).where(and(eq(V.vendorId, ctx.vendorId), eq(V.sku, sku), sql`${V.deletedAt} IS NULL`));
  if (clash) throw new AppError('CONFLICT', 'A variant with this SKU already exists: link the imported product to it instead', { details: { field: 'sku', variantId: clash.id } });

  const price: number | null = n.priceMinor ?? null;
  const mrp: number | null = n.mrpMinor ?? null;
  const product = await createProduct(tx, ctx.vendorId, {
    productCode: opts.productCode ?? sku, title: String(n.title ?? imp.title), description: n.description ?? null, brand: n.brand ?? null, status: 'active', tags: ['imported'],
    variants: [{ sku, barcode: n.barcode ?? null, currency: String(n.currency ?? 'INR'), sellingPriceMinor: price, mrpMinor: mrp !== null && price !== null && price > mrp ? price : mrp, optionValues: {}, status: 'active' }],
  }, fx(tx, ctx));
  const variantId = product.variants[0]!.id;
  const listing = await adoptListing(tx, ctx, imp, variantId);

  let stocked = 0;
  if (opts.initialQuantity && opts.initialQuantity > 0) {
    const warehouseId = opts.warehouseId ?? (await allocationOrder(tx, ctx.vendorId))[0]?.id;
    if (!warehouseId) throw new AppError('CONFLICT', 'Create a warehouse before seeding opening stock', { details: { rule: 'needs_warehouse' } });
    await receiveStock(tx, { vendorId: ctx.vendorId, variantId, warehouseId, quantity: opts.initialQuantity, reason: `opening stock from ${imp.externalSku} marketplace import`, referenceType: 'import', referenceId: imp.id, idempotencyKey: `import-stock:${imp.id}`, actor: ctx.actor });
    stocked = opts.initialQuantity;
  }
  return { importedProductId: imp.id, productId: product.id, variantId, listingId: listing.id, openingStock: stocked };
}

export async function linkImported(tx: Tx, ctx: Ctx, id: string, variantId: string) {
  const imp = await getImported(tx, ctx.vendorId, id);
  if (imp.status !== 'new') throw new AppError('INVALID_STATE', `This imported product is already ${imp.status}`, { details: { status: imp.status } });
  const [v] = await tx.select({ id: V.id }).from(V).where(and(eq(V.id, variantId), eq(V.vendorId, ctx.vendorId), sql`${V.deletedAt} IS NULL`));
  if (!v) throw Errors.notFound('Variant', variantId);
  const listing = await adoptListing(tx, ctx, imp, variantId);
  return { importedProductId: imp.id, variantId, listingId: listing.id };
}

export async function ignoreImported(tx: Tx, ctx: Ctx, id: string) {
  const imp = await getImported(tx, ctx.vendorId, id);
  if (imp.status === 'linked') throw new AppError('INVALID_STATE', 'A linked product cannot be ignored', { details: { status: imp.status } });
  await tx.update(IP).set({ status: 'ignored' }).where(eq(IP.id, id));
  await fx(tx, ctx).audit({ action: 'imported_product.ignore', resourceType: 'imported_product', resourceId: id });
}

export const recentImportedCount = async (tx: Tx, vendorId: string, accountId: string): Promise<number> =>
  (await tx.select({ n: sql<number>`count(*)::int` }).from(IP).where(and(eq(IP.vendorId, vendorId), eq(IP.marketplaceAccountId, accountId), eq(IP.status, 'new'))))[0]!.n;

export { desc };
