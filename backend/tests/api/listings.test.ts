import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, clientFor, mockControl, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let viewer: Actor;
let other: Actor;
let wh: { id: string };

beforeAll(async () => {
  t = await buildTestApp({ database: true });
  c = clientFor(t);
  admin = await c.registerVendor({ businessName: 'Listing Co' });
  viewer = await c.addMember(admin, 'vendor_viewer');
  other = await c.registerVendor({ businessName: 'Rival Co' });
  wh = await c.makeWarehouse(admin);
});
beforeEach(() => mockControl.reset());
afterAll(() => t.close());

const listing = async (id: string, as = admin) => (await c.get(`/api/v1/listings/${id}`, as)).body.data;
const newListing = async (accountId: string, variantId: string, extra: Record<string, unknown> = {}) => {
  const r = await c.post('/api/v1/listings', { marketplaceAccountId: accountId, variantId, marketplaceCategoryId: 'mock-apparel', ...extra }, admin);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
};
/** draft -> ready -> approved */
const approve = async (id: string) => {
  expect((await c.post(`/api/v1/listings/${id}/validate`, {}, admin)).body.data.validation.ready).toBe(true);
  const r = await c.post(`/api/v1/listings/${id}/approve`, {}, admin);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};

describe('the listing flow: master product -> mapping -> validation -> preview -> approval -> publish -> status', () => {
  it('runs end to end and tracks the marketplace review (pending -> active)', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin, { title: 'Premium cotton tee shirt' });
    await c.stock(admin, v.variantId, wh.id, 20);

    const l = await newListing(acct.id, v.variantId);
    expect(l).toMatchObject({ status: 'draft', marketplace: 'mock', externalSku: v.sku, externalListingId: null, marketplaceCategoryId: 'mock-apparel', source: 'created' });

    // cannot be approved or published before it is validated
    expect((await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin)).status).toBe(422);

    const val = await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin);
    expect(val.status).toBe(200);
    expect(val.body.data.validation).toMatchObject({ ready: true, errors: [] });
    expect(val.body.data.validation.warnings.map((w: any) => w.code)).toContain('images_missing');
    // brand came from the product (core-field hint), size/color from the variant options
    expect(val.body.data.attributeSources).toMatchObject({ brand: 'core:brand', color: 'option', size: 'option' });
    expect(val.body.data.listing.status).toBe('ready');

    const prev = await c.get(`/api/v1/listings/${l.id}/preview`, admin);
    expect(prev.body.data).toMatchObject({ marketplace: 'mock', endpoint: 'POST /sandbox/listings', approval: { approved: false, current: false } });
    expect(prev.body.data.payload).toMatchObject({ sku: v.sku, category: 'mock-apparel', price: 49900, attributes: { brand: 'Acme', color: 'Blue', size: 'M' } });

    const appr = await c.post(`/api/v1/listings/${l.id}/approve`, {}, admin);
    expect(appr.body.data).toMatchObject({ status: 'approved', approval: { approved: true } });
    expect((await c.get(`/api/v1/listings/${l.id}/preview`, admin)).body.data.approval.current).toBe(true);

    const pub = await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    expect(pub.status).toBe(202);
    expect(pub.body.data.job).toMatchObject({ type: 'listing_publish', status: 'queued', marketplaceAccountId: acct.id });
    // publishing twice for the same approval returns the same job (no double submit)
    const again = await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    expect(again.body.data.job.id).toBe(pub.body.data.job.id);
    expect(again.body.data.alreadyQueued).toBe(true);

    await t.pump();
    const job = (await c.get(`/api/v1/sync/jobs/${pub.body.data.job.id}`, admin)).body.data;
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1 });
    // the marketplace review finished during the status job that publish scheduled
    const live = await listing(l.id);
    expect(live).toMatchObject({ status: 'active', externalStatus: 'ACTIVE', externalListingId: expect.stringMatching(/^MP-/) });
    expect(live.publishedAt).toBeTruthy();
    expect(mockControl.state.seller(acct.sellerId).products.get(v.sku)?.status).toBe('active');
  });

  it('refuses to approve a listing that fails validation, and says exactly why', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId, { marketplaceCategoryId: 'mock-accessories' });
    const r = await c.post(`/api/v1/listings/${l.id}/approve`, {}, admin);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LISTING_NOT_READY');
    const errs = r.body.error.details.errors.map((e: any) => e.code);
    expect(errs).toEqual(expect.arrayContaining(['attribute_missing'])); // material is required for accessories and nothing provides it
    const val = (await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin)).body.data;
    expect(val.validation.ready).toBe(false);
    expect(val.validation.errors.find((e: any) => e.attribute === 'material')).toMatchObject({ code: 'attribute_missing' });
    expect(val.listing.status).toBe('draft');
  });

  it('attribute mapping and explicit listing values fill what the marketplace requires', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId, { marketplaceCategoryId: 'mock-accessories' });

    // 1) a static mapping
    const m = await c.put('/api/v1/attribute-mappings', { marketplace: 'mock', marketplaceCategoryId: 'mock-accessories', marketplaceAttribute: 'material', source: { type: 'static', value: 'Cotton' } }, admin);
    expect(m.status).toBe(200);
    const val = (await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin)).body.data;
    expect(val.validation.ready).toBe(true);
    expect(val.attributeSources.material).toBe('static');

    // 2) a value map translates our wording; an explicit listing value wins over the mapping
    await c.put('/api/v1/attribute-mappings', { marketplace: 'mock', marketplaceCategoryId: 'mock-accessories', marketplaceAttribute: 'material', source: { type: 'static', value: 'Cotton' }, valueMap: { Cotton: 'Organic Cotton' } }, admin);
    await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin);
    expect((await c.get(`/api/v1/listings/${l.id}/preview`, admin)).body.data.payload.attributes.material).toBe('Organic Cotton');
    expect((await c.patch(`/api/v1/listings/${l.id}`, { attributeValues: { material: 'Leather' } }, admin)).status).toBe(200);
    await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin);
    expect((await c.get(`/api/v1/listings/${l.id}/preview`, admin)).body.data.payload.attributes.material).toBe('Leather');

    expect((await c.get('/api/v1/attribute-mappings?filter[marketplace]=mock', admin)).body.data).toHaveLength(1);
    expect((await c.put('/api/v1/attribute-mappings', { marketplace: 'mock', marketplaceCategoryId: 'x', marketplaceAttribute: 'y', source: { type: 'core_field', coreField: 'nonsense' } }, admin)).status).toBe(400);
  });

  it('suggests mappings from the category requirements and maps categories', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const cats = await c.get(`/api/v1/marketplace-accounts/${acct.id}/categories?query=apparel`, admin);
    expect(cats.body.data.map((x: any) => x.id)).toEqual(['mock-apparel']);
    const reqs = await c.get(`/api/v1/marketplace-accounts/${acct.id}/categories/mock-apparel/requirements`, admin);
    expect(reqs.body.data.map((r: any) => r.name).sort()).toEqual(['brand', 'color', 'country_of_origin', 'size']);
    const sug = (await c.get(`/api/v1/marketplace-accounts/${acct.id}/categories/mock-apparel/mapping-suggestions`, admin)).body.data;
    expect(sug.find((s: any) => s.requirement.name === 'brand').suggestion).toMatchObject({ type: 'core_field', coreField: 'brand' });

    // category mapping: products in our category get the marketplace category automatically
    const cat = (await c.post('/api/v1/categories', { name: 'Tees', slug: 'tees' }, admin)).body.data;
    const m = await c.put('/api/v1/category-mappings', { marketplace: 'mock', categoryId: cat.id, marketplaceCategoryId: 'mock-apparel', marketplaceCategoryName: 'Apparel' }, admin);
    expect(m.status).toBe(200);
    const v = await c.makeVariant(admin, { categoryId: cat.id });
    const r = await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId: v.variantId }, admin);
    expect(r.body.data.marketplaceCategoryId).toBeNull(); // stored value stays empty...
    const val = (await c.post(`/api/v1/listings/${r.body.data.id}/validate`, {}, admin)).body.data;
    expect(val.validation.ready).toBe(true); // ...but the mapped category was used
    expect((await c.get('/api/v1/category-mappings', admin)).body.data).toHaveLength(1);
    expect((await c.del(`/api/v1/category-mappings/${m.body.data.id}`, admin)).status).toBe(200);
  });

  it('a marketplace rejection is recorded with its errors; correction + re-approval + republish recovers', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin, { title: 'A perfectly fine replica watch strap' }); // "replica" trips the marketplace's policy review
    const l = await newListing(acct.id, v.variantId);
    await approve(l.id);
    await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    await t.pump();
    const rej = await listing(l.id);
    expect(rej.status).toBe('rejected');
    expect(rej.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'POLICY_VIOLATION', severity: 'error' })]));
    expect(rej.externalStatus).toBe('REJECTED');
    expect((await t.outbox('listing.failed')).length).toBeGreaterThan(0);

    // fix the product title, re-validate, approve again, publish again
    await c.patch(`/api/v1/products/${v.productId}`, { title: 'A perfectly fine leather watch strap' }, admin);
    await approve(l.id);
    await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    await t.pump();
    expect((await listing(l.id)).status).toBe('active');
  });

  it('approval is bound to the exact content: any change invalidates it', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId);
    await approve(l.id);
    // the merchant edits the price after approving
    const edited = await c.patch(`/api/v1/listings/${l.id}`, { priceMinor: 45000 }, admin);
    expect(edited.body.data).toMatchObject({ status: 'draft', approval: { approved: false } });
    expect((await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin)).status).toBe(422);
    // a product-level change after approval (title) is caught at publish time by the content hash
    await approve(l.id);
    await c.patch(`/api/v1/products/${v.productId}`, { title: 'Totally different title now' }, admin);
    const r = await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    expect(r.status).toBe(422);
    expect(r.body.error.details.reason).toBe('changed_since_approval');
  });

  it('unpublish takes it down; a live listing only allows price/stock-limit edits', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId);
    await approve(l.id);
    await c.post(`/api/v1/listings/${l.id}/publish`, {}, admin);
    await t.pump();
    expect((await listing(l.id)).status).toBe('active');

    const bad = await c.patch(`/api/v1/listings/${l.id}`, { marketplaceCategoryId: 'mock-accessories' }, admin);
    expect(bad.status).toBe(409);
    expect(bad.body.error.details.notAllowed).toContain('marketplaceCategoryId');
    expect((await c.patch(`/api/v1/listings/${l.id}`, { bufferOverride: 2 }, admin)).status).toBe(200);
    expect((await c.del(`/api/v1/listings/${l.id}`, admin)).status).toBe(409); // live listings are never deleted

    const un = await c.post(`/api/v1/listings/${l.id}/unpublish`, {}, admin);
    expect(un.status).toBe(202);
    await t.pump();
    expect((await listing(l.id)).status).toBe('unpublished');
    expect(mockControl.state.seller(acct.sellerId).products.get(v.sku)?.status).toBe('inactive');
    expect((await t.outbox('listing.deactivated')).length).toBe(1);
  });

  it('one listing per variant per account; drafts can be deleted', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId);
    const dup = await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId: v.variantId }, admin);
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({ field: 'variantId', listingId: l.id });
    expect((await c.del(`/api/v1/listings/${l.id}`, admin)).status).toBe(200);
    expect((await c.get(`/api/v1/listings/${l.id}`, admin)).status).toBe(404);
    // the same variant can be listed on a second account of the same marketplace
    const acct2 = await c.connectAccount(admin, 'mock');
    expect((await c.post('/api/v1/listings', { marketplaceAccountId: acct2.id, variantId: v.variantId }, admin)).status).toBe(201);
  });

  it('tenant isolation and permissions', async () => {
    const acct = await c.connectAccount(admin, 'mock');
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId);
    expect((await c.get(`/api/v1/listings/${l.id}`, other)).status).toBe(404);
    expect((await c.post(`/api/v1/listings/${l.id}/approve`, {}, other)).status).toBe(404);
    expect((await c.get('/api/v1/listings', other)).body.data.map((x: any) => x.id)).not.toContain(l.id);
    // another vendor cannot list ITS variant on MY account, nor mine on its account
    const theirs = await c.makeVariant(other);
    expect((await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId: theirs.variantId }, other)).status).toBe(404);
    expect((await c.post('/api/v1/listings', { marketplaceAccountId: acct.id, variantId: v.variantId }, viewer)).status).toBe(403);
    expect((await c.get('/api/v1/listings', viewer)).status).toBe(200);
  });

  it('listing a marketplace that cannot be reached asks for a connection first', async () => {
    const acct = (await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'Never connected' }, admin)).body.data;
    const v = await c.makeVariant(admin);
    const l = await newListing(acct.id, v.variantId);
    const val = (await c.post(`/api/v1/listings/${l.id}/validate`, {}, admin)).body.data;
    expect(val.validation.ready).toBe(false);
    expect(val.validation.errors.map((e: any) => e.code)).toEqual(expect.arrayContaining(['account_not_connected']));
  });
});
