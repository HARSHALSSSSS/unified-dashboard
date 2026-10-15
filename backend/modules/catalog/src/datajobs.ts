import { and, asc, eq, gt, inArray, isNull, keyset, schema, withVendor, type Tx } from '@oms/database';
import { AppError, Errors, newId } from '@oms/shared';
import { tenantKey } from '@oms/storage';
import type { Container, JobHandler } from '@oms/module-kit';
import type { JobEnvelope } from '@oms/messaging';
import { parseCsv, toCsv } from './csv';
import { jobEffects } from './effects';
import { createProduct, createVariant, productFilter, updateProduct, updateVariant, type ProductInput, type VariantInput } from './service';
import { ProductUpdateSchema, VariantUpdateSchema } from './schemas';

export type DataJobRow = typeof schema.dataJobs.$inferSelect;
const J = schema.dataJobs;

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;
const MAX_STORED_ERRORS = 200;

export const EXPORT_HEADERS = [
  'product_code', 'title', 'description', 'brand', 'manufacturer', 'country_of_origin', 'category_slug', 'hsn_code', 'gst_rate_bps', 'tags', 'status',
  'sku', 'barcode', 'option_values', 'currency', 'mrp_minor', 'selling_price_minor', 'cost_price_minor', 'tax_rate_bps', 'weight_grams', 'length_mm', 'width_mm', 'height_mm', 'variant_status',
] as const;

export const toJobDto = (j: DataJobRow) => ({
  id: j.id,
  kind: j.kind as 'import' | 'export',
  entity: j.entity,
  status: j.status,
  format: j.format,
  stats: j.stats,
  errors: j.errors,
  hasInput: Boolean((j.params as { uploaded?: boolean }).uploaded),
  hasOutput: Boolean(j.outputKey),
  startedAt: j.startedAt ? j.startedAt.toISOString() : null,
  finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  createdAt: j.createdAt.toISOString(),
});

export async function getJob(tx: Tx, vendorId: string, id: string): Promise<DataJobRow> {
  const [j] = await tx.select().from(J).where(and(eq(J.id, id), eq(J.vendorId, vendorId)));
  if (!j) throw Errors.notFound('Data job', id);
  return j;
}

export async function listJobs(tx: Tx, vendorId: string, input: { limit: number; cursor?: string; kind?: string }) {
  const ks = keyset<DataJobRow>({ sorts: { createdAt: { column: J.createdAt, kind: 'timestamp' } }, idColumn: J.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: input.cursor, limit: input.limit });
  const rows = await tx.select().from(J).where(and(eq(J.vendorId, vendorId), input.kind ? eq(J.kind, input.kind) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  const page = ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
  return { items: page.items.map(toJobDto), nextCursor: page.nextCursor };
}

// ------------------------------------------------------------------------------------------------
// creation / upload / start
// ------------------------------------------------------------------------------------------------
export async function createImportJob(tx: Tx, vendorId: string, userId: string): Promise<DataJobRow> {
  const id = newId();
  const [j] = await tx.insert(J).values({ id, vendorId, kind: 'import', status: 'awaiting_upload', inputKey: tenantKey(vendorId, 'imports', id, 'products.csv'), requestedBy: userId }).returning();
  return j!;
}

export async function createExportJob(tx: Tx, vendorId: string, userId: string, filters: Record<string, unknown>): Promise<DataJobRow> {
  const [j] = await tx.insert(J).values({ vendorId, kind: 'export', status: 'queued', params: filters, requestedBy: userId }).returning();
  return j!;
}

/** Store the uploaded CSV (API strategy) and mark the job ready to start. */
export async function storeImportFile(tx: Tx, c: Container, vendorId: string, jobId: string, body: Buffer): Promise<DataJobRow> {
  const job = await getJob(tx, vendorId, jobId);
  if (job.kind !== 'import' || job.status !== 'awaiting_upload') throw new AppError('CONFLICT', 'This job is not waiting for a file');
  if (body.length === 0) throw new AppError('BAD_REQUEST', 'Empty file');
  if (body.length > MAX_IMPORT_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', `CSV must be at most ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  await c.storage.put(job.inputKey!, body, 'text/csv');
  const [after] = await tx.update(J).set({ params: { ...job.params, uploaded: true, bytes: body.length } }).where(eq(J.id, jobId)).returning();
  return after!;
}

/** Move an import from "awaiting_upload" to "queued" after verifying the file really is in storage. */
export async function markImportQueued(tx: Tx, c: Container, vendorId: string, jobId: string): Promise<DataJobRow> {
  const job = await getJob(tx, vendorId, jobId);
  if (job.kind !== 'import') throw new AppError('CONFLICT', 'Only import jobs can be started');
  if (job.status !== 'awaiting_upload') throw new AppError('CONFLICT', `Job is already ${job.status}`);
  const head = await c.storage.head(job.inputKey!);
  if (!head) throw new AppError('CONFLICT', 'Upload the CSV file before starting the import', { details: { rule: 'file_missing' } });
  if (head.size > MAX_IMPORT_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'CSV too large');
  const [after] = await tx.update(J).set({ status: 'queued', params: { ...job.params, uploaded: true } }).where(eq(J.id, jobId)).returning();
  return after!;
}

export const jobEnvelope = (vendorId: string, correlationId: string, jobId: string): JobEnvelope<{ jobId: string }> => ({ vendorId, correlationId, idempotencyKey: `data-job-${jobId}`, data: { jobId } });
export const JOB_NAMES = { import: 'catalog.import-products', export: 'catalog.export-products' } as const;

export async function readOutput(tx: Tx, c: Container, vendorId: string, jobId: string): Promise<{ body: Buffer; fileName: string }> {
  const job = await getJob(tx, vendorId, jobId);
  if (!job.outputKey) throw new AppError('CONFLICT', 'This job has no output (yet)');
  const body = await c.storage.get(job.outputKey);
  if (!body) throw Errors.notFound('Output file', jobId);
  return { body, fileName: `products-export-${job.createdAt.toISOString().slice(0, 10)}.csv` };
}

// ------------------------------------------------------------------------------------------------
// worker: import
// ------------------------------------------------------------------------------------------------
const clean = (v: string | undefined): string => (v ?? '').trim().replace(/^'(?=[=+\-@])/, '');
const num = (v: string): number | undefined => (v === '' ? undefined : Number(v));

function parseOptionValues(s: string): Record<string, string> | undefined {
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const [k, ...rest] = part.split('=');
    if (k?.trim() && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

interface ParsedRow { line: number; cells: Record<string, string> }

function productPatch(c: Record<string, string>, categoryId: string | null | undefined) {
  const raw: Record<string, unknown> = {};
  const set = (key: string, v: unknown) => { if (v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) raw[key] = v; };
  set('title', c.title); set('description', c.description); set('brand', c.brand); set('manufacturer', c.manufacturer);
  set('countryOfOrigin', c.country_of_origin?.toUpperCase()); set('hsnCode', c.hsn_code); set('gstRateBps', num(c.gst_rate_bps ?? ''));
  if (c.tags) raw.tags = c.tags.split('|').map((t) => t.trim()).filter(Boolean);
  if (c.status) raw.status = c.status.toLowerCase();
  if (categoryId) raw.categoryId = categoryId;
  return raw;
}

function variantPatch(c: Record<string, string>) {
  const raw: Record<string, unknown> = {};
  const set = (key: string, v: unknown) => { if (v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) raw[key] = v; };
  set('barcode', c.barcode); set('currency', c.currency?.toUpperCase());
  set('mrpMinor', num(c.mrp_minor ?? '')); set('sellingPriceMinor', num(c.selling_price_minor ?? '')); set('costPriceMinor', num(c.cost_price_minor ?? ''));
  set('taxRateBps', num(c.tax_rate_bps ?? '')); set('weightGrams', num(c.weight_grams ?? ''));
  const opts = parseOptionValues(c.option_values ?? '');
  if (opts) raw.optionValues = opts;
  if (c.length_mm && c.width_mm && c.height_mm) raw.dimensionsMm = { length: Number(c.length_mm), width: Number(c.width_mm), height: Number(c.height_mm) };
  if (c.variant_status) raw.status = c.variant_status.toLowerCase();
  return raw;
}

const issuesToText = (issues: Array<{ path: PropertyKey[]; message: string }>) => issues.map((i) => `${i.path.map(String).join('.') || 'row'}: ${i.message}`).join('; ');

export const importProductsHandler: JobHandler = {
  queue: 'heavy',
  name: JOB_NAMES.import,
  async handle(env, c) {
    const vendorId = env.vendorId;
    const { jobId } = env.data as { jobId: string };
    if (!vendorId) throw new Error('import job without tenant');
    const db = c.database.db;

    const job = await withVendor(db, vendorId, async (tx) => {
      const j = await getJob(tx, vendorId, jobId);
      if (j.status === 'succeeded' || j.status === 'partially_failed' || j.status === 'failed') return null; // replay of a finished job: no-op
      await tx.update(J).set({ status: 'running', startedAt: new Date() }).where(eq(J.id, jobId));
      return j;
    });
    if (!job) return;

    const errors: Array<{ row: number; message: string }> = [];
    const stats = { rows: 0, productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0, failedRows: 0 };
    const finish = (status: string) => withVendor(db, vendorId, (tx) => tx.update(J).set({ status, stats, errors: errors.slice(0, MAX_STORED_ERRORS), finishedAt: new Date() }).where(eq(J.id, jobId)));

    const file = job.inputKey ? await c.storage.get(job.inputKey) : null;
    if (!file) { errors.push({ row: 0, message: 'Uploaded file not found' }); await finish('failed'); return; }
    const table = parseCsv(file.toString('utf8'));
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    for (const required of ['product_code', 'sku']) {
      if (!header.includes(required)) { errors.push({ row: 1, message: `Missing required column "${required}"` }); await finish('failed'); return; }
    }
    if (table.length - 1 > MAX_IMPORT_ROWS) { errors.push({ row: 0, message: `Too many rows (max ${MAX_IMPORT_ROWS})` }); await finish('failed'); return; }

    // group rows by product_code, preserving file order
    const groups = new Map<string, ParsedRow[]>();
    for (const [i, cells] of table.slice(1).entries()) {
      const rec = Object.fromEntries(header.map((h, idx) => [h, clean(cells[idx])]));
      stats.rows++;
      const code = rec.product_code ?? '';
      if (!code) { errors.push({ row: i + 2, message: 'product_code is empty' }); stats.failedRows++; continue; }
      (groups.get(code) ?? groups.set(code, []).get(code)!).push({ line: i + 2, cells: rec });
    }

    for (const [code, rows] of groups) {
      const n = { productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0 }; // counted only if the group commits
      try {
        await withVendor(db, vendorId, async (tx) => {
          const fx = jobEffects(tx, { vendorId, correlationId: env.correlationId, actorId: job.requestedBy, jobId });
          const first = rows[0]!;

          let categoryId: string | null | undefined;
          if (first.cells.category_slug) {
            const [cat] = await tx.select({ id: schema.categories.id }).from(schema.categories).where(and(eq(schema.categories.vendorId, vendorId), eq(schema.categories.slug, first.cells.category_slug), isNull(schema.categories.deletedAt)));
            if (!cat) throw new AppError('BAD_REQUEST', `category_slug "${first.cells.category_slug}" not found`);
            categoryId = cat.id;
          }

          const pp = productPatch(first.cells, categoryId);
          const parsedP = ProductUpdateSchema.safeParse(pp);
          if (!parsedP.success) throw new AppError('VALIDATION_FAILED', issuesToText(parsedP.error.issues));
          const { status: wantedStatus, ...productFields } = parsedP.data;

          const [existing] = await tx.select().from(schema.products).where(and(eq(schema.products.vendorId, vendorId), eq(schema.products.productCode, code), isNull(schema.products.deletedAt)));
          let productId: string;
          if (existing) {
            productId = existing.id;
            if (Object.keys(productFields).length) await updateProduct(tx, vendorId, productId, productFields, fx);
            n.productsUpdated++;
          } else {
            if (!productFields.title) throw new AppError('VALIDATION_FAILED', 'title is required for a new product');
            const created = await createProduct(tx, vendorId, { ...(productFields as Omit<ProductInput, 'productCode'>), productCode: code, title: productFields.title, status: 'draft' }, fx);
            productId = created.id;
            n.productsCreated++;
          }

          for (const row of rows) {
            const sku = row.cells.sku;
            if (!sku) continue; // product-only row
            const vp = variantPatch(row.cells);
            const parsedV = VariantUpdateSchema.safeParse(vp);
            if (!parsedV.success) throw new AppError('VALIDATION_FAILED', `row ${row.line}: ${issuesToText(parsedV.error.issues)}`);
            const [ev] = await tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.vendorId, vendorId), eq(schema.productVariants.sku, sku), isNull(schema.productVariants.deletedAt)));
            if (ev) {
              if (ev.productId !== productId) throw new AppError('CONFLICT', `row ${row.line}: SKU ${sku} belongs to another product`);
              if (Object.keys(parsedV.data).length) await updateVariant(tx, vendorId, ev.id, parsedV.data, fx);
              n.variantsUpdated++;
            } else {
              await createVariant(tx, vendorId, productId, { ...(parsedV.data as Omit<VariantInput, 'sku'>), sku }, fx);
              n.variantsCreated++;
            }
          }

          if (wantedStatus && (!existing || wantedStatus !== existing.status)) await updateProduct(tx, vendorId, productId, { status: wantedStatus }, fx);
        });
        stats.productsCreated += n.productsCreated; stats.productsUpdated += n.productsUpdated; stats.variantsCreated += n.variantsCreated; stats.variantsUpdated += n.variantsUpdated;
      } catch (e) {
        if (!(e instanceof AppError) && !(e as { cause?: { code?: string } })?.cause?.code) throw e;
        const pg = (e as { cause?: { code?: string; constraint?: string } }).cause;
        const message = e instanceof AppError ? e.message : pg?.code === '23505' ? `duplicate value (${pg.constraint})` : 'database constraint violated';
        errors.push({ row: rows[0]!.line, message: `${code}: ${message}` });
        stats.failedRows += rows.length;
      }
    }

    const ok = stats.failedRows === 0;
    await finish(ok ? 'succeeded' : stats.failedRows >= stats.rows ? 'failed' : 'partially_failed');
  },
};

// ------------------------------------------------------------------------------------------------
// worker: export
// ------------------------------------------------------------------------------------------------
export const MAX_EXPORT_PRODUCTS = 50_000;

export const exportProductsHandler: JobHandler = {
  queue: 'heavy',
  name: JOB_NAMES.export,
  async handle(env, c) {
    const vendorId = env.vendorId;
    const { jobId } = env.data as { jobId: string };
    if (!vendorId) throw new Error('export job without tenant');
    const db = c.database.db;

    const job = await withVendor(db, vendorId, async (tx) => {
      const j = await getJob(tx, vendorId, jobId);
      if (j.status === 'succeeded' || j.status === 'failed') return null;
      await tx.update(J).set({ status: 'running', startedAt: new Date() }).where(eq(J.id, jobId));
      return j;
    });
    if (!job) return;

    try {
      const filters = job.params as { status?: string; categoryId?: string; q?: string };
      const lines: Array<Array<string | number | null>> = [[...EXPORT_HEADERS]];
      let lastId: string | null = null;
      let products = 0;
      const P = schema.products;

      while (products < MAX_EXPORT_PRODUCTS) {
        const batch = await withVendor(db, vendorId, async (tx) => {
          const prods = await tx.select().from(P).where(and(productFilter(vendorId, filters), lastId ? gt(P.id, lastId) : undefined)).orderBy(asc(P.id)).limit(500);
          if (!prods.length) return null;
          const variants = await tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.vendorId, vendorId), inArray(schema.productVariants.productId, prods.map((p) => p.id)), isNull(schema.productVariants.deletedAt))).orderBy(schema.productVariants.createdAt, schema.productVariants.id);
          const catIds = [...new Set(prods.flatMap((p) => (p.categoryId ? [p.categoryId] : [])))];
          const cats = catIds.length ? await tx.select({ id: schema.categories.id, slug: schema.categories.slug }).from(schema.categories).where(inArray(schema.categories.id, catIds)) : [];
          return { prods, variants, cats };
        });
        if (!batch) break;
        for (const p of batch.prods) {
          const base = [p.productCode, p.title, p.description, p.brand, p.manufacturer, p.countryOfOrigin, batch.cats.find((x) => x.id === p.categoryId)?.slug ?? '', p.hsnCode, p.gstRateBps, p.tags.join('|'), p.status];
          const vs = batch.variants.filter((v) => v.productId === p.id);
          if (!vs.length) lines.push([...base, ...Array(13).fill('')]);
          for (const v of vs) {
            lines.push([
              ...base, v.sku, v.barcode, Object.entries(v.optionValues as Record<string, string>).map(([k, val]) => `${k}=${val}`).join(';'), v.currency.trim(),
              v.mrpMinor, v.sellingPriceMinor, v.costPriceMinor, v.taxRateBps, v.weightGrams, v.dimensionsMm?.l ?? null, v.dimensionsMm?.w ?? null, v.dimensionsMm?.h ?? null, v.status,
            ]);
          }
        }
        products += batch.prods.length;
        lastId = batch.prods[batch.prods.length - 1]!.id;
      }

      const key = tenantKey(vendorId, 'exports', jobId, 'products.csv');
      await c.storage.put(key, Buffer.from(toCsv(lines), 'utf8'), 'text/csv');
      await withVendor(db, vendorId, (tx) => tx.update(J).set({ status: 'succeeded', outputKey: key, stats: { products, rows: lines.length - 1 }, finishedAt: new Date() }).where(eq(J.id, jobId)));
    } catch (e) {
      await withVendor(db, vendorId, (tx) => tx.update(J).set({ status: 'failed', errors: [{ row: 0, message: 'Export failed' }], finishedAt: new Date() }).where(eq(J.id, jobId)));
      throw e;
    }
  },
};
