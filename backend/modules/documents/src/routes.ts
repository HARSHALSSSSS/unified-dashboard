import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, created, emit, ok, vendorTx } from '@oms/module-kit';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { AppError } from '@oms/shared';
import * as svc from './service';

const DocumentSchema = z
  .object({
    id: z.string(), productId: z.string(), variantId: z.string().nullable(), listingId: z.string().nullable(),
    kind: z.enum(['image', 'document', 'video']), purpose: z.enum(['product_image', 'product_document', 'listing_document']),
    fileName: z.string(), mimeType: z.string(), sizeBytes: z.number().nullable(), checksumSha256: z.string().nullable(),
    sortOrder: z.number().int(), isPrimary: z.boolean(), status: z.enum(['pending_upload', 'uploaded', 'processed', 'rejected']),
    downloadUrl: z.string().nullable().describe('Short-lived pre-signed URL (or the API content endpoint when the storage provider cannot presign)'),
    createdAt: IsoDate,
  })
  .meta({ id: 'Document' });

const UploadInstructionSchema = z
  .object({ strategy: z.enum(['presigned', 'api']), method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()) })
  .meta({ id: 'DocumentUploadInstruction', description: 'presigned: PUT the bytes to `url` with `headers`, then POST /documents/{id}/confirm. api: POST the raw bytes to `url` on this API (Content-Type must equal the declared mimeType).' });

const CreateBody = z.object({
  fileName: z.string().trim().min(3).max(200).meta({ example: 'front.jpg' }),
  mimeType: z.enum(svc.ALLOWED_MIME as [string, ...string[]]).meta({ example: 'image/jpeg' }),
  sizeBytes: z.number().int().positive().max(svc.MAX_DOCUMENT_BYTES),
  purpose: z.enum(['product_image', 'product_document', 'listing_document']).optional().describe('Defaults from the type: images → product_image, others → product_document'),
  variantId: z.uuid().nullish(),
  listingId: z.uuid().nullish().describe('Required for listing_document'),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
const UpdateBody = z.object({ sortOrder: z.number().int().min(0).max(1000), isPrimary: z.boolean(), fileName: z.string().trim().min(3).max(200) }).partial().refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field' });
const ListQuery = z.object({ 'filter[purpose]': z.enum(['product_image', 'product_document', 'listing_document']).optional(), 'filter[variantId]': z.uuid().optional() });

export const documentRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const TAGS = ['Documents'];

  // raw bytes for the API upload strategy (encapsulated: only these routes accept binary bodies)
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: svc.MAX_DOCUMENT_BYTES + 1024 }, (_req, body, done) => done(null, body));

  r.post('/products/:id/documents', {
    config: { access: { permission: 'documents:write' } },
    schema: {
      tags: TAGS,
      summary: 'Register a product image / document / listing document and get upload instructions',
      description: 'Step 1 of 2. Validates type (jpeg, png, webp, gif, pdf, csv, xlsx, docx), size (images 10 MB, documents 25 MB) and extension, then returns where to send the bytes. The first image of a product becomes its primary image automatically.',
      params: IdParamSchema,
      body: CreateBody,
      response: { 201: successEnvelope(z.object({ document: DocumentSchema, upload: UploadInstructionSchema })) },
    },
  }, async (req, reply) => {
    const out = await vendorTx(req, (tx, vendorId) => svc.createDocument(tx, c, vendorId, req.params.id, req.body));
    return created(req, reply, { document: await svc.toDocumentDto(c, out.row), upload: out.upload }, `/api/v1/documents/${out.row.id}`);
  });

  r.post('/documents/:id/upload', {
    config: { access: { permission: 'documents:write' } },
    schema: {
      tags: TAGS,
      summary: 'Upload the file bytes through the API (step 2, "api" strategy)',
      description: 'Send the raw file as the request body with `Content-Type` equal to the declared mimeType. The content is sniffed: a file that is not really what it claims is rejected. `?primary=true` makes an image the primary one.',
      params: IdParamSchema,
      querystring: z.object({ primary: z.enum(['true', 'false']).optional() }),
      response: { 200: successEnvelope(DocumentSchema) },
    },
  }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the file as the raw request body');
    const body = req.body;
    const outcome = await vendorTx(req, async (tx, vendorId) => {
      const d = await svc.uploadContent(tx, c, vendorId, req.params.id, body, req.headers['content-type'] ?? '', req.query.primary === 'true');
      if (svc.isRejection(d)) return d;
      await audit(tx, req, { action: 'document.upload', resourceType: 'document', resourceId: d.id, after: { productId: d.productId, fileName: d.fileName, sizeBytes: d.sizeBytes } });
      await emit(tx, req, { type: 'document.uploaded', aggregateType: 'document', aggregateId: d.id, payload: { productId: d.productId, kind: d.kind, purpose: d.purpose } });
      return d;
    });
    if (svc.isRejection(outcome)) { throw outcome.rejected; }
    return ok(req, await svc.toDocumentDto(c, outcome));
  });

  r.post('/documents/:id/confirm', {
    config: { access: { permission: 'documents:write' } },
    schema: { tags: TAGS, summary: 'Confirm a direct (presigned) upload (step 2, "presigned" strategy)', description: 'Verifies what actually landed in object storage: size limit and content sniffing. Rejected files are deleted.', params: IdParamSchema, response: { 200: successEnvelope(DocumentSchema) } },
  }, async (req) => {
    const outcome = await vendorTx(req, async (tx, vendorId) => {
      const d = await svc.confirmUpload(tx, c, vendorId, req.params.id);
      if (svc.isRejection(d)) return d;
      if (d.status === 'uploaded') await emit(tx, req, { type: 'document.uploaded', aggregateType: 'document', aggregateId: d.id, payload: { productId: d.productId, kind: d.kind, purpose: d.purpose } });
      return d;
    });
    if (svc.isRejection(outcome)) throw outcome.rejected;
    return ok(req, await svc.toDocumentDto(c, outcome));
  });

  r.get('/products/:id/documents', {
    config: { access: { permission: 'documents:read' } },
    schema: { tags: TAGS, summary: 'List a product\'s images and documents', description: 'Ordered by sortOrder. Includes short-lived download URLs.', params: IdParamSchema, querystring: ListQuery, response: { 200: successEnvelope(z.array(DocumentSchema)) } },
  }, async (req) => {
    const rows = await vendorTx(req, (tx, vendorId) => svc.listDocuments(tx, vendorId, req.params.id, { purpose: req.query['filter[purpose]'], variantId: req.query['filter[variantId]'] }));
    return ok(req, await Promise.all(rows.map((d) => svc.toDocumentDto(c, d))));
  });

  r.get('/documents/:id', {
    config: { access: { permission: 'documents:read' } },
    schema: { tags: TAGS, summary: 'Get a document', params: IdParamSchema, response: { 200: successEnvelope(DocumentSchema) } },
  }, async (req) => ok(req, await svc.toDocumentDto(c, await vendorTx(req, (tx, vendorId) => svc.getDocument(tx, vendorId, req.params.id)))));

  r.get('/documents/:id/content', {
    config: { access: { permission: 'documents:read' } },
    schema: { tags: TAGS, summary: 'Download the file content', description: 'Streams the stored bytes through the API (any storage provider). Images are served inline, everything else as an attachment, always with nosniff.', params: IdParamSchema, response: { 200: z.any().describe('file bytes') } },
  }, async (req, reply) => {
    const { doc, body } = await vendorTx(req, (tx, vendorId) => svc.readContent(tx, c.storage, vendorId, req.params.id));
    const inline = svc.isImage(doc.mimeType);
    return reply
      .header('Content-Type', doc.mimeType)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${doc.fileName}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300')
      .send(body);
  });

  r.patch('/documents/:id', {
    config: { access: { permission: 'documents:write' } },
    schema: { tags: TAGS, summary: 'Reorder, rename or make an image primary', params: IdParamSchema, body: UpdateBody, response: { 200: successEnvelope(DocumentSchema) } },
  }, async (req) => {
    const d = await vendorTx(req, async (tx, vendorId) => {
      const out = await svc.updateDocument(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'document.update', resourceType: 'document', resourceId: out.id, after: req.body });
      return out;
    });
    return ok(req, await svc.toDocumentDto(c, d));
  });

  r.delete('/documents/:id', {
    config: { access: { permission: 'documents:write' } },
    schema: { tags: TAGS, summary: 'Delete a document', description: 'Soft-deletes the record and removes the stored object.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ message: z.string() })) } },
  }, async (req) => {
    const d = await vendorTx(req, async (tx, vendorId) => {
      const out = await svc.deleteDocument(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'document.delete', resourceType: 'document', resourceId: out.id, before: { fileName: out.fileName } });
      await emit(tx, req, { type: 'document.deleted', aggregateType: 'document', aggregateId: out.id, payload: { productId: out.productId } });
      return out;
    });
    await c.storage.delete(d.storageKey).catch((err) => req.log.warn({ err, key: d.storageKey }, 'storage delete failed (object orphaned, will be swept)'));
    return ok(req, { message: 'Document deleted' });
  });
};
