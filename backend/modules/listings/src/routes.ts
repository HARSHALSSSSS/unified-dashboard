import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, sortQuery, successEnvelope } from '@oms/contracts';
import { audit, created, ok, paginated, requireVendor, vendorTx } from '@oms/module-kit';
import { SyncJobSchema, toSyncJobDto } from '@oms/mod-sync';
import { assertAccount, getPolicy, recentStockUpdates, requestInventorySync, savePolicy, toPolicyDto } from './channel';
import { CORE_FIELDS } from './context';
import { ctxFromRequest, fx } from './ctx';
import { LISTING_STATUS_VALUES } from './schemas';
import { createMasterFromImported, ignoreImported, linkImported, listImported, requestImport } from './imports';
import { categoryRequirements, deleteAttributeMapping, deleteCategoryMapping, listAttributeMappings, listCategoryMappings, searchMarketplaceCategories, suggestMappings, toAttributeMappingDto, toCategoryMappingDto, upsertAttributeMapping, upsertCategoryMapping } from './mappings';
import * as svc from './service';

const Scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
const ListingSchema = z
  .object({
    id: z.string(), marketplaceAccountId: z.string(), marketplace: z.string(), variantId: z.string(), productId: z.string(), sku: z.string().describe('Master (variant) SKU'), productTitle: z.string(),
    externalSku: z.string().describe('The SKU on the marketplace'), externalListingId: z.string().nullable().describe('The marketplace\'s own listing id (ASIN / FSN / style id ...), set once submitted'),
    status: z.enum(LISTING_STATUS_VALUES).describe('draft -> ready (validated) -> approved (merchant) -> pending (submitted) -> active | rejected | correction_required; unpublished = taken down'),
    externalStatus: z.string().nullable().describe('The marketplace\'s own status word, verbatim'), source: z.enum(['created', 'imported']),
    marketplaceCategoryId: z.string().nullable(), currency: z.string(),
    priceMinor: z.number().nullable().describe('Listing price override; null = follow the variant selling price'), mrpMinor: z.number().nullable(),
    effectivePriceMinor: z.number().nullable(), effectiveMrpMinor: z.number().nullable(),
    attributeValues: z.record(z.string(), Scalar).describe('Values you set explicitly for this listing (they win over mappings)'),
    issues: z.array(z.object({ code: z.string(), message: z.string(), attribute: z.string().optional(), severity: z.enum(['error', 'warning']) })).describe('Marketplace errors / warnings from the last submission or status check'),
    validation: z.object({ ready: z.boolean(), errorCount: z.number().int(), warningCount: z.number().int(), validatedAt: IsoDate }).nullable(),
    approval: z.object({ approved: z.boolean(), approvedAt: IsoDate.nullable(), approvedBy: z.string().nullable() }),
    publishedAt: IsoDate.nullable(), lastPolledAt: IsoDate.nullable(),
    quantity: z.object({ sellable: z.number().int().nullable(), pushed: z.number().int().nullable().describe('The quantity the marketplace last confirmed'), dirty: z.boolean().describe('A newer quantity is waiting to be pushed'), pushedAt: IsoDate.nullable() }),
    bufferOverride: z.number().int().nullable(), maxQuantityOverride: z.number().int().nullable(), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
  })
  .meta({ id: 'Listing' });

const IssueSchema = z.object({ code: z.string(), message: z.string(), attribute: z.string().optional() });
const ValidationSchema = z.object({ ready: z.boolean(), errors: z.array(IssueSchema), warnings: z.array(IssueSchema) }).meta({ id: 'ListingValidation' });
const RequirementSchema = z.object({ name: z.string(), label: z.string().optional(), required: z.boolean(), type: z.enum(['string', 'number', 'boolean', 'enum']), allowedValues: z.array(z.string()).optional(), maxLength: z.number().optional(), description: z.string().optional(), coreField: z.string().optional() }).meta({ id: 'ListingRequirement' });
const AsyncResult = z.object({ job: SyncJobSchema, alreadyQueued: z.boolean().describe('true when an identical request is already in flight (nothing new was queued)') }).meta({ id: 'AsyncJobResult' });

const CreateBody = z.object({
  marketplaceAccountId: z.uuid(), variantId: z.uuid(), externalSku: z.string().trim().min(1).max(100).optional().describe('Defaults to the variant SKU'), marketplaceCategoryId: z.string().trim().min(1).max(200).nullish(),
  priceMinor: z.number().int().min(1).nullish(), mrpMinor: z.number().int().min(1).nullish(), attributeValues: z.record(z.string().min(1).max(100), Scalar).optional(),
  bufferOverride: z.number().int().min(0).max(1_000_000).nullish(), maxQuantityOverride: z.number().int().min(0).max(1_000_000).nullish(),
});
const UpdateBody = CreateBody.omit({ marketplaceAccountId: true, variantId: true }).partial().extend({ version: z.number().int().optional() });
const ListQuery = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
  'filter[status]': z.enum(LISTING_STATUS_VALUES).optional(), 'filter[accountId]': z.uuid().optional(), 'filter[variantId]': z.uuid().optional(), 'filter[marketplace]': z.string().max(40).optional(), 'filter[source]': z.enum(['created', 'imported']).optional(),
  sort: sortQuery(['createdAt', 'updatedAt'] as const),
});

export const listingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const LISTINGS = ['Listings'];
  const MAPPINGS = ['Mappings'];
  const IMPORTS = ['Catalog Import'];
  const CHANNEL = ['Channel Inventory'];
  const ctxOf = (req: FastifyRequest) => ctxFromRequest(req, requireVendor(req));
  const accepted = async (req: FastifyRequest, reply: FastifyReply, res: { job: Parameters<typeof toSyncJobDto>[0]; created: boolean }) => {
    reply.code(202);
    return ok(req, { job: toSyncJobDto(res.job), alreadyQueued: !res.created });
  };

  // ================================================================== listings
  r.post('/listings', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: LISTINGS,
      summary: 'Start a listing: master variant -> marketplace account',
      description: 'Step 1 of the flow: Master Product -> Select Marketplace -> Category Mapping -> Attribute Mapping -> Validation -> Preview -> Merchant Approval -> Publish -> Track Status. Creates a `draft`; one listing per variant per account.',
      body: CreateBody,
      response: { 201: successEnvelope(ListingSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, (tx, vendorId) => svc.createListing(tx, ctxFromRequest(req, vendorId), req.body));
    return created(req, reply, dto, `/api/v1/listings/${dto.id}`);
  });

  r.get('/listings', {
    config: { access: { permission: 'listings:read' } },
    schema: { tags: LISTINGS, summary: 'List listings', querystring: ListQuery, response: { 200: paginatedEnvelope(ListingSchema) } },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listListings(tx, vendorId, { limit: q.limit, cursor: q.cursor, sort: q.sort, q: q.q, status: q['filter[status]'], accountId: q['filter[accountId]'], variantId: q['filter[variantId]'], marketplace: q['filter[marketplace]'], source: q['filter[source]'] }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/listings/:id', {
    config: { access: { permission: 'listings:read' } },
    schema: { tags: LISTINGS, summary: 'Get a listing', params: IdParamSchema, response: { 200: successEnvelope(ListingSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.getListingDto(tx, vendorId, req.params.id))));

  r.patch('/listings/:id', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: LISTINGS,
      summary: 'Edit a listing (category, price, attribute values, stock limits)',
      description: 'Editing content resets validation and approval. A LIVE listing (active/pending) only accepts price, MRP and stock-limit changes; a price change is pushed to the marketplace automatically. Send `version` for optimistic concurrency.',
      params: IdParamSchema,
      body: UpdateBody,
      response: { 200: successEnvelope(ListingSchema) },
    },
  }, async (req) => {
    const res = await vendorTx(req, (tx, vendorId) => svc.updateListing(tx, ctxFromRequest(req, vendorId), req.params.id, req.body));
    if (res.priceChanged) await (await import('./channel')).requestPriceSync(c, requireVendor(req), res.dto.marketplaceAccountId, [res.dto.id]);
    if (res.stockRulesChanged && res.dto.status === 'active') {
      await vendorTx(req, (tx, vendorId) => import('./channel').then((m) => m.markDirty(tx, vendorId, { listingIds: [res.dto.id] })));
      await requestInventorySync(c, requireVendor(req), res.dto.marketplaceAccountId, 'manual');
    }
    return ok(req, res.dto);
  });

  r.delete('/listings/:id', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: LISTINGS, summary: 'Delete a listing that never reached the marketplace', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
  }, async (req) => {
    await vendorTx(req, (tx, vendorId) => svc.deleteListing(tx, ctxFromRequest(req, vendorId), req.params.id));
    return ok(req, { id: req.params.id, deleted: true as const });
  });

  r.post('/listings/:id/validate', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: LISTINGS,
      summary: 'Validate against the marketplace category rules',
      description: 'Resolves attribute values (your explicit values, then mappings, then core-field hints, then variant options), loads the category requirements from the marketplace and reports `errors` (blockers) and `warnings`. A valid draft becomes `ready`. The requirements come from the marketplace, so the account must be connected.',
      params: IdParamSchema,
      response: { 200: successEnvelope(z.object({ listing: ListingSchema, validation: ValidationSchema, requirements: z.array(RequirementSchema), attributeSources: z.record(z.string(), z.string()).describe('Where each resolved value came from') })) },
    },
  }, async (req) => ok(req, (await svc.validateListing(ctxOf(req), req.params.id)) as never));

  r.get('/listings/:id/preview', {
    config: { access: { permission: 'listings:read' } },
    schema: {
      tags: LISTINGS,
      summary: 'Preview exactly what will be sent to the marketplace',
      description: 'No network write. Returns the marketplace request (`endpoint`, `payload`), the validation result and whether the merchant approval still matches the current content (`approval.current`).',
      params: IdParamSchema,
      response: { 200: successEnvelope(z.object({ marketplace: z.string(), endpoint: z.string(), payload: z.unknown(), warnings: z.array(z.string()), validation: ValidationSchema, attributeSources: z.record(z.string(), z.string()), contentHash: z.string(), approval: z.object({ approved: z.boolean(), current: z.boolean(), approvedAt: IsoDate.nullable() }) })) },
    },
  }, async (req) => ok(req, await svc.previewListing(ctxOf(req), req.params.id)));

  r.post('/listings/:id/approve', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: LISTINGS,
      summary: 'Merchant approval',
      description: 'Re-validates and records that THIS content was approved (by hash). Any later change to the content invalidates the approval; publishing requires a current approval.',
      params: IdParamSchema,
      response: { 200: successEnvelope(ListingSchema) },
    },
  }, async (req) => ok(req, await svc.approveListing(ctxOf(req), req.params.id)));

  r.post('/listings/:id/publish', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: LISTINGS,
      summary: 'Publish (submit) an approved listing',
      description: 'Asynchronous: returns 202 with the sync job. The job submits the listing, records the marketplace\'s answer (`pending`, `active`, `rejected`, `correction_required`) and schedules status tracking. Repeating the call for the same approval returns the same job.',
      params: IdParamSchema,
      response: { 202: successEnvelope(AsyncResult) },
    },
  }, async (req, reply) => accepted(req, reply, await svc.requestPublish(ctxOf(req), req.params.id)));

  r.post('/listings/:id/unpublish', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: LISTINGS, summary: 'Take a listing down from the marketplace', description: 'Asynchronous (202). Needs the marketplace capability `listings.deactivate`.', params: IdParamSchema, response: { 202: successEnvelope(AsyncResult) } },
  }, async (req, reply) => accepted(req, reply, await svc.requestUnpublish(ctxOf(req), req.params.id)));

  r.post('/listings/:id/refresh-status', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: LISTINGS, summary: 'Check this listing\'s status on the marketplace now', description: 'Asynchronous (202).', params: IdParamSchema, response: { 202: successEnvelope(AsyncResult) } },
  }, async (req, reply) => {
    const ctx = ctxOf(req);
    const l = await vendorTx(req, (tx, vendorId) => svc.getListingDto(tx, vendorId, req.params.id));
    return accepted(req, reply, await svc.requestStatusRefresh(ctx, l.marketplaceAccountId, [l.id]));
  });

  r.get('/listings/:id/stock-updates', {
    config: { access: { permission: 'listings:read' } },
    schema: {
      tags: CHANNEL,
      summary: 'Quantity pushes for this listing',
      description: 'Every time the sellable quantity was sent to the marketplace: what central stock had available, what was requested, and the outcome (succeeded / failed + reason).',
      params: IdParamSchema,
      response: { 200: successEnvelope(z.array(z.object({ id: z.string(), listingId: z.string(), syncJobId: z.string().nullable(), externalSku: z.string(), availableQuantity: z.number().int(), requestedQuantity: z.number().int(), status: z.enum(schema.STOCK_UPDATE_STATUSES), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), requestedAt: IsoDate, completedAt: IsoDate.nullable() }).meta({ id: 'ChannelStockUpdate' }))) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await svc.getListingDto(tx, vendorId, req.params.id); return recentStockUpdates(tx, vendorId, req.params.id); })));

  // ================================================================== taxonomy + mappings
  const AccountParams = IdParamSchema;
  r.get('/marketplace-accounts/:id/categories', {
    config: { access: { permission: 'listings:read' } },
    schema: {
      tags: MAPPINGS,
      summary: 'Search the marketplace category tree',
      description: 'Live lookup through the connector (capability `listings.categorySearch`, cached for a few minutes).',
      params: AccountParams,
      querystring: z.object({ query: z.string().trim().max(100).optional() }),
      response: { 200: successEnvelope(z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable(), leaf: z.boolean() }).meta({ id: 'MarketplaceCategory' }))) },
    },
  }, async (req) => {
    const cats = await searchMarketplaceCategories(c, requireVendor(req), req.params.id, req.query.query);
    return ok(req, cats.map((x) => ({ id: x.id, name: x.name, path: x.path ?? null, leaf: x.leaf })));
  });

  r.get('/marketplace-accounts/:id/categories/:categoryId/requirements', {
    config: { access: { permission: 'listings:read' } },
    schema: {
      tags: MAPPINGS,
      summary: 'What the marketplace category requires for a listing',
      params: z.object({ id: z.uuid(), categoryId: z.string().min(1).max(200) }),
      response: { 200: successEnvelope(z.array(RequirementSchema)) },
    },
  }, async (req) => ok(req, (await categoryRequirements(c, requireVendor(req), req.params.id, req.params.categoryId)) as never));

  r.get('/marketplace-accounts/:id/categories/:categoryId/mapping-suggestions', {
    config: { access: { permission: 'listings:read' } },
    schema: {
      tags: MAPPINGS,
      summary: 'Suggested attribute mappings for a marketplace category',
      description: 'For every requirement: the mapping you already saved, or a proposal (a core field, or a vendor attribute with the same name). Apply a proposal with PUT /attribute-mappings.',
      params: z.object({ id: z.uuid(), categoryId: z.string().min(1).max(200) }),
      response: { 200: successEnvelope(z.array(z.object({ requirement: RequirementSchema, existing: z.unknown().nullable(), suggestion: z.unknown().nullable() }))) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const acc = await vendorTx(req, (tx) => assertAccount(tx, vendorId, req.params.id));
    const reqs = await categoryRequirements(c, vendorId, req.params.id, req.params.categoryId);
    return ok(req, (await vendorTx(req, (tx) => suggestMappings(tx, vendorId, acc.marketplace, req.params.categoryId, reqs))) as never);
  });

  const CategoryMappingSchema = z.object({ id: z.string(), marketplace: z.string(), categoryId: z.string(), marketplaceCategoryId: z.string(), marketplaceCategoryName: z.string().nullable(), marketplaceCategoryPath: z.string().nullable(), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate }).meta({ id: 'CategoryMapping' });
  r.put('/category-mappings', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: MAPPINGS,
      summary: 'Map one of your categories to a marketplace category',
      description: 'Upsert per (marketplace, category). New listings of products in that category pick the marketplace category up automatically.',
      body: z.object({ marketplace: z.string().min(2).max(40), categoryId: z.uuid(), marketplaceCategoryId: z.string().trim().min(1).max(200), marketplaceCategoryName: z.string().max(200).nullish(), marketplaceCategoryPath: z.string().max(500).nullish() }),
      response: { 200: successEnvelope(CategoryMappingSchema) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const row = await upsertCategoryMapping(c, tx, vendorId, req.body);
    await audit(tx, req, { action: 'category_mapping.upsert', resourceType: 'category_mapping', resourceId: row.id, after: { marketplace: row.marketplace, categoryId: row.categoryId, marketplaceCategoryId: row.marketplaceCategoryId } });
    return toCategoryMappingDto(row);
  })));
  r.get('/category-mappings', {
    config: { access: { permission: 'listings:read' } },
    schema: { tags: MAPPINGS, summary: 'List category mappings', querystring: z.object({ 'filter[marketplace]': z.string().max(40).optional() }), response: { 200: successEnvelope(z.array(CategoryMappingSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => listCategoryMappings(tx, vendorId, req.query['filter[marketplace]']))).map(toCategoryMappingDto)));
  r.delete('/category-mappings/:id', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: MAPPINGS, summary: 'Delete a category mapping', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => { const row = await deleteCategoryMapping(tx, vendorId, req.params.id); await audit(tx, req, { action: 'category_mapping.delete', resourceType: 'category_mapping', resourceId: row.id }); });
    return ok(req, { id: req.params.id, deleted: true as const });
  });

  const AttributeMappingSchema = z.object({
    id: z.string(), marketplace: z.string(), marketplaceCategoryId: z.string(), marketplaceAttribute: z.string(), sourceType: z.enum(schema.MAPPING_SOURCE_TYPES), coreField: z.string().nullable(), attributeId: z.string().nullable(), staticValue: z.string().nullable(),
    valueMap: z.record(z.string(), z.string()), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
  }).meta({ id: 'AttributeMapping' });
  r.put('/attribute-mappings', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: MAPPINGS,
      summary: 'Map a marketplace attribute to a source',
      description: 'Per (marketplace, marketplace category, marketplace attribute). The source is a product/variant `core_field` (' + CORE_FIELDS.join(', ') + '), one of your `attribute` definitions, or a `static` value. `valueMap` translates your value into the marketplace\'s allowed value (e.g. {"Navy":"Blue"}).',
      body: z.object({
        marketplace: z.string().min(2).max(40), marketplaceCategoryId: z.string().trim().min(1).max(200), marketplaceAttribute: z.string().trim().min(1).max(100),
        source: z.discriminatedUnion('type', [z.object({ type: z.literal('core_field'), coreField: z.string().max(40) }), z.object({ type: z.literal('attribute'), attributeId: z.uuid() }), z.object({ type: z.literal('static'), value: z.string().min(1).max(500) })]),
        valueMap: z.record(z.string().max(200), z.string().max(200)).optional(),
      }),
      response: { 200: successEnvelope(AttributeMappingSchema) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const row = await upsertAttributeMapping(c, tx, vendorId, req.body);
    await audit(tx, req, { action: 'attribute_mapping.upsert', resourceType: 'attribute_mapping', resourceId: row.id, after: { marketplace: row.marketplace, attribute: row.marketplaceAttribute, source: row.sourceType } });
    return toAttributeMappingDto(row);
  })));
  r.get('/attribute-mappings', {
    config: { access: { permission: 'listings:read' } },
    schema: { tags: MAPPINGS, summary: 'List attribute mappings', querystring: z.object({ 'filter[marketplace]': z.string().max(40).optional(), 'filter[marketplaceCategoryId]': z.string().max(200).optional() }), response: { 200: successEnvelope(z.array(AttributeMappingSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => listAttributeMappings(tx, vendorId, { marketplace: req.query['filter[marketplace]'], marketplaceCategoryId: req.query['filter[marketplaceCategoryId]'] }))).map(toAttributeMappingDto)));
  r.delete('/attribute-mappings/:id', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: MAPPINGS, summary: 'Delete an attribute mapping', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => { const row = await deleteAttributeMapping(tx, vendorId, req.params.id); await audit(tx, req, { action: 'attribute_mapping.delete', resourceType: 'attribute_mapping', resourceId: row.id }); });
    return ok(req, { id: req.params.id, deleted: true as const });
  });

  // ================================================================== catalogue import
  r.post('/marketplace-accounts/:id/import-products', {
    config: { access: { permission: 'listings:write' } },
    schema: {
      tags: IMPORTS,
      summary: 'Import the products that already exist on the marketplace',
      description: 'Asynchronous (202). Fetches the marketplace catalogue page by page and stores each product in NORMALISED form (never the marketplace\'s own DTO). Review them under /imported-products, then create master products or link them to existing variants. Resumable after a failure.',
      params: IdParamSchema,
      response: { 202: successEnvelope(AsyncResult) },
    },
  }, async (req, reply) => accepted(req, reply, await requestImport(ctxOf(req), req.params.id)));

  const ImportedSchema = z.object({
    id: z.string(), marketplaceAccountId: z.string(), externalListingId: z.string(), externalSku: z.string(), title: z.string(), status: z.enum(['new', 'linked', 'ignored']), brand: z.string().nullable(),
    priceMinor: z.number().nullable(), mrpMinor: z.number().nullable(), currency: z.string(), quantity: z.number().nullable(), categoryId: z.string().nullable(), marketplaceStatus: z.string().nullable(), listingStatus: z.string(),
    variantId: z.string().nullable(), listingId: z.string().nullable(), suggestedMatch: z.object({ variantId: z.string(), sku: z.string() }).nullable().describe('A master variant with the same SKU, if one exists'), importedAt: IsoDate,
  }).meta({ id: 'ImportedProduct' });
  r.get('/imported-products', {
    config: { access: { permission: 'listings:read' } },
    schema: { tags: IMPORTS, summary: 'Imported (normalised) marketplace products', querystring: PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({ 'filter[accountId]': z.uuid().optional(), 'filter[status]': z.enum(['new', 'linked', 'ignored']).optional() }), response: { 200: paginatedEnvelope(ImportedSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => listImported(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, accountId: req.query['filter[accountId]'], status: req.query['filter[status]'], q: req.query.q }));
    return paginated(req, page.items, { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  const Linked = z.object({ importedProductId: z.string(), variantId: z.string(), listingId: z.string(), productId: z.string().optional(), openingStock: z.number().int().optional() });
  r.post('/imported-products/:id/create-product', {
    config: { access: { permission: 'products:write' } },
    schema: {
      tags: IMPORTS,
      summary: 'Create a MASTER product from an imported marketplace product',
      description: 'Marketplace Product -> Normalised Product -> Master Product. Creates the product + variant, and a tracked listing (already live, no publish). `initialQuantity` seeds opening stock through the ledger; without it no stock is invented and the marketplace quantity is NOT overwritten with zero.',
      params: IdParamSchema,
      body: z.object({ productCode: z.string().trim().min(1).max(64).optional(), initialQuantity: z.number().int().min(0).max(10_000_000).optional(), warehouseId: z.uuid().optional() }).default({}),
      response: { 201: successEnvelope(Linked) },
    },
  }, async (req, reply) => created(req, reply, await vendorTx(req, (tx, vendorId) => createMasterFromImported(tx, ctxFromRequest(req, vendorId), req.params.id, req.body)) as never));
  r.post('/imported-products/:id/link', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: IMPORTS, summary: 'Link an imported product to an existing master variant', params: IdParamSchema, body: z.object({ variantId: z.uuid() }), response: { 200: successEnvelope(Linked) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => linkImported(tx, ctxFromRequest(req, vendorId), req.params.id, req.body.variantId))) as never));
  r.post('/imported-products/:id/ignore', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: IMPORTS, summary: 'Ignore an imported product', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), status: z.literal('ignored') })) } },
  }, async (req) => {
    await vendorTx(req, (tx, vendorId) => ignoreImported(tx, ctxFromRequest(req, vendorId), req.params.id));
    return ok(req, { id: req.params.id, status: 'ignored' as const });
  });

  // ================================================================== channel inventory
  const PolicySchema = z.object({
    marketplaceAccountId: z.string(), mode: z.enum(schema.CHANNEL_INVENTORY_MODES).describe('paused = stop pushing quantities to this marketplace'),
    safetyBuffer: z.number().int().describe('Units always held back from this channel'), allocationPercent: z.number().int().describe('Share of available stock this channel may sell'),
    maxQuantity: z.number().int().nullable().describe('Hard cap per listing'), warehouseIds: z.array(z.string()).describe('Warehouses feeding this channel (empty = all active)'), isDefault: z.boolean(), version: z.number().int(), updatedAt: IsoDate.nullable(),
  }).meta({ id: 'ChannelInventoryPolicy' });
  r.get('/marketplace-accounts/:id/inventory-policy', {
    config: { access: { permission: 'listings:read' } },
    schema: { tags: CHANNEL, summary: 'Channel inventory policy', description: 'sellable = clamp( floor(available x allocation%) - buffer, 0, max ). Each marketplace gets its own number; nothing is "the same quantity everywhere".', params: IdParamSchema, response: { 200: successEnvelope(PolicySchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await assertAccount(tx, vendorId, req.params.id); return toPolicyDto(req.params.id, await getPolicy(tx, vendorId, req.params.id)); })));
  r.put('/marketplace-accounts/:id/inventory-policy', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: CHANNEL,
      summary: 'Set the channel inventory policy',
      description: 'Changing the policy recomputes and re-pushes every live listing of the account (one coalesced job).',
      params: IdParamSchema,
      body: z.object({ mode: z.enum(schema.CHANNEL_INVENTORY_MODES).optional(), safetyBuffer: z.number().int().min(0).max(1_000_000).optional(), allocationPercent: z.number().int().min(0).max(100).optional(), maxQuantity: z.number().int().min(0).max(10_000_000).nullable().optional(), warehouseIds: z.array(z.uuid()).max(100).optional() }),
      response: { 200: successEnvelope(PolicySchema) },
    },
  }, async (req) => ok(req, await savePolicy(ctxOf(req), req.params.id, req.body)));
  r.post('/marketplace-accounts/:id/inventory-sync', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: CHANNEL, summary: 'Recompute and push every live listing\'s quantity now', description: 'Asynchronous (202). Normally automatic (event-driven); use after a policy change, an outage, or to reconcile.', params: IdParamSchema, response: { 202: successEnvelope(AsyncResult) } },
  }, async (req, reply) => {
    const ctx = ctxOf(req);
    await vendorTx(req, async (tx, vendorId) => { await assertAccount(tx, vendorId, req.params.id); await (await import('./channel')).markDirty(tx, vendorId, { accountId: req.params.id }); });
    return accepted(req, reply, await requestInventorySync(c, ctx.vendorId, req.params.id, 'manual', ctx.actor.type === 'user' ? ctx.actor.id : null));
  });
  r.post('/marketplace-accounts/:id/refresh-listing-status', {
    config: { access: { permission: 'listings:write' } },
    schema: { tags: LISTINGS, summary: 'Check the status of every pending listing on the account', description: 'Asynchronous (202). Normally scheduled; this runs it now.', params: IdParamSchema, response: { 202: successEnvelope(AsyncResult) } },
  }, async (req, reply) => accepted(req, reply, await svc.requestStatusRefresh(ctxOf(req), req.params.id)));
};

export { fx };
