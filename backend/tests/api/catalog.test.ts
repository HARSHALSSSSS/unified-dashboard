import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, JPEG_BYTES, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let staff: Actor;

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
  admin = await c.registerVendor({ businessName: 'Catalog Co' });
  staff = await c.addMember(admin, 'vendor_staff');
});
afterAll(() => t.close());

const product = (code: string, extra: Record<string, unknown> = {}) => ({ productCode: code, title: `Product ${code}`, brand: 'Acme', ...extra });

describe('product CRUD', () => {
  it('creates, reads, updates partially (untouched fields survive), archives and deletes', async () => {
    const r = await c.post('/api/v1/products', product('CRUD-1', { description: 'A fine product for testing', tags: ['a', 'b'], hsnCode: '6109', gstRateBps: 1200 }), admin);
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/api/v1/products/${r.body.data.id}`);
    const p = r.body.data;
    expect(p).toMatchObject({ productCode: 'CRUD-1', status: 'draft', tags: ['a', 'b'], hsnCode: '6109', gstRateBps: 1200, version: 1, variantCount: 0 });

    // PATCH only the title: tags/status/brand must not be reset by schema defaults
    const upd = await c.patch(`/api/v1/products/${p.id}`, { title: 'Renamed product' }, admin);
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ title: 'Renamed product', tags: ['a', 'b'], brand: 'Acme', status: 'draft', gstRateBps: 1200, version: 2 });

    // clearing a nullable field with null
    expect((await c.patch(`/api/v1/products/${p.id}`, { description: null }, admin)).body.data.description).toBeNull();

    // archive is reversible; delete is not
    expect((await c.patch(`/api/v1/products/${p.id}`, { status: 'archived' }, admin)).body.data.status).toBe('archived');
    expect((await c.patch(`/api/v1/products/${p.id}`, { status: 'draft' }, admin)).body.data.status).toBe('draft');
    expect((await c.del(`/api/v1/products/${p.id}`, admin)).status).toBe(200);
    expect((await c.get(`/api/v1/products/${p.id}`, admin)).status).toBe(404);
    expect((await c.get('/api/v1/products?q=CRUD-1', admin)).body.data).toHaveLength(0);
    // the product code can be reused after deletion
    expect((await c.post('/api/v1/products', product('CRUD-1'), admin)).status).toBe(201);
  });

  it('validates input (title length, GST rate, HSN, country, unknown fields are ignored)', async () => {
    const bad = await c.post('/api/v1/products', { productCode: 'bad code!', title: 'x', gstRateBps: 99999, hsnCode: 'abc', countryOfOrigin: 'India' }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path).sort()).toEqual(['countryOfOrigin', 'gstRateBps', 'hsnCode', 'productCode', 'title']);
  });

  it('optimistic locking: a stale version is rejected with 409 VERSION_CONFLICT', async () => {
    const p = (await c.post('/api/v1/products', product('LOCK-1'), admin)).body.data;
    expect((await c.patch(`/api/v1/products/${p.id}`, { title: 'First editor wins', version: 1 }, admin)).status).toBe(200);
    const stale = await c.patch(`/api/v1/products/${p.id}`, { title: 'Second editor loses', version: 1 }, admin);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
  });

  it('activation needs an active variant; deactivating the last variant of an active product is refused', async () => {
    const p = (await c.post('/api/v1/products', product('ACT-1'), admin)).body.data;
    const noVariant = await c.patch(`/api/v1/products/${p.id}`, { status: 'active' }, admin);
    expect(noVariant.status).toBe(409);
    expect(noVariant.body.error.details.rule).toBe('needs_variant');
    const v = await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'ACT-1-A' }, admin);
    expect((await c.patch(`/api/v1/products/${p.id}`, { status: 'active' }, admin)).status).toBe(200);
    expect((await c.del(`/api/v1/variants/${v.body.data.id}`, admin)).status).toBe(409);
    const second = await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'ACT-1-B' }, admin);
    expect((await c.del(`/api/v1/variants/${v.body.data.id}`, admin)).status).toBe(200);
    expect((await c.del(`/api/v1/variants/${second.body.data.id}`, admin)).status).toBe(409);
  });

  it('only users with products:delete can delete; staff can create and archive', async () => {
    const p = (await c.post('/api/v1/products', product('DEL-1'), staff)).body.data;
    expect((await c.del(`/api/v1/products/${p.id}`, staff)).status).toBe(403);
    expect((await c.patch(`/api/v1/products/${p.id}`, { status: 'archived' }, staff)).status).toBe(200);
  });
});

describe('variants / SKU', () => {
  it('SKU is unique per vendor (409 with the offending field), also across products and after case differences', async () => {
    const p1 = (await c.post('/api/v1/products', product('SKU-P1', { variants: [{ sku: 'UNIQ-1' }] }), admin)).body.data;
    const p2 = (await c.post('/api/v1/products', product('SKU-P2'), admin)).body.data;
    const dup = await c.post(`/api/v1/products/${p2.id}/variants`, { sku: 'UNIQ-1' }, admin);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'CONFLICT', message: 'sku already exists', details: { field: 'sku' } });
    // same SKU twice in one create request
    const twice = await c.post('/api/v1/products', product('SKU-P3', { variants: [{ sku: 'TWICE' }, { sku: 'TWICE' }] }), admin);
    expect(twice.status).toBe(400);
    // the failed create left nothing behind (atomic)
    expect((await c.get('/api/v1/products?q=SKU-P3', admin)).body.data).toHaveLength(0);
    // a deleted variant frees its SKU
    expect((await c.del(`/api/v1/variants/${p1.variants[0].id}`, admin)).status).toBe(200);
    expect((await c.post(`/api/v1/products/${p2.id}/variants`, { sku: 'UNIQ-1' }, admin)).status).toBe(201);
  });

  it('barcode is unique per vendor; duplicate product code is a 409 with field productCode', async () => {
    const p = (await c.post('/api/v1/products', product('BC-1'), admin)).body.data;
    expect((await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'BC-A', barcode: '4006381333931' }, admin)).status).toBe(201);
    const dup = await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'BC-B', barcode: '4006381333931' }, admin);
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('barcode');
    const code = await c.post('/api/v1/products', product('BC-1'), admin);
    expect(code.status).toBe(409);
    expect(code.body.error.details.field).toBe('productCode');
  });

  it('validates prices, tax, dimensions and weight; selling price cannot exceed MRP', async () => {
    const p = (await c.post('/api/v1/products', product('VAL-1'), admin)).body.data;
    const bad = await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'VAL-A', mrpMinor: 1000, sellingPriceMinor: 2000 }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('sellingPriceMinor');
    expect((await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'VAL-B', mrpMinor: 10.5 }, admin)).status).toBe(400); // money is integer minor units
    expect((await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'VAL-C', weightGrams: -5 }, admin)).status).toBe(400);
    const ok = await c.post(`/api/v1/products/${p.id}/variants`, { sku: 'VAL-D', mrpMinor: 1000, sellingPriceMinor: 900, costPriceMinor: 500, taxRateBps: 1800, weightGrams: 250, dimensionsMm: { length: 300, width: 200, height: 20 }, optionValues: { size: 'L' } }, admin);
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ currency: 'INR', dimensionsMm: { length: 300, width: 200, height: 20 }, taxRateBps: 1800, status: 'active' });
    // patching the price relative to the stored MRP is validated too
    expect((await c.patch(`/api/v1/variants/${ok.body.data.id}`, { sellingPriceMinor: 5000 }, admin)).status).toBe(400);
    const upd = await c.patch(`/api/v1/variants/${ok.body.data.id}`, { sellingPriceMinor: 800 }, admin);
    expect(upd.body.data).toMatchObject({ sellingPriceMinor: 800, mrpMinor: 1000, optionValues: { size: 'L' }, currency: 'INR', version: 2 });
  });

  it('looks variants up by exact SKU / barcode and free text, with the parent product attached', async () => {
    const p = (await c.post('/api/v1/products', product('LOOK-1', { title: 'Lookup Jacket', variants: [{ sku: 'LOOK-1-RED', barcode: '9780201379624' }] }), admin)).body.data;
    const bySku = await c.get('/api/v1/variants?sku=LOOK-1-RED', admin);
    expect(bySku.body.data).toHaveLength(1);
    expect(bySku.body.data[0]).toMatchObject({ productId: p.id, productCode: 'LOOK-1', productTitle: 'Lookup Jacket' });
    expect((await c.get('/api/v1/variants?barcode=9780201379624', admin)).body.data).toHaveLength(1);
    expect((await c.get('/api/v1/variants?q=jacket', admin)).body.data.length).toBeGreaterThanOrEqual(1);
    expect((await c.get('/api/v1/variants?sku=NOPE', admin)).body.data).toHaveLength(0);
  });
});

describe('search, filter, sort, pagination', () => {
  let cat: string;
  beforeAll(async () => {
    cat = (await c.post('/api/v1/categories', { name: 'List Cat' }, admin)).body.data.id;
    const brands = ['Zeta', 'Alpha', 'Mid'];
    for (let i = 1; i <= 7; i++) {
      await c.post('/api/v1/products', { productCode: `LST-${i}`, title: `List item ${String.fromCharCode(96 + i)}`, brand: brands[i % 3], categoryId: i <= 4 ? cat : null, variants: [{ sku: `LST-${i}-SKU`, barcode: `55500000000${i}` }], status: i % 2 ? 'active' : 'draft' }, admin);
    }
  });

  it('walks every page exactly once with keyset pagination (no duplicates, no gaps)', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await c.get(`/api/v1/products?q=List item&limit=3&sort=title${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, admin);
      expect(r.status).toBe(200);
      seen.push(...r.body.data.map((p: any) => p.productCode));
      cursor = r.body.meta.nextCursor;
      expect(r.body.meta.hasMore).toBe(cursor !== null);
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(['LST-1', 'LST-2', 'LST-3', 'LST-4', 'LST-5', 'LST-6', 'LST-7']);
  });

  it('sorts descending and ascending by several fields', async () => {
    const desc = await c.get('/api/v1/products?q=LST-&sort=-productCode&limit=100', admin);
    expect(desc.body.data.map((p: any) => p.productCode)).toEqual(['LST-7', 'LST-6', 'LST-5', 'LST-4', 'LST-3', 'LST-2', 'LST-1']);
    const newest = await c.get('/api/v1/products?q=LST-&limit=100', admin); // default: -createdAt
    expect(newest.body.data[0].productCode).toBe('LST-7');
    expect((await c.get('/api/v1/products?sort=bogus', admin)).status).toBe(400);
  });

  it('rejects a cursor used with a different sort, and malformed cursors', async () => {
    const first = await c.get('/api/v1/products?q=LST-&limit=2&sort=title', admin);
    const mismatch = await c.get(`/api/v1/products?q=LST-&limit=2&sort=-title&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`, admin);
    expect(mismatch.status).toBe(400);
    expect((await c.get('/api/v1/products?cursor=garbage', admin)).status).toBe(400);
  });

  it('filters by status, category, brand and date range', async () => {
    const active = await c.get('/api/v1/products?q=LST-&filter[status]=active&limit=100', admin);
    expect(active.body.data.map((p: any) => p.productCode).sort()).toEqual(['LST-1', 'LST-3', 'LST-5', 'LST-7']);
    const inCat = await c.get(`/api/v1/products?filter[categoryId]=${cat}&limit=100`, admin);
    expect(inCat.body.data).toHaveLength(4);
    expect((await c.get('/api/v1/products?q=LST-&filter[brand]=alpha&limit=100', admin)).body.data.length).toBeGreaterThan(0);
    expect((await c.get('/api/v1/products?q=LST-&filter[createdFrom]=2999-01-01T00:00:00Z', admin)).body.data).toHaveLength(0);
    expect((await c.get('/api/v1/products?q=LST-&filter[createdTo]=2999-01-01T00:00:00Z&limit=100', admin)).body.data).toHaveLength(7);
  });

  it('searches code, brand, title, and variant SKU/barcode; wildcards in the query are literal', async () => {
    expect((await c.get('/api/v1/products?q=LST-3-SKU', admin)).body.data.map((p: any) => p.productCode)).toEqual(['LST-3']);
    expect((await c.get('/api/v1/products?q=555000000005', admin)).body.data.map((p: any) => p.productCode)).toEqual(['LST-5']);
    expect((await c.get('/api/v1/products?q=%25', admin)).body.data).toHaveLength(0); // "%" must not match everything
    expect((await c.get('/api/v1/products?q=_', admin)).body.data).toHaveLength(0);
  });

  it('caps the page size', async () => {
    expect((await c.get('/api/v1/products?limit=1000', admin)).status).toBe(400);
    expect((await c.get('/api/v1/products?limit=0', admin)).status).toBe(400);
  });
});

describe('bulk operations', () => {
  it('create: partial success, failures are isolated (savepoints) and reported per item', async () => {
    await c.post('/api/v1/products', product('BULK-EXIST', { variants: [{ sku: 'BULK-EXIST-1' }] }), admin);
    const r = await c.post('/api/v1/products/bulk', {
      action: 'create',
      items: [
        product('BULK-1', { variants: [{ sku: 'BULK-1-A' }] }),
        product('BULK-EXIST'), // duplicate code
        product('BULK-3', { variants: [{ sku: 'BULK-EXIST-1' }] }), // duplicate SKU: product insert must roll back too
        product('BULK-4'),
      ],
    }, admin);
    expect(r.status).toBe(200);
    expect(r.body.data.summary).toEqual({ total: 4, succeeded: 2, failed: 2 });
    expect(r.body.data.results.map((x: any) => x.ok)).toEqual([true, false, false, true]);
    expect(r.body.data.results[1].error.code).toBe('CONFLICT');
    expect((await c.get('/api/v1/products?q=BULK-3', admin)).body.data).toHaveLength(0); // rolled back
    expect((await c.get('/api/v1/products?q=BULK-4', admin)).body.data).toHaveLength(1);
  });

  it('update_status and delete: per item, honour permissions and ownership', async () => {
    const ids = (await Promise.all(['BS-1', 'BS-2', 'BS-3'].map((code) => c.post('/api/v1/products', product(code), admin)))).map((r) => r.body.data.id);
    const other = await c.registerVendor();
    const foreign = (await c.post('/api/v1/products', product('FOREIGN'), other)).body.data.id;

    const archive = await c.post('/api/v1/products/bulk', { action: 'update_status', ids: [...ids, foreign], status: 'archived' }, admin);
    expect(archive.body.data.summary).toEqual({ total: 4, succeeded: 3, failed: 1 });
    expect(archive.body.data.results[3].error.code).toBe('NOT_FOUND'); // another vendor's product is simply not found
    expect((await c.get(`/api/v1/products/${foreign}`, other)).body.data.status).toBe('draft');

    expect((await c.post('/api/v1/products/bulk', { action: 'delete', ids }, staff)).status).toBe(403);
    const del = await c.post('/api/v1/products/bulk', { action: 'delete', ids }, admin);
    expect(del.body.data.summary.succeeded).toBe(3);
  });

  it('enforces size limits', async () => {
    expect((await c.post('/api/v1/products/bulk', { action: 'create', items: [] }, admin)).status).toBe(400);
    expect((await c.post('/api/v1/products/bulk', { action: 'update_status', ids: ['not-a-uuid'], status: 'active' }, admin)).status).toBe(400);
  });
});

describe('categories', () => {
  it('builds a tree with materialised paths, moves subtrees and protects non-empty categories', async () => {
    const root = (await c.post('/api/v1/categories', { name: 'Apparel' }, admin)).body.data;
    const men = (await c.post('/api/v1/categories', { name: 'Men', parentId: root.id }, admin)).body.data;
    const shirts = (await c.post('/api/v1/categories', { name: 'Shirts', parentId: men.id }, admin)).body.data;
    expect(shirts.path).toBe('apparel/men/shirts');
    const tree = (await c.get('/api/v1/categories/tree', admin)).body.data;
    const apparel = tree.find((n: any) => n.slug === 'apparel');
    expect(apparel.children[0].children[0].slug).toBe('shirts');

    // rename the root: every descendant path follows
    expect((await c.patch(`/api/v1/categories/${root.id}`, { slug: 'clothing' }, admin)).status).toBe(200);
    expect((await c.get(`/api/v1/categories/${shirts.id}`, admin)).body.data.path).toBe('clothing/men/shirts');
    // cannot move under own descendant / be own parent
    expect((await c.patch(`/api/v1/categories/${root.id}`, { parentId: shirts.id }, admin)).status).toBe(409);
    expect((await c.patch(`/api/v1/categories/${root.id}`, { parentId: root.id }, admin)).status).toBe(409);
    // cannot delete with children or products
    expect((await c.del(`/api/v1/categories/${men.id}`, admin)).status).toBe(409);
    await c.post('/api/v1/products', product('IN-SHIRTS', { categoryId: shirts.id }), admin);
    const blocked = await c.del(`/api/v1/categories/${shirts.id}`, admin);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.rule).toBe('has_products');
    // duplicate slug
    expect((await c.post('/api/v1/categories', { name: 'Clothing' }, admin)).status).toBe(409);
    // filter by parent
    expect((await c.get(`/api/v1/categories?filter[parentId]=${root.id}`, admin)).body.data.map((x: any) => x.slug)).toEqual(['men']);
    expect((await c.get('/api/v1/categories?filter[parentId]=root&limit=100', admin)).body.data.every((x: any) => x.parentId === null)).toBe(true);
  });
});

describe('generic attributes (marketplace-neutral)', () => {
  it('validates typed values, enum membership and variant scope; clears with null', async () => {
    const color = (await c.post('/api/v1/attributes', { code: 'colour', name: 'Colour', dataType: 'enum', appliesTo: 'variant', values: [{ value: 'red', label: 'Red' }, { value: 'blue' }] }, admin)).body.data;
    const gsm = (await c.post('/api/v1/attributes', { code: 'gsm', name: 'Fabric weight', dataType: 'number', unit: 'g/m2' }, admin)).body.data;
    const organic = (await c.post('/api/v1/attributes', { code: 'organic', name: 'Organic', dataType: 'boolean' }, admin)).body.data;
    const made = (await c.post('/api/v1/attributes', { code: 'made_on', name: 'Made on', dataType: 'date' }, admin)).body.data;
    expect((await c.post('/api/v1/attributes', { code: 'colour', name: 'dup' }, admin)).status).toBe(409);
    expect((await c.post('/api/v1/attributes', { code: 'Bad Code', name: 'x' }, admin)).status).toBe(400);
    expect((await c.post('/api/v1/attributes', { code: 'texty', name: 'x', values: [{ value: 'a' }] }, admin)).status).toBe(400); // values only for enums

    const p = (await c.post('/api/v1/products', product('ATTR-1', { variants: [{ sku: 'ATTR-1-A' }] }), admin)).body.data;
    const variantId = p.variants[0].id;
    const set = await c.put(`/api/v1/products/${p.id}/attribute-values`, { values: [
      { attributeId: gsm.id, value: 180 }, { attributeId: organic.id, value: true }, { attributeId: made.id, value: '2025-03-01' }, { attributeId: color.id, variantId, value: 'red' },
    ] }, admin);
    expect(set.status).toBe(200);
    expect(set.body.data.find((v: any) => v.code === 'gsm').value).toBe(180);
    expect(set.body.data.find((v: any) => v.code === 'colour')).toMatchObject({ value: 'red', variantId });

    const bad = async (values: unknown) => (await c.put(`/api/v1/products/${p.id}/attribute-values`, { values }, admin)).status;
    expect(await bad([{ attributeId: color.id, variantId, value: 'green' }])).toBe(400); // not an allowed value
    expect(await bad([{ attributeId: color.id, value: 'red' }])).toBe(400); // variant attribute needs variantId
    expect(await bad([{ attributeId: gsm.id, variantId, value: 1 }])).toBe(400); // product attribute must not have variantId
    expect(await bad([{ attributeId: gsm.id, value: 'heavy' }])).toBe(400);
    expect(await bad([{ attributeId: organic.id, value: 'yes' }])).toBe(400);
    expect(await bad([{ attributeId: made.id, value: '01/03/2025' }])).toBe(400);

    // in-use values/attributes are protected; clearing frees them
    const redValue = color.values.find((v: any) => v.value === 'red').id;
    expect((await c.del(`/api/v1/attributes/${color.id}/values/${redValue}`, admin)).status).toBe(409);
    expect((await c.del(`/api/v1/attributes/${gsm.id}`, admin)).status).toBe(409);
    await c.put(`/api/v1/products/${p.id}/attribute-values`, { values: [{ attributeId: gsm.id, value: null }] }, admin);
    expect((await c.del(`/api/v1/attributes/${gsm.id}`, admin)).status).toBe(200);
    const detail = await c.get(`/api/v1/products/${p.id}`, admin);
    expect(detail.body.data.attributeValues.map((v: any) => v.code).sort()).toEqual(['colour', 'made_on', 'organic']);
  });

  it('category attributes: required ones gate marketplace readiness', async () => {
    const material = (await c.post('/api/v1/attributes', { code: 'material', name: 'Material', dataType: 'text' }, admin)).body.data;
    const cat = (await c.post('/api/v1/categories', { name: 'Needs Material' }, admin)).body.data;
    const set = await c.put(`/api/v1/categories/${cat.id}/attributes`, { items: [{ attributeId: material.id, isRequired: true }] }, admin);
    expect(set.body.data[0]).toMatchObject({ isRequired: true, attribute: { code: 'material' } });

    const p = (await c.post('/api/v1/products', { ...product('READY-1', { categoryId: cat.id, hsnCode: '6109', gstRateBps: 500, countryOfOrigin: 'IN', title: 'A complete product title', description: 'A complete product description text' }), variants: [{ sku: 'READY-1-A', mrpMinor: 1000, sellingPriceMinor: 900, weightGrams: 100, barcode: '9780306406157' }] }, admin)).body.data;
    const doc = await c.post(`/api/v1/products/${p.id}/documents`, { fileName: 'r.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG_BYTES.length }, admin);
    await c.call('POST', doc.body.data.upload.url, { as: admin, raw: JPEG_BYTES, contentType: 'image/jpeg' });

    let ready = (await c.get(`/api/v1/products/${p.id}/readiness`, admin)).body.data;
    expect(ready.ready).toBe(false);
    expect(ready.checks.find((x: any) => x.code === 'attribute:material')).toMatchObject({ ok: false, severity: 'error' });
    await c.put(`/api/v1/products/${p.id}/attribute-values`, { values: [{ attributeId: material.id, value: 'cotton' }] }, admin);
    ready = (await c.get(`/api/v1/products/${p.id}/readiness`, admin)).body.data;
    expect(ready).toMatchObject({ ready: true, errors: 0, warnings: 0 });
  });

  it('marketplace-specific data stays outside the core product and gates connector-aware readiness', async () => {
    const p = (await c.post('/api/v1/products', product('MP-1', { variants: [{ sku: 'MP-1-A' }] }), admin)).body.data;
    expect(Object.keys(p)).not.toEqual(expect.arrayContaining(['amazon', 'flipkart', 'asin', 'fsn']));
    expect((await c.put(`/api/v1/products/${p.id}/marketplace-data/flipkart`, { data: { fsn: 'ABCD1234', vertical: 'shirt' } }, admin)).status).toBe(200);
    expect((await c.put(`/api/v1/products/${p.id}/marketplace-data/notamarketplace`, { data: {} }, admin)).status).toBe(404);
    const list = await c.get(`/api/v1/products/${p.id}/marketplace-data`, admin);
    expect(list.body.data).toEqual([expect.objectContaining({ marketplace: 'flipkart', data: { fsn: 'ABCD1234', vertical: 'shirt' }, version: 1 })]);
    expect((await c.put(`/api/v1/products/${p.id}/marketplace-data/flipkart`, { data: { fsn: 'ABCD1234' } }, admin)).body.data.version).toBe(2);
    const flipkartReady = (await c.get(`/api/v1/products/${p.id}/readiness?marketplace=flipkart`, admin)).body.data;
    expect(flipkartReady.marketplace).toBe('flipkart');
    expect(flipkartReady.checks.find((x: any) => x.code === 'marketplace_category_mapping')).toMatchObject({ ok: true }); // Flipkart declares requiresCategoryMapping and we supplied its data
    expect((await c.del(`/api/v1/products/${p.id}/marketplace-data/flipkart`, admin)).status).toBe(200);
    const after = (await c.get(`/api/v1/products/${p.id}/readiness?marketplace=flipkart`, admin)).body.data;
    expect(after.checks.find((x: any) => x.code === 'marketplace_category_mapping')).toMatchObject({ ok: false, severity: 'error' });
    expect((await c.del(`/api/v1/products/${p.id}/marketplace-data/flipkart`, admin)).status).toBe(404);
  });
});

describe('CSV import / export (asynchronous jobs)', () => {
  it('imports products and SKUs with a row-level error report, then exports them back', async () => {
    const cat = (await c.post('/api/v1/categories', { name: 'Import Cat', slug: 'import-cat' }, admin)).body.data;
    const csv = [
      'product_code,title,brand,category_slug,hsn_code,gst_rate_bps,status,sku,barcode,option_values,mrp_minor,selling_price_minor,weight_grams,tags',
      'IMP-1,Imported Tee,ImpBrand,import-cat,6109,500,active,IMP-1-S,8901234567897,size=S;color=Red,50000,40000,150,new|summer',
      'IMP-1,,,,,,,IMP-1-M,,size=M;color=Red,50000,40000,150,',
      'IMP-2,Imported Cap,ImpBrand,missing-cat,,,,IMP-2-A,,,1000,900,,',
      'IMP-3,Imported Bag,ImpBrand,,,,,IMP-3-A,,,1000,5000,,',
      'IMP-4,Dup SKU product,ImpBrand,,,,,IMP-1-S,,,1000,900,,',
    ].join('\r\n');

    const job = await c.post('/api/v1/products/imports', undefined, admin);
    expect(job.status).toBe(201);
    expect(job.body.data.job).toMatchObject({ kind: 'import', status: 'awaiting_upload', hasInput: false });
    const id = job.body.data.job.id;

    expect((await c.post(`/api/v1/data-jobs/${id}/start`, {}, admin)).status).toBe(409); // no file yet
    expect((await c.call('POST', job.body.data.upload.url, { as: admin, raw: csv, contentType: 'application/json' })).status).toBe(400); // wrong content type is parsed as JSON
    const up = await c.call('POST', job.body.data.upload.url, { as: admin, raw: csv, contentType: 'text/csv' });
    expect(up.status).toBe(200);
    expect(up.body.data.hasInput).toBe(true);
    const started = await c.post(`/api/v1/data-jobs/${id}/start`, {}, admin);
    expect(started.status).toBe(202);
    expect(started.body.data.status).toBe('queued');
    expect((await c.post(`/api/v1/data-jobs/${id}/start`, {}, admin)).status).toBe(409); // already started

    expect(await t.runJobs()).toBe(1); // what apps/worker does with the queued job
    const done = (await c.get(`/api/v1/data-jobs/${id}`, admin)).body.data;
    expect(done.status).toBe('partially_failed');
    expect(done.stats).toMatchObject({ rows: 5, productsCreated: 1, variantsCreated: 2, failedRows: 3 });
    expect(done.errors.map((e: any) => e.message).join('|')).toMatch(/missing-cat.*not found/);
    expect(done.errors.map((e: any) => e.message).join('|')).toMatch(/IMP-4/);

    const tee = (await c.get('/api/v1/products?q=IMP-1', admin)).body.data[0];
    expect(tee).toMatchObject({ productCode: 'IMP-1', title: 'Imported Tee', status: 'active', variantCount: 2, categoryId: cat.id, tags: ['new', 'summer'] });
    expect((await c.get('/api/v1/products?q=IMP-2', admin)).body.data).toHaveLength(0); // failed group rolled back entirely
    expect((await c.get('/api/v1/products?q=IMP-3', admin)).body.data).toHaveLength(0); // selling price > MRP

    // idempotent replay of the same queued message does nothing
    await t.queues.enqueue('heavy', 'catalog.import-products', { vendorId: admin.vendorId, correlationId: 'x', data: { jobId: id } });
    await t.runJobs();
    expect((await c.get(`/api/v1/data-jobs/${id}`, admin)).body.data.stats.productsCreated).toBe(1);

    // re-importing updates instead of duplicating
    const job2 = (await c.post('/api/v1/products/imports', undefined, admin)).body.data;
    await c.call('POST', job2.upload.url, { as: admin, raw: 'product_code,title,sku,selling_price_minor\nIMP-1,Imported Tee v2,IMP-1-S,35000\n', contentType: 'text/csv' });
    await c.post(`/api/v1/data-jobs/${job2.job.id}/start`, {}, admin);
    await t.runJobs();
    const redo = (await c.get(`/api/v1/data-jobs/${job2.job.id}`, admin)).body.data;
    expect(redo).toMatchObject({ status: 'succeeded', stats: { productsUpdated: 1, productsCreated: 0, variantsUpdated: 1 } });
    expect((await c.get(`/api/v1/products/${tee.id}`, admin)).body.data.title).toBe('Imported Tee v2');

    // export
    const exp = await c.post('/api/v1/products/exports', { status: 'active' }, admin);
    expect(exp.status).toBe(202);
    await t.runJobs();
    const exported = await c.get(`/api/v1/data-jobs/${exp.body.data.id}`, admin);
    expect(exported.body.data).toMatchObject({ status: 'succeeded', hasOutput: true });
    const file = await c.call('GET', `/api/v1/data-jobs/${exp.body.data.id}/download`, { as: admin });
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['content-disposition']).toMatch(/attachment/);
    const text = file.raw.body;
    expect(text.split('\r\n')[0]).toBe('product_code,title,description,brand,manufacturer,country_of_origin,category_slug,hsn_code,gst_rate_bps,tags,status,sku,barcode,option_values,currency,mrp_minor,selling_price_minor,cost_price_minor,tax_rate_bps,weight_grams,length_mm,width_mm,height_mm,variant_status');
    expect(text).toContain('IMP-1-S');
    expect(text).toContain('size=M;color=Red');
    expect(text).not.toContain('Dup SKU product');

    // jobs are tenant-private
    const other = await c.registerVendor();
    expect((await c.get(`/api/v1/data-jobs/${id}`, other)).status).toBe(404);
    expect((await c.call('GET', `/api/v1/data-jobs/${exp.body.data.id}/download`, { as: other })).status).toBe(404);
  });

  it('rejects files without the required columns', async () => {
    const job = (await c.post('/api/v1/products/imports', undefined, admin)).body.data;
    await c.call('POST', job.upload.url, { as: admin, raw: 'title,brand\nx,y\n', contentType: 'text/csv' });
    await c.post(`/api/v1/data-jobs/${job.job.id}/start`, {}, admin);
    await t.runJobs();
    const done = (await c.get(`/api/v1/data-jobs/${job.job.id}`, admin)).body.data;
    expect(done.status).toBe('failed');
    expect(done.errors[0].message).toMatch(/product_code/);
  });

  it('neutralises spreadsheet formula injection in exports', async () => {
    await c.post('/api/v1/products', { productCode: 'INJ-1', title: '=HYPERLINK("http://evil","click")', variants: [{ sku: 'INJ-1-A' }] }, admin);
    const exp = await c.post('/api/v1/products/exports', { q: 'INJ-1' }, admin);
    await t.runJobs();
    const file = await c.call('GET', `/api/v1/data-jobs/${exp.body.data.id}/download`, { as: admin });
    expect(file.raw.body).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
  });
});
