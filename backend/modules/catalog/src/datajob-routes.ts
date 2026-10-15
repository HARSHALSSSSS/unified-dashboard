import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { created, ok, paginated, vendorTx } from '@oms/module-kit';
import { IdParamSchema, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { AppError } from '@oms/shared';
import { requestEffects } from './effects';
import * as jobs from './datajobs';
import { DataJobSchema, ExportBodySchema, UploadInstructionSchema } from './schemas';

/**
 * Bulk import/export architecture:
 *   POST /products/imports        -> job (awaiting_upload) + upload instruction
 *   upload the CSV                -> POST /data-jobs/:id/file  (or a pre-signed PUT when the storage provider supports it)
 *   POST /data-jobs/:id/start     -> queued on the `heavy` queue, processed by apps/worker (row-level error report)
 *   POST /products/exports        -> job queued; GET /data-jobs/:id/download when succeeded
 * Files live in object storage under vendors/<vendorId>/imports|exports/<jobId>/.
 */
export const dataJobRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const TAGS = ['Data Jobs'];
  const CSV_LIMIT = jobs.MAX_IMPORT_BYTES;

  // raw CSV bodies (text/csv) only inside this plugin
  app.addContentTypeParser(['text/csv', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: CSV_LIMIT }, (_req, body, done) => done(null, body));

  const enqueue = async (kind: 'import' | 'export', vendorId: string, correlationId: string, jobId: string) => {
    await c.queues.enqueue('heavy', jobs.JOB_NAMES[kind], jobs.jobEnvelope(vendorId, correlationId, jobId));
  };

  r.post('/products/imports', {
    config: { access: { permission: 'products:write' } },
    schema: {
      tags: TAGS,
      summary: 'Start a product CSV import (step 1: create the job)',
      description: 'Returns the job and how to upload the CSV. Columns: product_code, title, description, brand, manufacturer, country_of_origin, category_slug, hsn_code, gst_rate_bps, tags (pipe-separated), status, sku, barcode, option_values (k=v;k=v), currency, mrp_minor, selling_price_minor, cost_price_minor, tax_rate_bps, weight_grams, length_mm, width_mm, height_mm, variant_status. Rows are grouped by product_code; products and SKUs are upserted.',
      response: { 201: successEnvelope(z.object({ job: DataJobSchema, upload: UploadInstructionSchema })) },
    },
  }, async (req, reply) => {
    const job = await vendorTx(req, (tx, vendorId) => jobs.createImportJob(tx, vendorId, req.ctx.principal!.actorId));
    const upload = { strategy: 'api' as const, method: 'POST', url: `/api/v1/data-jobs/${job.id}/file`, headers: { 'Content-Type': 'text/csv' } };
    return created(req, reply, { job: jobs.toJobDto(job), upload });
  });

  r.post('/data-jobs/:id/file', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: TAGS, summary: 'Upload the CSV for an import job (step 2)', description: 'Raw `text/csv` body, max 5 MB.', params: IdParamSchema, response: { 200: successEnvelope(DataJobSchema) } },
  }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the CSV as the raw request body with Content-Type: text/csv');
    const body = req.body;
    return ok(req, jobs.toJobDto(await vendorTx(req, (tx, vendorId) => jobs.storeImportFile(tx, c, vendorId, req.params.id, body))));
  });

  r.post('/data-jobs/:id/start', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: TAGS, summary: 'Start an uploaded import (step 3)', params: IdParamSchema, response: { 202: successEnvelope(DataJobSchema) } },
  }, async (req, reply) => {
    const job = await vendorTx(req, async (tx, vendorId) => {
      const j = await jobs.markImportQueued(tx, c, vendorId, req.params.id);
      await requestEffects(tx, req).audit({ action: 'product.import_start', resourceType: 'data_job', resourceId: j.id });
      return j;
    });
    await enqueue('import', job.vendorId, req.ctx.correlationId, job.id);
    reply.code(202);
    return ok(req, jobs.toJobDto(job));
  });

  r.post('/products/exports', {
    config: { access: { permission: 'products:read' } },
    schema: {
      tags: TAGS,
      summary: 'Export products to CSV (asynchronous)',
      description: 'Queues an export of the (optionally filtered) catalogue, one row per variant. Poll GET /data-jobs/{id}, then download.',
      body: ExportBodySchema,
      response: { 202: successEnvelope(DataJobSchema) },
    },
  }, async (req, reply) => {
    const job = await vendorTx(req, async (tx, vendorId) => {
      const j = await jobs.createExportJob(tx, vendorId, req.ctx.principal!.actorId, req.body);
      await requestEffects(tx, req).audit({ action: 'product.export_start', resourceType: 'data_job', resourceId: j.id, metadata: req.body });
      return j;
    });
    await enqueue('export', job.vendorId, req.ctx.correlationId, job.id);
    reply.code(202);
    return ok(req, jobs.toJobDto(job));
  });

  r.get('/data-jobs', {
    config: { access: { permission: 'products:read' } },
    schema: {
      tags: TAGS,
      summary: 'List import/export jobs',
      querystring: PaginationQuerySchema.extend({ 'filter[kind]': z.enum(['import', 'export']).optional() }),
      response: { 200: paginatedEnvelope(DataJobSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => jobs.listJobs(tx, vendorId, { limit: q.limit, cursor: q.cursor, kind: q['filter[kind]'] }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/data-jobs/:id', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: TAGS, summary: 'Get a job (status, stats, row errors)', params: IdParamSchema, response: { 200: successEnvelope(DataJobSchema) } },
  }, async (req) => ok(req, jobs.toJobDto(await vendorTx(req, (tx, vendorId) => jobs.getJob(tx, vendorId, req.params.id)))));

  r.get('/data-jobs/:id/download', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: TAGS, summary: 'Download an export file (CSV)', params: IdParamSchema, response: { 200: z.string().describe('text/csv') } },
  }, async (req, reply) => {
    const file = await vendorTx(req, (tx, vendorId) => jobs.readOutput(tx, c, vendorId, req.params.id));
    reply.header('Content-Disposition', `attachment; filename="${file.fileName}"`).type('text/csv; charset=utf-8');
    return file.body.toString('utf8');
  });
};
