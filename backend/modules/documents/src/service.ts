import { and, asc, eq, inArray, isNull, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors, newId } from '@oms/shared';
import { sanitizeFileName, tenantKey, type ObjectStorage } from '@oms/storage';
import type { Container } from '@oms/module-kit';
import { getProductRow } from '@oms/mod-catalog';

export type DocumentRow = typeof schema.productDocuments.$inferSelect;
const D = schema.productDocuments;

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const DOCUMENT_MIME = ['application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
export const ALLOWED_MIME: readonly string[] = [...IMAGE_MIME, ...DOCUMENT_MIME];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCS_PER_PRODUCT = 50;

const EXT: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'], 'application/pdf': ['pdf'], 'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
};

export const isImage = (mime: string): boolean => (IMAGE_MIME as readonly string[]).includes(mime);
export const maxBytesFor = (mime: string): number => (isImage(mime) ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES);

/** Content sniffing: the bytes must match the declared type (a .jpg that is really an executable/HTML is rejected). */
export function sniffMatches(mime: string, b: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif': return b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'));
    case 'image/webp': return b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/pdf': return b.subarray(0, 1024).toString('latin1').includes('%PDF-');
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b; // zip container
    case 'text/csv': return !b.subarray(0, 4096).includes(0); // text: no NUL bytes
    default: return false;
  }
}

export async function toDocumentDto(c: Container, d: DocumentRow) {
  const ready = d.status === 'uploaded' || d.status === 'processed';
  let downloadUrl: string | null = null;
  if (ready) downloadUrl = c.storage.supportsPresign ? await c.storage.presignDownload(d.storageKey, 300, d.mimeType.startsWith('image/') ? {} : { attachmentName: d.fileName }) : `${c.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/v1/documents/${d.id}/content`;
  return {
    id: d.id,
    productId: d.productId,
    variantId: d.variantId,
    listingId: d.listingId,
    kind: d.kind as 'image' | 'document' | 'video',
    purpose: d.purpose as 'product_image' | 'product_document' | 'listing_document',
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    checksumSha256: d.checksumSha256,
    sortOrder: d.sortOrder,
    isPrimary: d.isPrimary,
    status: d.status as 'pending_upload' | 'uploaded' | 'processed' | 'rejected',
    downloadUrl,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function getDocument(tx: Tx, vendorId: string, id: string): Promise<DocumentRow> {
  const [d] = await tx.select().from(D).where(and(eq(D.id, id), eq(D.vendorId, vendorId), isNull(D.deletedAt)));
  if (!d) throw Errors.notFound('Document', id);
  return d;
}

export interface CreateDocumentInput {
  fileName: string; mimeType: string; sizeBytes: number; purpose?: 'product_image' | 'product_document' | 'listing_document';
  variantId?: string | null; listingId?: string | null; sortOrder?: number;
}

export const isRejection = (x: DocumentRow | Rejection): x is Rejection => 'rejected' in x;

export async function createDocument(tx: Tx, c: Container, vendorId: string, productId: string, input: CreateDocumentInput) {
  await getProductRow(tx, vendorId, productId);
  if (!ALLOWED_MIME.includes(input.mimeType)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Unsupported type ${input.mimeType}`, { details: { allowed: ALLOWED_MIME } });
  if (input.sizeBytes > maxBytesFor(input.mimeType)) throw new AppError('PAYLOAD_TOO_LARGE', `Maximum size for ${input.mimeType} is ${maxBytesFor(input.mimeType) / 1024 / 1024} MB`);
  const fileName = sanitizeFileName(input.fileName);
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!(EXT[input.mimeType] ?? []).includes(ext)) throw Errors.validation({ issues: [{ path: 'fileName', message: `extension .${ext} does not match ${input.mimeType}` }] });

  const kind = isImage(input.mimeType) ? 'image' : 'document';
  const purpose = input.purpose ?? (kind === 'image' ? 'product_image' : 'product_document');
  if (purpose === 'product_image' && kind !== 'image') throw Errors.validation({ issues: [{ path: 'purpose', message: 'product_image must be an image' }] });
  if (purpose === 'listing_document') {
    if (!input.listingId) throw Errors.validation({ issues: [{ path: 'listingId', message: 'listing_document needs a listingId' }] });
    const [l] = await tx.select({ id: schema.marketplaceListings.id, variantId: schema.marketplaceListings.variantId }).from(schema.marketplaceListings).where(and(eq(schema.marketplaceListings.id, input.listingId), eq(schema.marketplaceListings.vendorId, vendorId)));
    if (!l) throw Errors.notFound('Listing', input.listingId);
  } else if (input.listingId) throw Errors.validation({ issues: [{ path: 'listingId', message: 'listingId is only for listing_document' }] });
  if (input.variantId) {
    const [v] = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.id, input.variantId), eq(schema.productVariants.productId, productId), eq(schema.productVariants.vendorId, vendorId), isNull(schema.productVariants.deletedAt)));
    if (!v) throw Errors.notFound('Variant', input.variantId);
  }
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(D).where(and(eq(D.vendorId, vendorId), eq(D.productId, productId), isNull(D.deletedAt)));
  if (n >= MAX_DOCS_PER_PRODUCT) throw new AppError('CONFLICT', `A product can have at most ${MAX_DOCS_PER_PRODUCT} files`, { details: { rule: 'max_files' } });

  const id = newId();
  const storageKey = tenantKey(vendorId, 'products', productId, id, fileName);
  const [row] = await tx
    .insert(D)
    .values({ id, vendorId, productId, variantId: input.variantId ?? null, listingId: input.listingId ?? null, kind, purpose, storageKey, fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sortOrder: input.sortOrder ?? n, isPrimary: false, status: 'pending_upload' })
    .returning();
  const upload = c.storage.supportsPresign
    ? { strategy: 'presigned' as const, ...(await c.storage.presignUpload({ key: storageKey, contentType: input.mimeType, maxBytes: maxBytesFor(input.mimeType), contentLength: input.sizeBytes, expiresInSeconds: 600 })) }
    : { strategy: 'api' as const, method: 'POST', url: `/api/v1/documents/${id}/upload`, headers: { 'Content-Type': input.mimeType } };
  return { row: row!, upload };
}

async function makePrimary(tx: Tx, vendorId: string, doc: DocumentRow): Promise<void> {
  await tx.update(D).set({ isPrimary: false }).where(and(eq(D.vendorId, vendorId), eq(D.productId, doc.productId), eq(D.isPrimary, true), isNull(D.deletedAt)));
  await tx.update(D).set({ isPrimary: true }).where(eq(D.id, doc.id));
}

/** Store the bytes (API strategy) and finalise. Verifies declared type == sent type == sniffed content. */
export type Rejection = { rejected: AppError };
/** Rejections are RETURNED (not thrown) so the `rejected` status commits; the route throws after the transaction. */
export async function uploadContent(tx: Tx, c: Container, vendorId: string, id: string, body: Buffer, contentType: string, wantsPrimary: boolean): Promise<DocumentRow | Rejection> {
  const d = await getDocument(tx, vendorId, id);
  if (d.status !== 'pending_upload') throw new AppError('CONFLICT', `Document is ${d.status}; create a new document to upload another file`);
  if (contentType.split(';')[0]!.trim().toLowerCase() !== d.mimeType) throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Content-Type must be ${d.mimeType} (as declared)`);
  if (body.length === 0) throw new AppError('BAD_REQUEST', 'Empty file');
  if (body.length > maxBytesFor(d.mimeType)) throw new AppError('PAYLOAD_TOO_LARGE', `Maximum size is ${maxBytesFor(d.mimeType) / 1024 / 1024} MB`);
  if (!sniffMatches(d.mimeType, body)) {
    await tx.update(D).set({ status: 'rejected' }).where(eq(D.id, id));
    return { rejected: new AppError('UNSUPPORTED_MEDIA_TYPE', 'File content does not match its declared type') };
  }
  const stored = await c.storage.put(d.storageKey, body, d.mimeType);
  return finalize(tx, vendorId, d, stored.size, stored.sha256, wantsPrimary);
}

/** Presigned strategy: the client uploaded straight to storage; verify what actually landed there. */
export async function confirmUpload(tx: Tx, c: Container, vendorId: string, id: string): Promise<DocumentRow | Rejection> {
  const d = await getDocument(tx, vendorId, id);
  if (d.status !== 'pending_upload') return d;
  const head = await c.storage.head(d.storageKey);
  if (!head) throw new AppError('CONFLICT', 'No file found in storage yet; upload first', { details: { rule: 'file_missing' } });
  const reject = async (msg: string, code: 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE'): Promise<Rejection> => {
    await c.storage.delete(d.storageKey).catch(() => undefined);
    await tx.update(D).set({ status: 'rejected' }).where(eq(D.id, id));
    return { rejected: new AppError(code, msg) };
  };
  if (head.size > maxBytesFor(d.mimeType)) return reject('File exceeds the size limit', 'PAYLOAD_TOO_LARGE');
  const bytes = await c.storage.get(d.storageKey);
  if (!bytes || !sniffMatches(d.mimeType, bytes)) return reject('File content does not match its declared type', 'UNSUPPORTED_MEDIA_TYPE');
  const { createHash } = await import('node:crypto');
  return finalize(tx, vendorId, d, bytes.length, createHash('sha256').update(bytes).digest('hex'), false);
}

async function finalize(tx: Tx, vendorId: string, d: DocumentRow, size: number, sha256: string, wantsPrimary: boolean): Promise<DocumentRow> {
  const [after] = await tx.update(D).set({ status: 'uploaded', sizeBytes: size, checksumSha256: sha256 }).where(eq(D.id, d.id)).returning();
  if (d.kind === 'image' && d.purpose === 'product_image') {
    const [hasPrimary] = await tx.select({ id: D.id }).from(D).where(and(eq(D.vendorId, vendorId), eq(D.productId, d.productId), eq(D.isPrimary, true), isNull(D.deletedAt))).limit(1);
    if (wantsPrimary || !hasPrimary) await makePrimary(tx, vendorId, after!); // the first image of a product becomes its primary image
  }
  return (await getDocument(tx, vendorId, d.id));
}

export async function listDocuments(tx: Tx, vendorId: string, productId: string, filter: { purpose?: string; variantId?: string }) {
  await getProductRow(tx, vendorId, productId);
  return tx.select().from(D).where(and(eq(D.vendorId, vendorId), eq(D.productId, productId), isNull(D.deletedAt), filter.purpose ? eq(D.purpose, filter.purpose) : undefined, filter.variantId ? eq(D.variantId, filter.variantId) : undefined)).orderBy(asc(D.sortOrder), asc(D.createdAt), asc(D.id));
}

export async function updateDocument(tx: Tx, vendorId: string, id: string, patch: { sortOrder?: number; isPrimary?: boolean; fileName?: string }) {
  const d = await getDocument(tx, vendorId, id);
  if (patch.isPrimary) {
    if (d.kind !== 'image' || d.status === 'pending_upload' || d.status === 'rejected') throw new AppError('CONFLICT', 'Only uploaded images can be primary');
    await makePrimary(tx, vendorId, d);
  } else if (patch.isPrimary === false && d.isPrimary) {
    await tx.update(D).set({ isPrimary: false }).where(eq(D.id, id));
  }
  const set: Partial<typeof D.$inferInsert> = {};
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  if (patch.fileName !== undefined) set.fileName = sanitizeFileName(patch.fileName); // display name only; the storage key is immutable
  if (Object.keys(set).length) await tx.update(D).set(set).where(eq(D.id, id));
  return getDocument(tx, vendorId, id);
}

export async function deleteDocument(tx: Tx, vendorId: string, id: string) {
  const d = await getDocument(tx, vendorId, id);
  await tx.update(D).set({ deletedAt: new Date(), isPrimary: false }).where(eq(D.id, id));
  return d;
}

export async function readContent(tx: Tx, storage: ObjectStorage, vendorId: string, id: string) {
  const d = await getDocument(tx, vendorId, id);
  if (d.status !== 'uploaded' && d.status !== 'processed') throw new AppError('CONFLICT', 'Document has not been uploaded');
  const body = await storage.get(d.storageKey);
  if (!body) throw Errors.notFound('Stored file', id);
  return { doc: d, body };
}

export async function documentsOfProducts(tx: Tx, vendorId: string, productIds: string[]) {
  if (!productIds.length) return [];
  return tx.select().from(D).where(and(eq(D.vendorId, vendorId), inArray(D.productId, productIds), isNull(D.deletedAt)));
}
