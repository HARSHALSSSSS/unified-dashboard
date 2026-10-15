import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { AppConfig } from '@oms/config';

/**
 * Object storage PORT. Business code (documents, imports/exports, listing documents) depends only on this
 * interface; providers (S3/MinIO/R2, in-memory, future GCS/Azure) are interchangeable via STORAGE_DRIVER.
 *
 * Two upload strategies, chosen by `supportsPresign`:
 *  - presigned: client PUTs straight to storage (API never proxies bytes)
 *  - api:       client POSTs bytes to the API, which calls `put()` (used by providers without presigning, and for small files / dev)
 *
 * Key convention (tenant prefix enforces isolation at the storage layer too):
 *   vendors/<vendorId>/products/<productId>/<documentId>/<filename>
 */
export interface StoredObjectInfo { size: number; contentType: string | null }

export interface ObjectStorage {
  readonly driver: string;
  readonly supportsPresign: boolean;
  presignUpload(input: { key: string; contentType: string; maxBytes?: number; contentLength?: number; expiresInSeconds?: number }): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }>;
  presignDownload(key: string, expiresInSeconds?: number, opts?: { attachmentName?: string }): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<{ size: number; sha256: string }>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  ping(): Promise<void>;
}

export const tenantKey = (vendorId: string, ...parts: string[]): string => `vendors/${vendorId}/${parts.join('/')}`;

/** Guard used by services before signing/reading: the key must live under the caller's tenant prefix. */
export function assertKeyBelongsToVendor(key: string, vendorId: string): void {
  if (!key.startsWith(`vendors/${vendorId}/`) || key.includes('..')) throw new Error('Storage key does not belong to vendor');
}

/** Safe object file name: no path separators, limited charset, bounded length. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-120);
  return cleaned || 'file';
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export class S3Storage implements ObjectStorage {
  readonly driver = 's3';
  readonly supportsPresign = true;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: Pick<AppConfig, 'STORAGE_ENDPOINT' | 'STORAGE_REGION' | 'STORAGE_BUCKET' | 'STORAGE_ACCESS_KEY_ID' | 'STORAGE_SECRET_ACCESS_KEY' | 'STORAGE_FORCE_PATH_STYLE'>) {
    this.bucket = cfg.STORAGE_BUCKET;
    this.client = new S3Client({
      region: cfg.STORAGE_REGION,
      endpoint: cfg.STORAGE_ENDPOINT,
      forcePathStyle: cfg.STORAGE_FORCE_PATH_STYLE,
      ...(cfg.STORAGE_ACCESS_KEY_ID && cfg.STORAGE_SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: cfg.STORAGE_ACCESS_KEY_ID, secretAccessKey: cfg.STORAGE_SECRET_ACCESS_KEY } }
        : {}),
    });
  }

  /** `contentLength` is SIGNED: the storage service refuses a body of any other size (no 5 GB uploads through a 5 MB slot). */
  async presignUpload({ key, contentType, contentLength, expiresInSeconds = 300 }: { key: string; contentType: string; maxBytes?: number; contentLength?: number; expiresInSeconds?: number }) {
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ...(contentLength !== undefined ? { ContentLength: contentLength } : {}) }), { expiresIn: expiresInSeconds });
    return { url, method: 'PUT' as const, headers: { 'Content-Type': contentType } };
  }

  /** Non-image downloads are forced to `attachment` (never rendered in the browser from the storage origin). */
  presignDownload(key: string, expiresInSeconds = 300, opts: { attachmentName?: string } = {}): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(opts.attachmentName ? { ResponseContentDisposition: `attachment; filename="${opts.attachmentName.replace(/[^A-Za-z0-9._-]/g, '_')}"` } : {}) }), { expiresIn: expiresInSeconds });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ChecksumSHA256: createHash('sha256').update(body).digest('base64') }));
    return { size: body.length, sha256: sha256(body) };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

/** In-memory provider: tests and zero-dependency local development (data is lost on restart). No presigning. */
export class MemoryStorage implements ObjectStorage {
  readonly driver = 'memory';
  readonly supportsPresign = false;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async presignUpload(): Promise<never> { throw new Error('memory storage does not support presigned uploads'); }
  async presignDownload(): Promise<never> { throw new Error('memory storage does not support presigned downloads'); }
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { size: body.length, sha256: sha256(body) };
  }
  async get(key: string) { return this.objects.get(key)?.body ?? null; }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }
  async delete(key: string) { this.objects.delete(key); }
  async ping() { /* always healthy */ }
}

export function createStorage(cfg: Pick<AppConfig, 'STORAGE_DRIVER' | 'STORAGE_ENDPOINT' | 'STORAGE_REGION' | 'STORAGE_BUCKET' | 'STORAGE_ACCESS_KEY_ID' | 'STORAGE_SECRET_ACCESS_KEY' | 'STORAGE_FORCE_PATH_STYLE'>): ObjectStorage {
  return cfg.STORAGE_DRIVER === 'memory' ? new MemoryStorage() : new S3Storage(cfg);
}
