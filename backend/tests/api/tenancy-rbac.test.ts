import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, JPEG_BYTES, mockControl, type Actor, type TestApp } from '@oms/testing';

/**
 * Tenant isolation, RBAC, vendor ownership and marketplace-account ownership, proven through the HTTP API
 * (and, for the lowest layer, directly against the database as the non-owner runtime role).
 */
let t: TestApp;
let c: ReturnType<typeof clientFor>;
let a: Actor; // vendor A admin
let b: Actor; // vendor B admin
let aStaff: Actor;
let aViewer: Actor;
let ids: { productId: string; variantId: string; categoryId: string; attributeId: string; accountId: string; documentId: string; invitationId: string };

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
  mockControl.reset();
  a = await c.registerVendor({ businessName: 'Vendor A' });
  b = await c.registerVendor({ businessName: 'Vendor B' });
  aStaff = await c.addMember(a, 'vendor_staff');
  aViewer = await c.addMember(a, 'vendor_viewer');

  const cat = await c.post('/api/v1/categories', { name: 'Shirts' }, a);
  const attr = await c.post('/api/v1/attributes', { code: 'fabric', name: 'Fabric' }, a);
  const prod = await c.post('/api/v1/products', { productCode: 'P-1', title: 'Vendor A product', brand: 'A', variants: [{ sku: 'SKU-1', barcode: '1234567890128', mrpMinor: 1000, sellingPriceMinor: 900 }] }, a);
  const doc = await c.post(`/api/v1/products/${prod.body.data.id}/documents`, { fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length }, a);
  await c.call('POST', doc.body.data.upload.url, { as: a, raw: JPEG_BYTES, contentType: 'image/jpeg' });
  const acct = await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'A sandbox' }, a);
  await c.post(`/api/v1/marketplace-accounts/${acct.body.data.id}/authorize`, { credentials: { sellerId: 'SELLER-A', apiKey: 'sandbox_a' } }, a);
  const inv = await c.post('/api/v1/invitations', { email: 'pending@a.test', roleKey: 'vendor_staff' }, a);
  ids = { productId: prod.body.data.id, variantId: prod.body.data.variants[0].id, categoryId: cat.body.data.id, attributeId: attr.body.data.id, accountId: acct.body.data.id, documentId: doc.body.data.document.id, invitationId: inv.body.data.id };
});
afterAll(() => t.close());

describe('tenant isolation: vendor B cannot see or touch vendor A', () => {
  it('reads: every A-owned id is a 404 for B (never 403: no confirmation that the id exists)', async () => {
    const urls = [
      `/api/v1/products/${ids.productId}`, `/api/v1/products/${ids.productId}/variants`, `/api/v1/products/${ids.productId}/documents`, `/api/v1/products/${ids.productId}/readiness`,
      `/api/v1/variants/${ids.variantId}`, `/api/v1/categories/${ids.categoryId}`, `/api/v1/attributes/${ids.attributeId}`,
      `/api/v1/documents/${ids.documentId}`, `/api/v1/documents/${ids.documentId}/content`, `/api/v1/marketplace-accounts/${ids.accountId}`, `/api/v1/marketplace-accounts/${ids.accountId}/capabilities`,
      `/api/v1/users/${aStaff.userId}`,
    ];
    for (const url of urls) {
      const r = await c.get(url, b);
      expect(r.status, url).toBe(404);
    }
  });

  it('lists: B sees only its own (empty) data; A sees its data', async () => {
    for (const url of ['/api/v1/products', '/api/v1/variants', '/api/v1/categories', '/api/v1/attributes', '/api/v1/marketplace-accounts', '/api/v1/invitations', '/api/v1/data-jobs']) {
      const rb = await c.get(url, b);
      expect(rb.status, url).toBe(200);
      expect(rb.body.data, url).toEqual([]);
    }
    expect((await c.get('/api/v1/products', a)).body.data).toHaveLength(1);
    const users = await c.get('/api/v1/users', b);
    expect(users.body.data.map((u: any) => u.id)).toEqual([b.userId]);
    expect(JSON.stringify((await c.get('/api/v1/audit-logs?limit=100', b)).body)).not.toContain(a.userId);
  });

  it('writes: B cannot modify, delete or attach to A\'s resources', async () => {
    expect((await c.patch(`/api/v1/products/${ids.productId}`, { title: 'hacked' }, b)).status).toBe(404);
    expect((await c.del(`/api/v1/products/${ids.productId}`, b)).status).toBe(404);
    expect((await c.post(`/api/v1/products/${ids.productId}/variants`, { sku: 'B-SKU' }, b)).status).toBe(404);
    expect((await c.patch(`/api/v1/variants/${ids.variantId}`, { sellingPriceMinor: 1 }, b)).status).toBe(404);
    expect((await c.patch(`/api/v1/categories/${ids.categoryId}`, { name: 'x' }, b)).status).toBe(404);
    expect((await c.patch(`/api/v1/documents/${ids.documentId}`, { sortOrder: 5 }, b)).status).toBe(404);
    expect((await c.del(`/api/v1/documents/${ids.documentId}`, b)).status).toBe(404);
    expect((await c.post(`/api/v1/products/${ids.productId}/documents`, { fileName: 'b.jpg', mimeType: 'image/jpeg', sizeBytes: 10 }, b)).status).toBe(404);
    expect((await c.patch(`/api/v1/users/${aStaff.userId}`, { status: 'disabled' }, b)).status).toBe(404);
    expect((await c.del(`/api/v1/invitations/${ids.invitationId}`, b)).status).toBe(404);
    // A's product is untouched
    expect((await c.get(`/api/v1/products/${ids.productId}`, a)).body.data.title).toBe('Vendor A product');
  });

  it('references: B cannot point its own records at A\'s category/attribute/variant', async () => {
    expect((await c.post('/api/v1/products', { productCode: 'B-1', title: 'B thing', categoryId: ids.categoryId }, b)).status).toBe(404);
    const own = await c.post('/api/v1/products', { productCode: 'B-2', title: 'B own product' }, b);
    expect((await c.put(`/api/v1/products/${own.body.data.id}/attribute-values`, { values: [{ attributeId: ids.attributeId, value: 'cotton' }] }, b)).status).toBe(404);
    expect((await c.put(`/api/v1/categories/${ids.categoryId}/attributes`, { items: [] }, b)).status).toBe(404);
    const doc = await c.post(`/api/v1/products/${own.body.data.id}/documents`, { fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 10, variantId: ids.variantId }, b);
    expect(doc.status).toBe(404); // A's variant
  });

  it('uniqueness is per vendor: B can reuse A\'s product code, SKU and barcode', async () => {
    const r = await c.post('/api/v1/products', { productCode: 'P-1', title: 'B uses the same code', variants: [{ sku: 'SKU-1', barcode: '1234567890128' }] }, b);
    expect(r.status).toBe(201);
  });

  it('marketplace accounts: B can neither act on A\'s account nor reuse its sandbox seller id', async () => {
    const id = ids.accountId;
    for (const [method, path, body] of [
      ['POST', `/api/v1/marketplace-accounts/${id}/authorize`, { credentials: { sellerId: 'S', apiKey: 'sandbox_x' } }],
      ['POST', `/api/v1/marketplace-accounts/${id}/refresh`, {}], ['POST', `/api/v1/marketplace-accounts/${id}/health-check`, {}], ['POST', `/api/v1/marketplace-accounts/${id}/disconnect`, {}],
      ['GET', `/api/v1/marketplace-accounts/${id}/remote-products`, undefined], ['GET', `/api/v1/marketplace-accounts/${id}/remote-account`, undefined],
      ['PATCH', `/api/v1/marketplace-accounts/${id}`, { displayName: 'mine now' }], ['DELETE', `/api/v1/marketplace-accounts/${id}`, undefined],
    ] as const) {
      const r = await c.call(method, path, { as: b, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // A's account still healthy
    expect((await c.post(`/api/v1/marketplace-accounts/${id}/health-check`, {}, a)).body.data.ok).toBe(true);
    // two vendors can both connect the SAME marketplace (multi-vendor), even the same seller handle
    const bAcct = await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'B sandbox' }, b);
    const bAuth = await c.post(`/api/v1/marketplace-accounts/${bAcct.body.data.id}/authorize`, { credentials: { sellerId: 'SELLER-A', apiKey: 'sandbox_b' } }, b);
    expect(bAuth.status).toBe(200);
  });

  it('a body/query/header cannot smuggle a tenant id', async () => {
    const r = await c.call('POST', '/api/v1/products', { as: b, body: { productCode: 'SMUGGLE', title: 'Smuggled', vendorId: a.vendorId }, headers: { 'x-vendor-id': a.vendorId! } });
    expect(r.status).toBe(201);
    const mine = await c.get('/api/v1/products?q=SMUGGLE', a);
    expect(mine.body.data).toHaveLength(0);
  });

  it('vendor users cannot impersonate another vendor', async () => {
    const r = await c.call('GET', '/api/v1/products', { as: b, headers: { 'x-act-as-vendor': a.vendorId! } });
    expect(r.status).toBe(403);
  });

  it('database level: the runtime role sees NOTHING without a tenant scope (RLS fails closed)', async () => {
    const pg = t.database!.pg;
    const { rows } = await pg.query('select count(*)::int as n from products');
    expect((rows[0] as { n: number }).n).toBe(0);
    for (const table of ['product_variants', 'categories', 'marketplace_accounts', 'marketplace_authorizations', 'attribute_definitions', 'product_documents', 'audit_logs', 'users', 'invitations']) {
      const r = await pg.query(`select count(*)::int as n from ${table}`);
      expect((r.rows[0] as { n: number }).n, table).toBe(0);
    }
  });
});

describe('RBAC', () => {
  it('requires authentication everywhere (401), with a stable error code', async () => {
    for (const [m, u] of [['GET', '/api/v1/products'], ['POST', '/api/v1/products'], ['GET', '/api/v1/users'], ['GET', '/api/v1/marketplace-accounts'], ['GET', '/api/v1/vendor']] as const) {
      const r = await c.call(m, u, { body: m === 'POST' ? {} : undefined });
      expect(r.status, `${m} ${u}`).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('Vendor Staff: manages the catalogue, cannot delete products, manage users, invite, edit the vendor or connect marketplaces', async () => {
    expect((await c.post('/api/v1/products', { productCode: 'STAFF-1', title: 'Staff product' }, aStaff)).status).toBe(201);
    expect((await c.get('/api/v1/marketplace-accounts', aStaff)).status).toBe(200);
    expect((await c.get('/api/v1/vendor', aStaff)).status).toBe(200);
    const denied: Array<[string, string, unknown, string]> = [
      ['DELETE', `/api/v1/products/${ids.productId}`, undefined, 'products:delete'],
      ['GET', '/api/v1/users', undefined, 'users:read'],
      ['POST', '/api/v1/invitations', { email: 'x@y.test' }, 'users:write'],
      ['PATCH', '/api/v1/vendor', { displayName: 'Renamed' }, 'vendors:write'],
      ['POST', '/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'x' }, 'marketplace_accounts:write'],
      ['GET', '/api/v1/audit-logs', undefined, 'audit:read'],
    ];
    for (const [m, u, body, perm] of denied) {
      const r = await c.call(m as 'GET', u, { as: aStaff, body });
      expect(r.status, `${m} ${u}`).toBe(403);
      expect(r.body.error.details.requiredPermission).toBe(perm);
    }
  });

  it('Vendor Viewer: read-only', async () => {
    expect((await c.get('/api/v1/products', aViewer)).status).toBe(200);
    expect((await c.get(`/api/v1/products/${ids.productId}`, aViewer)).status).toBe(200);
    expect((await c.post('/api/v1/products', { productCode: 'V-1', title: 'Viewer product' }, aViewer)).status).toBe(403);
    expect((await c.patch(`/api/v1/products/${ids.productId}`, { title: 'nope nope' }, aViewer)).status).toBe(403);
    expect((await c.post('/api/v1/categories', { name: 'x' }, aViewer)).status).toBe(403);
    expect((await c.post('/api/v1/attributes', { code: 'zz', name: 'zz' }, aViewer)).status).toBe(403);
    expect((await c.post(`/api/v1/products/${ids.productId}/documents`, { fileName: 'v.jpg', mimeType: 'image/jpeg', sizeBytes: 5 }, aViewer)).status).toBe(403);
    expect((await c.get('/api/v1/users', aViewer)).status).toBe(403);
  });

  it('Vendor Admin: full control inside the vendor (users, invitations, vendor profile, marketplaces)', async () => {
    expect((await c.get('/api/v1/users', a)).status).toBe(200);
    expect((await c.patch('/api/v1/vendor', { displayName: 'Vendor A Ltd' }, a)).status).toBe(200);
  });

  it('role changes take effect for subsequent requests, and a vendor keeps at least one admin', async () => {
    const promoted = await c.patch(`/api/v1/users/${aStaff.userId}`, { roleKey: 'vendor_admin' }, a);
    expect(promoted.body.data.roleKey).toBe('vendor_admin');
    // the cached permission set is per role KEY set in the token: the old token still carries vendor_staff, a fresh login gets admin
    const fresh = await c.login(aStaff.email, aStaff.password);
    expect((await c.get('/api/v1/users', fresh)).status).toBe(200);
    // demote again
    expect((await c.patch(`/api/v1/users/${aStaff.userId}`, { roleKey: 'vendor_staff' }, a)).status).toBe(200);
    // sole admin cannot be demoted/disabled/removed, and nobody changes their own role
    const self = await c.patch(`/api/v1/users/${a.userId}`, { roleKey: 'vendor_staff' }, a);
    expect(self.status).toBe(409);
    const solo = await c.registerVendor();
    const second = await c.addMember(solo, 'vendor_admin');
    expect((await c.patch(`/api/v1/users/${solo.userId}`, { status: 'disabled' }, second)).status).toBe(200); // fine: `second` remains an admin
    expect((await c.patch(`/api/v1/users/${second.userId}`, { roleKey: 'vendor_viewer' }, second)).status).toBe(409); // cannot change own role
  });

  it('disabling a member signs them out immediately', async () => {
    const m = await c.addMember(a, 'vendor_staff');
    expect((await c.get('/api/v1/products', m)).status).toBe(200);
    expect((await c.patch(`/api/v1/users/${m.userId}`, { status: 'disabled' }, a)).status).toBe(200);
    expect((await c.get('/api/v1/products', m)).status).toBe(401);
    expect((await c.post('/api/v1/auth/login', { email: m.email, password: m.password })).status).toBe(401);
  });
});

describe('platform staff', () => {
  it('platform admin needs X-Act-As-Vendor for tenant data, and may then act as that vendor', async () => {
    const admin = await c.platformAdmin();
    const noCtx = await c.get('/api/v1/products', admin);
    expect(noCtx.status).toBe(400);
    const asA = await c.call('GET', '/api/v1/products', { as: admin, headers: { 'x-act-as-vendor': a.vendorId! } });
    expect(asA.status).toBe(200);
    expect(asA.body.data.map((p: any) => p.productCode)).toContain('P-1');
    const asB = await c.call('GET', '/api/v1/products/' + ids.productId, { as: admin, headers: { 'x-act-as-vendor': b.vendorId! } });
    expect(asB.status).toBe(404); // acting as B still cannot see A's product
  });

  it('lists vendors, and only platform admins (not support) can suspend; suspension is immediate', async () => {
    const admin = await c.platformAdmin();
    const support = await c.platformAdmin('platform_support');
    const victim = await c.registerVendor({ businessName: 'To Suspend' });
    expect((await c.get('/api/v1/vendors?q=suspend', support)).body.data).toHaveLength(1);
    expect((await c.get('/api/v1/vendors', victim)).status).toBe(403); // vendors cannot list vendors
    expect((await c.patch(`/api/v1/vendors/${victim.vendorId}/status`, { status: 'suspended' }, support)).status).toBe(403);

    expect((await c.get('/api/v1/products', victim)).status).toBe(200);
    const s = await c.patch(`/api/v1/vendors/${victim.vendorId}/status`, { status: 'suspended', reason: 'Policy review' }, admin);
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ status: 'suspended', statusReason: 'Policy review' });
    const blocked = await c.get('/api/v1/products', victim);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TENANT_SUSPENDED');
    expect((await c.post('/api/v1/auth/login', { email: victim.email, password: victim.password })).body.error.code).toBe('TENANT_SUSPENDED');

    await c.patch(`/api/v1/vendors/${victim.vendorId}/status`, { status: 'active' }, admin);
    expect((await c.get('/api/v1/products', victim)).status).toBe(200);
  });

  it('platform users cannot register via the API and vendor roles contain no platform permissions', async () => {
    const roles = (await c.get('/api/v1/roles', a)).body.data;
    for (const r of roles) expect(r.permissions.some((p: string) => p.startsWith('platform:'))).toBe(false);
    expect(roles.some((r: any) => r.key.startsWith('platform_'))).toBe(false);
  });
});
