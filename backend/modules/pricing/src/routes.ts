import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema, type Tx } from '@oms/database';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { ok, opCtxFromRequest, requireVendor, vendorTx, type OpCtx } from '@oms/module-kit';
import { SyncWork, applyRules, bulkUpdate, clearMarketplacePrice, listHistory, listPrices, processSales, setMarketplacePrice, toPriceDto, variantPricing } from './service';

const Minor = z.number().int().min(1).max(100_000_000_000);
const PriceSchema = z.object({
  id: z.string(), variantId: z.string(), marketplaceAccountId: z.string(), priceMinor: z.number().int().nullable().describe('The marketplace price; null = follows the variant price'), mrpMinor: z.number().int().nullable(),
  sale: z.object({ priceMinor: z.number().int().nullable(), startsAt: IsoDate.nullable(), endsAt: IsoDate.nullable(), active: z.boolean() }),
  effectivePriceMinor: z.number().int().nullable().describe('What the marketplace should show right now (sale price while a sale runs)'), appliedPriceMinor: z.number().int().nullable(), appliedAt: IsoDate.nullable(), source: z.enum(schema.PRICE_SOURCES), version: z.number().int(), updatedAt: IsoDate,
}).meta({ id: 'MarketplacePrice' });
const SyncInfo = z.array(z.object({ accountId: z.string(), skipped: z.string().optional() })).describe('Price pushes queued; `skipped` when the connector cannot take prices');
const Change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), value: Minor }).describe('Set the price (minor units)'),
  z.object({ kind: z.literal('percent'), value: z.number().min(-90).max(1000) }).describe('Change by a percentage (negative = reduce)'),
  z.object({ kind: z.literal('amount'), value: z.number().int().min(-100_000_000).max(100_000_000) }).describe('Add/subtract an amount (minor units)'),
]);
const HistorySchema = z.object({ id: z.number().int(), variantId: z.string(), marketplaceAccountId: z.string().nullable(), field: z.enum(schema.PRICE_FIELDS), oldPriceMinor: z.number().int().nullable(), newPriceMinor: z.number().int().nullable(), source: z.enum(schema.PRICE_SOURCES), ruleId: z.string().nullable(), batchId: z.string().nullable(), reason: z.string().nullable(), actorId: z.string().nullable(), createdAt: IsoDate });

/**
 * Pricing: base price (on the variant) + per-marketplace prices, sales, rule-driven prices, bulk updates and history. Marketplaces do
 * not share one pricing API: the connector decides if it can take a price (`pricing.push`); where it cannot, the price is still
 * recorded here and the response says the push was skipped.
 */
export const pricingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Pricing'];
  /** one request = one transaction; price pushes are queued only after it commits */
  async function run<T>(req: FastifyRequest, fn: (tx: Tx, ctx: OpCtx, work: SyncWork) => Promise<T>): Promise<{ out: T; sync: Awaited<ReturnType<SyncWork['flush']>> }> {
    const vendorId = requireVendor(req);
    const work = new SyncWork();
    const ctx = opCtxFromRequest(req, vendorId);
    const out = await vendorTx(req, (tx) => fn(tx, ctx, work));
    return { out, sync: await work.flush(req.server.container, vendorId) };
  }

  r.get('/pricing/variants/:id', {
    config: { access: { permission: 'pricing:read' } },
    schema: { tags: TAGS, summary: 'All prices of a variant', description: 'Base price, cost, MRP and every marketplace price with its sale and effective price.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ variantId: z.string(), sku: z.string(), currency: z.string(), baseMinor: z.number().int().nullable(), mrpMinor: z.number().int().nullable(), costMinor: z.number().int().nullable(), marketplacePrices: z.array(PriceSchema) })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => variantPricing(tx, vendorId, req.params.id))));

  r.get('/pricing/marketplace-prices', {
    config: { access: { permission: 'pricing:read' } },
    schema: { tags: TAGS, summary: 'List marketplace prices', querystring: z.object({ 'filter[accountId]': z.uuid().optional(), 'filter[variantId]': z.uuid().optional(), 'filter[sale]': z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), after: z.string().optional() }), response: { 200: successEnvelope(z.object({ items: z.array(PriceSchema), nextAfter: z.string().nullable() })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listPrices(tx, vendorId, { accountId: req.query['filter[accountId]'], variantId: req.query['filter[variantId]'], saleOnly: req.query['filter[sale]'], limit: req.query.limit, after: req.query.after }))));

  r.put('/pricing/marketplace-prices', {
    config: { access: { permission: 'pricing:write' } },
    schema: {
      tags: TAGS, summary: 'Set a marketplace price (and optionally a scheduled sale)',
      description: 'Omitted fields are unchanged; `null` clears. The price must not exceed the MRP and a sale must not exceed the regular price. A sale with `saleStartsAt` / `saleEndsAt` starts and ends by itself, exactly once. The listing is updated and a price push is queued when the marketplace\'s connector supports it.',
      body: z.object({ variantId: z.uuid(), accountId: z.uuid(), priceMinor: Minor.nullish(), mrpMinor: Minor.nullish(), salePriceMinor: Minor.nullish(), saleStartsAt: z.coerce.date().nullish(), saleEndsAt: z.coerce.date().nullish(), reason: z.string().max(200).nullish() }),
      response: { 200: successEnvelope(z.object({ price: PriceSchema, pushed: SyncInfo })) },
    },
  }, async (req) => {
    const { out, sync } = await run(req, async (tx, ctx, work) => (await setMarketplacePrice(tx, ctx, work, { ...req.body, source: 'manual' })).row);
    return ok(req, { price: toPriceDto(out), pushed: sync });
  });

  r.delete('/pricing/marketplace-prices/:id', {
    config: { access: { permission: 'pricing:write' } },
    schema: { tags: TAGS, summary: 'Remove a marketplace price (the listing follows the variant price again)', params: IdParamSchema, response: { 200: successEnvelope(z.object({ pushed: SyncInfo })) } },
  }, async (req) => { const { sync } = await run(req, (tx, ctx, work) => clearMarketplacePrice(tx, ctx, work, req.params.id)); return ok(req, { pushed: sync }); });

  r.post('/pricing/bulk-update', {
    config: { access: { permission: 'pricing:write' } },
    schema: {
      tags: TAGS, summary: 'Bulk price update (set / % / amount)',
      description: 'Select variants by `variantIds` or by `accountId` (everything listed there). `field: base` changes the variant price (all marketplaces that follow it); `field: marketplace` changes one account\'s price. Use `dryRun: true` first: it lists every old/new price and what would be skipped (e.g. above MRP) without changing anything. A real run is one batch (`batchId` in the history).',
      body: z.object({ field: z.enum(['base', 'marketplace']), accountId: z.uuid().optional(), variantIds: z.array(z.uuid()).max(1000).optional(), change: Change, dryRun: z.boolean().default(true), reason: z.string().max(200).nullish() }),
      response: { 200: successEnvelope(z.object({
        batchId: z.string().nullable(), dryRun: z.boolean(), total: z.number().int(), changed: z.number().int(), unchanged: z.number().int(), skipped: z.number().int(),
        items: z.array(z.object({ variantId: z.string(), sku: z.string(), accountId: z.string().nullable(), field: z.enum(['base', 'marketplace']), oldMinor: z.number().int().nullable(), newMinor: z.number().int().nullable(), status: z.enum(['changed', 'unchanged', 'skipped']), reason: z.string().optional() })), pushed: SyncInfo,
      })) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const work = new SyncWork();
    const res = await bulkUpdate(opCtxFromRequest(req, vendorId), work, req.body);
    return ok(req, { ...res, pushed: await work.flush(req.server.container, vendorId) });
  });

  r.post('/pricing/apply-rules', {
    config: { access: { permission: 'pricing:write' } },
    schema: {
      tags: TAGS, summary: 'Price an account\'s variants from the pricing rules', description: 'Base price + matching rules (see /rules/types for the pricing actions). `dryRun` shows the steps taken for each variant. Prices set this way are marked `source: rule` and are recomputed when the base price changes.',
      body: z.object({ accountId: z.uuid(), variantIds: z.array(z.uuid()).max(1000).optional(), dryRun: z.boolean().default(true) }),
      response: { 200: successEnvelope(z.object({ dryRun: z.boolean(), total: z.number().int(), changed: z.number().int(), items: z.array(z.object({ variantId: z.string(), sku: z.string(), baseMinor: z.number().int(), oldMinor: z.number().int().nullable(), newMinor: z.number().int().nullable(), ruleIds: z.array(z.string()), steps: z.array(z.string()), status: z.enum(['changed', 'unchanged', 'no_rule', 'skipped']), belowMargin: z.boolean().optional(), reason: z.string().optional() })), pushed: SyncInfo })) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const work = new SyncWork();
    const res = await applyRules(opCtxFromRequest(req, vendorId), work, req.body);
    return ok(req, { ...res, pushed: await work.flush(req.server.container, vendorId) });
  });

  r.post('/pricing/sales/process', {
    config: { access: { permission: 'pricing:write' } },
    schema: { tags: TAGS, summary: 'Start / end due sales now', description: 'Normally done by the scheduler every minute; this runs it on demand. Exactly-once per sale.', response: { 200: successEnvelope(z.object({ started: z.number().int(), ended: z.number().int() })) } },
  }, async (req) => ok(req, await processSales(req.server.container)));

  r.get('/pricing/history', {
    config: { access: { permission: 'pricing:read' } },
    schema: {
      tags: TAGS, summary: 'Price history', description: 'Append-only. `field`: base | mrp | marketplace | sale. `marketplaceAccountId: null` = the variant\'s own price.',
      querystring: z.object({ 'filter[variantId]': z.uuid().optional(), 'filter[accountId]': z.uuid().optional(), 'filter[batchId]': z.string().optional(), 'filter[field]': z.enum(schema.PRICE_FIELDS).optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: successEnvelope(z.object({ items: z.array(HistorySchema), nextBefore: z.number().int().nullable() })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listHistory(tx, vendorId, { variantId: req.query['filter[variantId]'], accountId: req.query['filter[accountId]'], batchId: req.query['filter[batchId]'], field: req.query['filter[field]'], before: req.query.before, limit: req.query.limit }))));
};


