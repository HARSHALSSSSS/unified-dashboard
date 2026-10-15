import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, JPEG_BYTES, mockControl, type Actor, type TestApp } from '@oms/testing';

/**
 * THE Stage 2 journey, end to end through the real HTTP stack, real migrations, real RLS:
 *   vendor registers -> creates business -> logs in -> adds staff -> creates product -> creates variants/SKU
 *   -> uploads image -> sees product -> creates a marketplace connection using mock/sandbox mode
 */
let t: TestApp;
const api = () => clientFor(t);

beforeAll(async () => { t = await buildTestApp({ database: true }); });
afterAll(() => t.close());

describe('vendor onboarding journey', () => {
  it('registers, verifies, logs in, invites staff, builds a catalogue and connects the sandbox marketplace', async () => {
    const c = api();

    // 1. register (creates the vendor/business + first admin) and check the e-mail
    const reg = await c.post('/api/v1/auth/register', { businessName: 'Acme Apparel', fullName: 'Asha Rao', email: 'asha@acme.test', password: 'correct-horse-battery', gstin: '29ABCDE1234F1Z5' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.vendor).toMatchObject({ displayName: 'Acme Apparel', slug: 'acme-apparel', status: 'active' });
    expect(reg.body.data.user).toMatchObject({ email: 'asha@acme.test', roles: ['vendor_admin'], emailVerified: false });
    const verifyToken = t.mailer.last('verify_email', 'asha@acme.test')!.data.token;
    expect((await c.post('/api/v1/auth/verify-email', { token: verifyToken })).status).toBe(200);

    // 2. log in
    const admin = await c.login('asha@acme.test', 'correct-horse-battery');
    const me = await c.get('/api/v1/me/profile', admin);
    expect(me.body.data.user).toMatchObject({ emailVerified: true, roles: ['vendor_admin'] });

    // 3. business profile + settings
    const vendor = await c.patch('/api/v1/vendor', { phone: '+91 9876543210', pan: 'ABCDE1234F', address: { city: 'Bengaluru', pincode: '560001', country: 'in' } }, admin);
    expect(vendor.status).toBe(200);
    expect(vendor.body.data.address.country).toBe('IN');
    expect((await c.patch('/api/v1/vendor/settings', { lowStockThreshold: 5, notifications: { lowStock: true } }, admin)).body.data).toMatchObject({ lowStockThreshold: 5 });

    // 4. add staff (invite -> accept -> login)
    const staff = await c.addMember(admin, 'vendor_staff', 'priya@acme.test');
    expect((await c.get('/api/v1/users', admin)).body.data.map((u: any) => u.email).sort()).toEqual(['asha@acme.test', 'priya@acme.test']);

    // 5. category + attribute set up by staff (catalogue rights)
    const cat = await c.post('/api/v1/categories', { name: 'T-Shirts' }, staff);
    expect(cat.status).toBe(201);
    const colour = await c.post('/api/v1/attributes', { code: 'color', name: 'Colour', dataType: 'enum', appliesTo: 'variant', values: [{ value: 'black' }, { value: 'white' }] }, staff);
    expect(colour.status).toBe(201);

    // 6. product + variants (SKUs) in one call
    const created = await c.post('/api/v1/products', {
      productCode: 'ACME-TEE', title: 'Acme Classic Tee', brand: 'Acme', categoryId: cat.body.data.id, hsnCode: '6109', gstRateBps: 500, countryOfOrigin: 'in',
      variants: [
        { sku: 'ACME-TEE-BLK-M', barcode: '8901234567890', optionValues: { color: 'Black', size: 'M' }, mrpMinor: 79900, sellingPriceMinor: 59900, weightGrams: 180 },
        { sku: 'ACME-TEE-WHT-M', optionValues: { color: 'White', size: 'M' }, mrpMinor: 79900, sellingPriceMinor: 59900, weightGrams: 180 },
      ],
    }, staff);
    expect(created.status).toBe(201);
    const product = created.body.data;
    expect(product.variants).toHaveLength(2);
    expect(product.status).toBe('draft');

    // 7. upload an image (register -> send bytes), first image becomes the primary one
    const doc = await c.post(`/api/v1/products/${product.id}/documents`, { fileName: 'front.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length }, staff);
    expect(doc.status).toBe(201);
    expect(doc.body.data.upload.strategy).toBe('api');
    const up = await c.call('POST', doc.body.data.upload.url, { as: staff, raw: JPEG_BYTES, contentType: 'image/jpeg' });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ status: 'uploaded', isPrimary: true, sizeBytes: JPEG_BYTES.length });

    // 8. sees the product (list + detail + media + readiness), then activates it
    const list = await c.get('/api/v1/products?q=classic', staff);
    expect(list.body.data.map((p: any) => p.productCode)).toEqual(['ACME-TEE']);
    expect(list.body.data[0].variantCount).toBe(2);
    const media = await c.get(`/api/v1/products/${product.id}/documents`, staff);
    expect(media.body.data).toHaveLength(1);
    const readiness = await c.get(`/api/v1/products/${product.id}/readiness`, staff);
    expect(readiness.body.data.ready).toBe(true);
    expect((await c.patch(`/api/v1/products/${product.id}`, { status: 'active', version: product.version }, staff)).body.data.status).toBe('active');

    // 9. connect a marketplace account in sandbox (mock) mode
    mockControl.reset();
    const acct = await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'Acme on Sandbox' }, admin);
    expect(acct.status).toBe(201);
    expect(acct.body.data).toMatchObject({ status: 'pending_authorization', mode: 'sandbox' });
    const connected = await c.post(`/api/v1/marketplace-accounts/${acct.body.data.id}/authorize`, { credentials: { sellerId: 'ACME-SANDBOX', apiKey: 'sandbox_key' } }, admin);
    expect(connected.status).toBe(200);
    expect(connected.body.data).toMatchObject({ status: 'active', connectionStatus: 'connected', externalAccountId: 'ACME-SANDBOX' });
    expect(JSON.stringify(connected.body)).not.toMatch(/sandbox_key|"accessToken"|"refreshToken"|"credentials"|mock_at_|mock_rt_|ciphertext/i);

    // staff cannot manage connections (RBAC), but can read them
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.body.data.id}/authorize`, { credentials: { sellerId: 'X', apiKey: 'sandbox_k' } }, staff)).status).toBe(403);
    expect((await c.get('/api/v1/marketplace-accounts', staff)).status).toBe(200);

    // the sandbox answers: health, remote profile and catalogue preview
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.body.data.id}/health-check`, {}, admin)).body.data).toMatchObject({ ok: true, connectionStatus: 'connected' });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.body.data.id}/remote-products?limit=5`, admin)).body.data.items).toHaveLength(5);

    // everything above is in the audit trail
    const audit = await c.get('/api/v1/audit-logs?limit=100', admin);
    const actions = audit.body.data.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.register', 'auth.login', 'product.create', 'document.upload', 'marketplace_account.authorize', 'user.invitation_accepted']));
  });
});

describe('actors helper sanity', () => {
  it('registerVendor works without verification and can log in', async () => {
    const a: Actor = await api().registerVendor({ verify: false });
    expect((await api().get('/api/v1/me', a)).body.data.userType).toBe('vendor');
  });
});
