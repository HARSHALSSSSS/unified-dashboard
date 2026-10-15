import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, JPEG_BYTES, PNG_1x1, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let staff: Actor;
let viewer: Actor;
let productId: string;
let variantId: string;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
  admin = await c.registerVendor();
  staff = await c.addMember(admin, 'vendor_staff');
  viewer = await c.addMember(admin, 'vendor_viewer');
  const p = (await c.post('/api/v1/products', { productCode: 'DOC-1', title: 'Doc product', variants: [{ sku: 'DOC-1-A' }] }, admin)).body.data;
  productId = p.id;
  variantId = p.variants[0].id;
});
afterAll(() => t.close());

const register = (as: Actor, body: Record<string, unknown>) => c.post(`/api/v1/products/${productId}/documents`, body, as);
const upload = (as: Actor, url: string, raw: Buffer | string, contentType: string, q = '') => c.call('POST', url + q, { as, raw, contentType });

describe('upload flow (api strategy on the memory storage provider)', () => {
  it('registers, uploads, makes the first image primary and serves it back', async () => {
    const reg = await register(staff, { fileName: 'Front View.JPG', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length });
    expect(reg.status).toBe(201);
    const { document, upload: inst } = reg.body.data;
    expect(document).toMatchObject({ status: 'pending_upload', purpose: 'product_image', kind: 'image', fileName: 'Front_View.JPG', downloadUrl: null, isPrimary: false });
    expect(inst).toMatchObject({ strategy: 'api', method: 'POST', url: `/api/v1/documents/${document.id}/upload` });

    const up = await upload(staff, inst.url, JPEG_BYTES, 'image/jpeg');
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ status: 'uploaded', isPrimary: true, sizeBytes: JPEG_BYTES.length });
    expect(up.body.data.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    // stored under the tenant prefix
    const keys = [...t.storage.objects.keys()];
    expect(keys.some((k) => k.startsWith(`vendors/${admin.vendorId}/products/${productId}/${document.id}/`))).toBe(true);

    const content = await c.get(`/api/v1/documents/${document.id}/content`, viewer); // read-only roles can view
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toBe('image/jpeg');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-disposition']).toMatch(/^inline/);
    expect(content.raw.rawPayload.equals(JPEG_BYTES)).toBe(true);

    const list = await c.get(`/api/v1/products/${productId}/documents`, viewer);
    expect(list.body.data[0].downloadUrl).toMatch(/\/api\/v1\/documents\/.+\/content$/);
  });

  it('a second image is not primary until promoted; promoting swaps the flag', async () => {
    const first = (await c.get(`/api/v1/products/${productId}/documents`, admin)).body.data[0];
    const reg = await register(admin, { fileName: 'side.png', mimeType: 'image/png', sizeBytes: PNG_1x1.length });
    await upload(admin, reg.body.data.upload.url, PNG_1x1, 'image/png');
    const second = reg.body.data.document.id;
    expect((await c.get(`/api/v1/documents/${second}`, admin)).body.data.isPrimary).toBe(false);
    const promote = await c.patch(`/api/v1/documents/${second}`, { isPrimary: true, sortOrder: 0 }, admin);
    expect(promote.body.data).toMatchObject({ isPrimary: true, sortOrder: 0 });
    expect((await c.get(`/api/v1/documents/${first.id}`, admin)).body.data.isPrimary).toBe(false);
    const primaries = (await c.get(`/api/v1/products/${productId}/documents`, admin)).body.data.filter((d: any) => d.isPrimary);
    expect(primaries).toHaveLength(1);
  });

  it('supports non-image documents (pdf) and variant-level files', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
    const reg = await register(admin, { fileName: 'care-guide.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length, variantId });
    expect(reg.body.data.document).toMatchObject({ kind: 'document', purpose: 'product_document', variantId });
    const up = await upload(admin, reg.body.data.upload.url, pdf, 'application/pdf');
    expect(up.body.data.isPrimary).toBe(false); // documents never become the primary image
    const dl = await c.get(`/api/v1/documents/${reg.body.data.document.id}/content`, admin);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect((await c.get(`/api/v1/products/${productId}/documents?filter[purpose]=product_document`, admin)).body.data).toHaveLength(1);
  });

  it('deletes the record and the stored object', async () => {
    const reg = await register(admin, { fileName: 'tmp.png', mimeType: 'image/png', sizeBytes: PNG_1x1.length });
    await upload(admin, reg.body.data.upload.url, PNG_1x1, 'image/png');
    const id = reg.body.data.document.id;
    const key = [...t.storage.objects.keys()].find((k) => k.includes(id))!;
    expect(key).toBeTruthy();
    expect((await c.del(`/api/v1/documents/${id}`, admin)).status).toBe(200);
    expect(t.storage.objects.has(key)).toBe(false);
    expect((await c.get(`/api/v1/documents/${id}`, admin)).status).toBe(404);
  });
});

describe('validation and security', () => {
  it('rejects unsupported types, mismatching extensions and oversize declarations', async () => {
    expect((await register(admin, { fileName: 'run.exe', mimeType: 'application/x-msdownload', sizeBytes: 10 })).status).toBe(400); // not in the allow-list
    expect((await register(admin, { fileName: 'a.html', mimeType: 'text/html', sizeBytes: 10 })).status).toBe(400);
    const ext = await register(admin, { fileName: 'photo.png', mimeType: 'image/jpeg', sizeBytes: 10 });
    expect(ext.status).toBe(400);
    expect(ext.body.error.details.issues[0].path).toBe('fileName');
    const big = await register(admin, { fileName: 'huge.jpg', mimeType: 'image/jpeg', sizeBytes: 11 * 1024 * 1024 });
    expect(big.status).toBe(413);
    expect((await register(admin, { fileName: 'huge.pdf', mimeType: 'application/pdf', sizeBytes: 26 * 1024 * 1024 })).status).toBe(400); // above the global document cap (schema)
  });

  it('sniffs content: a file that is not what it claims is rejected and cannot be re-used', async () => {
    const reg = await register(admin, { fileName: 'fake.jpg', mimeType: 'image/jpeg', sizeBytes: 30 });
    const bad = await upload(admin, reg.body.data.upload.url, '<html><script>alert(1)</script></html>', 'image/jpeg');
    expect(bad.status).toBe(415);
    expect((await c.get(`/api/v1/documents/${reg.body.data.document.id}`, admin)).body.data.status).toBe('rejected');
    expect([...t.storage.objects.keys()].some((k) => k.includes(reg.body.data.document.id))).toBe(false);
    expect((await upload(admin, reg.body.data.upload.url, JPEG_BYTES, 'image/jpeg')).status).toBe(409);
  });

  it('requires the Content-Type to equal the declared type, and a non-empty body', async () => {
    const reg = await register(admin, { fileName: 'ct.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length });
    expect((await upload(admin, reg.body.data.upload.url, JPEG_BYTES, 'image/png')).status).toBe(415);
    expect((await upload(admin, reg.body.data.upload.url, '', 'image/jpeg')).status).toBe(400);
    expect((await upload(admin, reg.body.data.upload.url, JPEG_BYTES, 'image/jpeg')).status).toBe(200);
  });

  it('listing documents need a listing; product images cannot be non-images; variants must belong to the product', async () => {
    expect((await register(admin, { fileName: 'l.pdf', mimeType: 'application/pdf', sizeBytes: 10, purpose: 'listing_document' })).status).toBe(400);
    expect((await register(admin, { fileName: 'l.pdf', mimeType: 'application/pdf', sizeBytes: 10, purpose: 'listing_document', listingId: '00000000-0000-7000-8000-000000000000' })).status).toBe(404);
    expect((await register(admin, { fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10, purpose: 'product_image' })).status).toBe(400);
    expect((await register(admin, { fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 10, variantId: '00000000-0000-7000-8000-000000000000' })).status).toBe(404);
  });

  it('path traversal in file names cannot escape the tenant prefix', async () => {
    const reg = await register(admin, { fileName: '../../../etc/passwd.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length });
    expect(reg.status).toBe(201);
    expect(reg.body.data.document.fileName).toBe('passwd.jpg');
    await upload(admin, reg.body.data.upload.url, JPEG_BYTES, 'image/jpeg');
    for (const k of t.storage.objects.keys()) expect(k).toMatch(new RegExp(`^vendors/${admin.vendorId}/`));
  });

  it('enforces RBAC and tenant ownership', async () => {
    expect((await register(viewer, { fileName: 'v.jpg', mimeType: 'image/jpeg', sizeBytes: 10 })).status).toBe(403);
    const reg = await register(admin, { fileName: 'own.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length });
    const stranger = await c.registerVendor();
    expect((await upload(stranger, reg.body.data.upload.url, JPEG_BYTES, 'image/jpeg')).status).toBe(404);
    expect((await c.get(`/api/v1/documents/${reg.body.data.document.id}`, stranger)).status).toBe(404);
    expect((await c.post(`/api/v1/documents/${reg.body.data.document.id}/confirm`, {}, stranger)).status).toBe(404);
  });

  it('caps the number of files per product', async () => {
    const p = (await c.post('/api/v1/products', { productCode: 'DOC-CAP', title: 'Cap product' }, admin)).body.data;
    let last = 0;
    for (let i = 0; i < 51; i++) last = (await c.post(`/api/v1/products/${p.id}/documents`, { fileName: `f${i}.png`, mimeType: 'image/png', sizeBytes: 10 }, admin)).status;
    expect(last).toBe(409);
  });
});
