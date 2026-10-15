import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { created, ok, paginated, vendorTx } from '@oms/module-kit';
import { IdParamSchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { Errors } from '@oms/shared';
import { getProductAttributeValues, setProductAttributeValues } from '@oms/mod-attributes';
import { requestEffects } from './effects';
import * as svc from './service';
import * as ready from './readiness';
import {
  AttributeValueOutSchema, BulkBodySchema, BulkResultSchema, MarketplaceDataBodySchema, MarketplaceDataSchema, ProductAttributeInputSchema, ProductDetailSchema,
  ProductInputSchema, ProductListQuerySchema, ProductSchema, ProductUpdateSchema, ReadinessSchema, VariantInputSchema, VariantListItemSchema, VariantListQuerySchema, VariantSchema, VariantUpdateSchema,
} from './schemas';

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const PRODUCTS = ['Products'];
  const VARIANTS = ['Variants'];
  const Msg = z.object({ message: z.string() });

  // ================================================================== products
  r.post('/products', {
    config: { access: { permission: 'products:write' } },
    schema: {
      tags: PRODUCTS,
      summary: 'Create a product (optionally with variants/SKUs)',
      description: 'Creates the canonical, marketplace-neutral product. `productCode` and every variant `sku` are unique per vendor (409 otherwise). Activating (`status: "active"`) needs at least one active variant.',
      body: ProductInputSchema,
      response: { 201: successEnvelope(ProductDetailSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, (tx, vendorId) => svc.createProduct(tx, vendorId, req.body, requestEffects(tx, req)));
    return created(req, reply, dto, `/api/v1/products/${dto.id}`);
  });

  r.get('/products', {
    config: { access: { permission: 'products:read' } },
    schema: {
      tags: PRODUCTS,
      summary: 'Search, filter, sort and page through products',
      description: '`q` matches title, product code, brand and variant SKU/barcode. Filters: `filter[status]`, `filter[categoryId]`, `filter[brand]`, `filter[createdFrom|createdTo]`. Sort: `sort=-createdAt` (createdAt, updatedAt, title, productCode). Keyset pagination via `cursor`.',
      querystring: ProductListQuerySchema,
      response: { 200: paginatedEnvelope(ProductSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) =>
      svc.listProducts(tx, vendorId, { limit: q.limit, cursor: q.cursor, q: q.q, status: q['filter[status]'], categoryId: q['filter[categoryId]'], brand: q['filter[brand]'], createdFrom: q['filter[createdFrom]'], createdTo: q['filter[createdTo]'], sort: q.sort }),
    );
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/products/:id', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: PRODUCTS, summary: 'Get a product with its variants and attribute values', params: IdParamSchema, response: { 200: successEnvelope(ProductDetailSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.getProductDetail(tx, vendorId, req.params.id))));

  r.patch('/products/:id', {
    config: { access: { permission: 'products:write' } },
    schema: {
      tags: PRODUCTS,
      summary: 'Update a product (partial) or change its status',
      description: 'Only the fields you send change. Send `version` for optimistic locking (409 `VERSION_CONFLICT` if someone else edited). `status: "archived"` archives; `"active"` needs an active variant.',
      params: IdParamSchema,
      body: ProductUpdateSchema,
      response: { 200: successEnvelope(ProductDetailSchema) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.updateProduct(tx, vendorId, req.params.id, req.body, requestEffects(tx, req)))));

  r.delete('/products/:id', {
    config: { access: { permission: 'products:delete' } },
    schema: { tags: PRODUCTS, summary: 'Delete a product', description: 'Soft delete of the product and its variants (history is kept). Use PATCH status=archived to hide a product reversibly.', params: IdParamSchema, response: { 200: successEnvelope(Msg) } },
  }, async (req) => {
    await vendorTx(req, (tx, vendorId) => svc.deleteProduct(tx, vendorId, req.params.id, requestEffects(tx, req)));
    return ok(req, { message: 'Product deleted' });
  });

  // ------------------------------------------------------------------ bulk
  r.post('/products/bulk', {
    config: { access: { permission: 'products:write' } },
    schema: {
      tags: PRODUCTS,
      summary: 'Bulk operations (create, change status, delete)',
      description: 'Each item succeeds or fails independently (partial success, HTTP 200): inspect `results`. `delete` additionally needs products:delete. For files with thousands of rows use the CSV import (POST /products/imports).',
      body: BulkBodySchema,
      response: { 200: successEnvelope(BulkResultSchema) },
    },
  }, async (req) => {
    const body = req.body;
    if (body.action === 'delete' && !req.ctx.principal!.permissions.has('products:delete')) throw Errors.forbidden('products:delete');
    const results = await vendorTx(req, async (tx, vendorId) => {
      const fx = requestEffects(tx, req);
      let res: svc.BulkItemResult[];
      if (body.action === 'create') {
        res = await svc.runBulk(tx, body.items, async (inner, item) => (await svc.createProduct(inner, vendorId, item, requestEffects(inner, req))).id);
      } else if (body.action === 'update_status') {
        res = await svc.runBulk(tx, body.ids, async (inner, id) => (await svc.updateProduct(inner, vendorId, id, { status: body.status }, requestEffects(inner, req))).id);
      } else {
        res = await svc.runBulk(tx, body.ids, async (inner, id) => (await svc.deleteProduct(inner, vendorId, id, requestEffects(inner, req))).id);
      }
      await fx.audit({ action: `product.bulk_${body.action}`, resourceType: 'product', resourceId: 'bulk', metadata: { total: res.length, failed: res.filter((x) => !x.ok).length } });
      return res;
    });
    const failed = results.filter((x) => !x.ok).length;
    return ok(req, { action: body.action, summary: { total: results.length, succeeded: results.length - failed, failed }, results });
  });

  // ------------------------------------------------------------------ attribute values
  r.get('/products/:id/attribute-values', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: PRODUCTS, summary: 'Attribute values of a product and its variants', params: IdParamSchema, response: { 200: successEnvelope(z.array(AttributeValueOutSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await svc.getProductRow(tx, vendorId, req.params.id); return getProductAttributeValues(tx, vendorId, req.params.id); })));

  r.put('/products/:id/attribute-values', {
    config: { access: { permission: 'products:write' } },
    schema: {
      tags: PRODUCTS,
      summary: 'Set (or clear with null) attribute values',
      description: 'Values are validated against the attribute type (number, boolean, date, enum membership). Variant-scoped attributes need `variantId`.',
      params: IdParamSchema,
      body: z.object({ values: z.array(ProductAttributeInputSchema).min(1).max(100) }),
      response: { 200: successEnvelope(z.array(AttributeValueOutSchema)) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    await svc.getProductRow(tx, vendorId, req.params.id);
    await setProductAttributeValues(tx, vendorId, req.params.id, req.body.values);
    await requestEffects(tx, req).audit({ action: 'product.attributes_set', resourceType: 'product', resourceId: req.params.id, after: { attributeIds: req.body.values.map((v) => v.attributeId) } });
    await requestEffects(tx, req).event({ type: 'product.updated', aggregateType: 'product', aggregateId: req.params.id, payload: { fields: ['attributeValues'] } });
    return getProductAttributeValues(tx, vendorId, req.params.id);
  })));

  // ------------------------------------------------------------------ marketplace-specific data + readiness
  r.get('/products/:id/marketplace-data', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: PRODUCTS, summary: 'Marketplace-specific data for a product', description: 'Per-marketplace payloads (category ids, bullet points...) kept separate from the core product.', params: IdParamSchema, response: { 200: successEnvelope(z.array(MarketplaceDataSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => ready.listMarketplaceData(tx, vendorId, req.params.id))));

  const MpParams = z.object({ id: z.uuid(), marketplace: z.string().min(2).max(40) });
  r.put('/products/:id/marketplace-data/:marketplace', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: PRODUCTS, summary: 'Set marketplace-specific data for one marketplace', params: MpParams, body: MarketplaceDataBodySchema, response: { 200: successEnvelope(MarketplaceDataSchema) } },
  }, async (req) => {
    if (!c.connectors.has(req.params.marketplace)) throw Errors.notFound('Marketplace', req.params.marketplace);
    return ok(req, await vendorTx(req, async (tx, vendorId) => {
      const out = await ready.putMarketplaceData(tx, vendorId, req.params.id, req.params.marketplace, req.body.data);
      await requestEffects(tx, req).audit({ action: 'product.marketplace_data_set', resourceType: 'product', resourceId: req.params.id, metadata: { marketplace: req.params.marketplace } });
      return out;
    }));
  });

  r.delete('/products/:id/marketplace-data/:marketplace', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: PRODUCTS, summary: 'Remove marketplace-specific data', params: MpParams, response: { 200: successEnvelope(Msg) } },
  }, async (req) => {
    await vendorTx(req, (tx, vendorId) => ready.deleteMarketplaceData(tx, vendorId, req.params.id, req.params.marketplace));
    return ok(req, { message: 'Marketplace data removed' });
  });

  r.get('/products/:id/readiness', {
    config: { access: { permission: 'products:read' } },
    schema: {
      tags: PRODUCTS,
      summary: 'Is this product ready for marketplace listing?',
      description: 'Generic completeness checks (title, brand, category, HSN/GST, price/MRP, image, required category attributes). Add `?marketplace=flipkart` for connector-aware checks.',
      params: IdParamSchema,
      querystring: z.object({ marketplace: z.string().min(2).max(40).optional() }),
      response: { 200: successEnvelope(ReadinessSchema) },
    },
  }, async (req) => {
    const connector = req.query.marketplace ? c.connectors.get(req.query.marketplace) : undefined;
    return ok(req, await vendorTx(req, (tx, vendorId) => ready.evaluateReadiness(tx, vendorId, req.params.id, connector)));
  });

  // ================================================================== variants
  r.post('/products/:id/variants', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: VARIANTS, summary: 'Add a variant (SKU) to a product', description: 'SKU and barcode are unique per vendor (409 `CONFLICT` with `details.field`).', params: IdParamSchema, body: VariantInputSchema, response: { 201: successEnvelope(VariantSchema) } },
  }, async (req, reply) => {
    const dto = await vendorTx(req, (tx, vendorId) => svc.createVariant(tx, vendorId, req.params.id, req.body, requestEffects(tx, req)));
    return created(req, reply, dto, `/api/v1/variants/${dto.id}`);
  });

  r.get('/products/:id/variants', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: VARIANTS, summary: 'List a product\'s variants', params: IdParamSchema, response: { 200: successEnvelope(z.array(VariantSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.listProductVariants(tx, vendorId, req.params.id))));

  r.get('/variants', {
    config: { access: { permission: 'products:read' } },
    schema: {
      tags: VARIANTS,
      summary: 'Look up / search variants across all products',
      description: 'Exact `sku` or `barcode` lookup, or free-text `q` (SKU, barcode, product title). Includes the parent product code and title.',
      querystring: VariantListQuerySchema,
      response: { 200: paginatedEnvelope(VariantListItemSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listVariants(tx, vendorId, { limit: q.limit, cursor: q.cursor, q: q.q, sku: q.sku, barcode: q.barcode, status: q['filter[status]'], productId: q['filter[productId]'], sort: q.sort }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/variants/:id', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: VARIANTS, summary: 'Get a variant', params: IdParamSchema, response: { 200: successEnvelope(VariantSchema) } },
  }, async (req) => ok(req, svc.toVariantDto(await vendorTx(req, (tx, vendorId) => svc.getVariantRow(tx, vendorId, req.params.id)))));

  r.patch('/variants/:id', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: VARIANTS, summary: 'Update a variant (partial)', description: 'Price changes emit `variant.price_changed` for downstream marketplace sync.', params: IdParamSchema, body: VariantUpdateSchema, response: { 200: successEnvelope(VariantSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.updateVariant(tx, vendorId, req.params.id, req.body, requestEffects(tx, req)))));

  r.delete('/variants/:id', {
    config: { access: { permission: 'products:write' } },
    schema: { tags: VARIANTS, summary: 'Delete a variant', description: 'Soft delete. The last active variant of an active product cannot be deleted.', params: IdParamSchema, response: { 200: successEnvelope(Msg) } },
  }, async (req) => {
    await vendorTx(req, (tx, vendorId) => svc.deleteVariant(tx, vendorId, req.params.id, requestEffects(tx, req)));
    return ok(req, { message: 'Variant deleted' });
  });
};

