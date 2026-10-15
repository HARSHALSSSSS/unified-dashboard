import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, schema, sql, withVendor } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { audit, ok, requireVendor, vendorTx } from '@oms/module-kit';
import { businessHealth, DEFAULT_THRESHOLDS, inventoryHealth, productHealth } from './health';
import { profitability } from './profit';
import { marketplacePerformance, overview, productPerformance } from './queries';
import { day, rollupVendor } from './rollup';

const DAY = 86_400_000;
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const RangeQuery = z.object({ from: D.optional().describe('First day (UTC), default: 29 days before `to`'), to: D.optional().describe('Last day (UTC), default: today'), refresh: z.coerce.boolean().optional().describe('Recompute the last two days from the orders first (the roll-up job also does this every 15 minutes)') });
const range = (q: { from?: string; to?: string }, maxDays = 366) => {
  const to = q.to ?? day(new Date());
  const from = q.from ?? day(new Date(Date.parse(to) - 29 * DAY));
  const span = (Date.parse(to) - Date.parse(from)) / DAY;
  if (span < 0) throw new AppError('BAD_REQUEST', '`from` must not be after `to`');
  if (span > maxDays) throw new AppError('BAD_REQUEST', `A range is at most ${maxDays + 1} days`);
  return { from, to };
};
const Money = z.number().int();
const TAGS = ['Analytics'];
const Comp = z.object({ amountMinor: Money.nullable(), basis: z.enum(['actual', 'estimated', 'missing']), coverage: z.number() });
const ProfitBody = z.object({
  revenue: Comp, productCost: Comp, shipping: Comp, marketplaceFees: Comp, penalties: Comp, refunds: Comp, contributionMinor: Money.nullable().describe('Only present when NO component is missing'), knownPartMinor: Money.describe('Revenue minus the components that are known (not a profit figure while data is missing)'),
  marginPercent: z.number().nullable(), missing: z.array(z.string()), completeness: z.enum(['complete', 'estimated', 'incomplete']),
});
const Issue = z.object({ code: z.string(), message: z.string() });
const Finding = z.object({ variantId: z.string(), sku: z.string(), title: z.string().nullable(), flags: z.array(z.string()), available: z.number().int(), onHand: z.number().int(), reserved: z.number().int(), reorderLevel: z.number().int().nullable(), unitsPerDay: z.number(), daysOfCover: z.number().nullable(), stockoutDate: z.string().nullable(), ageDays: z.number().int().nullable(), suggestedReorderUnits: z.number().int().nullable() });

/** Analytics: read APIs over the aggregation layer, plus profitability, product / inventory / business health. */
export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const freshen = async (vendorId: string, refresh?: boolean) => { if (refresh) await rollupVendor(c, vendorId, { from: day(new Date(Date.now() - DAY)), to: day(new Date()) }); };

  r.get('/analytics/overview', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Business overview (sales, orders, revenue) vs the previous period', description: 'Served from the daily roll-up, not the operational tables. Days are UTC.',
      querystring: RangeQuery,
      response: { 200: successEnvelope(z.object({
        range: z.object({ from: z.string(), to: z.string() }), previousRange: z.object({ from: z.string(), to: z.string() }),
        kpis: z.record(z.string(), z.object({ value: Money, previous: Money, changePercent: z.number().nullable() })),
        rates: z.object({ cancellationRate: z.number(), returnRate: z.number(), deliveredShare: z.number() }), fulfillment: z.object({ shipped: z.number().int(), avgHoursToShip: z.number().nullable() }),
        refundsMinor: Money, discountsMinor: Money, series: z.array(z.object({ day: z.string(), orders: z.number().int(), revenueMinor: Money, units: z.number().int() })),
      })) },
    },
  }, async (req) => { const vendorId = requireVendor(req); await freshen(vendorId, req.query.refresh); return ok(req, await vendorTx(req, (tx) => overview(tx, vendorId, range(req.query)))); });

  r.get('/analytics/products', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Product performance (units, revenue, returns, trend)', querystring: RangeQuery.extend({ sort: z.enum(['revenue', 'units', 'returns']).default('revenue'), limit: z.coerce.number().int().min(1).max(200).default(25) }),
      response: { 200: successEnvelope(z.array(z.object({ variantId: z.string(), sku: z.string(), title: z.string().nullable(), units: z.number().int(), revenueMinor: Money, returnedUnits: z.number().int(), returnRate: z.number(), unitsChangePercent: z.number().nullable() }))) },
    },
  }, async (req) => { const vendorId = requireVendor(req); await freshen(vendorId, req.query.refresh); return ok(req, await vendorTx(req, (tx) => productPerformance(tx, vendorId, range(req.query), { sort: req.query.sort, limit: req.query.limit }))); });

  r.get('/analytics/marketplaces', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Marketplace performance and connection health', querystring: RangeQuery,
      response: { 200: successEnvelope(z.array(z.object({ marketplace: z.string(), orders: z.number().int(), revenueMinor: Money, units: z.number().int(), cancellationRate: z.number(), returnRate: z.number(), refundMinor: Money, accounts: z.number().int(), unhealthyAccounts: z.number().int(), listings: z.record(z.string(), z.number().int()), syncJobs7d: z.number().int(), syncFailureRate7d: z.number() }))) },
    },
  }, async (req) => { const vendorId = requireVendor(req); await freshen(vendorId, req.query.refresh); return ok(req, await vendorTx(req, (tx) => marketplacePerformance(tx, vendorId, range(req.query)))); });

  r.get('/analytics/inventory-health', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Inventory health: low stock, stockout risk, excess, aging, fast and slow movers',
      description: 'Velocity = units actually sold over `windowDays`; days of cover = available stock / velocity. With no sales there is no forecast (null), never an invented one.',
      querystring: z.object({ windowDays: z.coerce.number().int().min(7).max(180).default(DEFAULT_THRESHOLDS.windowDays), riskDays: z.coerce.number().int().min(1).max(60).default(DEFAULT_THRESHOLDS.riskDays), excessDays: z.coerce.number().int().min(30).max(720).default(DEFAULT_THRESHOLDS.excessDays), agingDays: z.coerce.number().int().min(30).max(720).default(DEFAULT_THRESHOLDS.agingDays), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: successEnvelope(z.object({
        thresholds: z.record(z.string(), z.number()), asOf: IsoDate, skusAnalysed: z.number().int(), counts: z.record(z.string(), z.number().int()),
        outOfStock: z.array(Finding), lowStock: z.array(Finding), stockoutRisk: z.array(Finding), excess: z.array(Finding), aging: z.array(Finding), fastMoving: z.array(Finding), slowMoving: z.array(Finding),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => inventoryHealth(tx, vendorId, { ...DEFAULT_THRESHOLDS, windowDays: req.query.windowDays, riskDays: req.query.riskDays, excessDays: req.query.excessDays, agingDays: req.query.agingDays }, req.query.limit))));

  r.get('/analytics/product-health', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Product health: completeness, listing errors, inventory and marketplace issues', querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: successEnvelope(z.object({
        products: z.number().int(), averageScore: z.number().nullable(), complete: z.number().int(), issueCounts: z.record(z.string(), z.number().int()), openOrderLinesWithUnmappedSku: z.number().int(), activeListingsWithoutStock: z.number().int(),
        lowestScoring: z.array(z.object({ variantId: z.string(), productId: z.string(), sku: z.string(), title: z.string(), score: z.number().int(), issues: z.array(Issue) })),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => productHealth(tx, vendorId, req.query.limit))));

  r.get('/analytics/business-health', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Business health: operational bottlenecks and failures', description: 'Order, fulfillment, shipping, return, marketplace, sync and inventory problems found right now, each with a count, severity and sample ids; plus an overall score.',
      response: { 200: successEnvelope(z.object({ score: z.number().int(), grade: z.enum(['healthy', 'needs_attention', 'at_risk']), generatedAt: IsoDate, issues: z.array(z.object({ code: z.string(), area: z.string(), severity: z.enum(['info', 'warning', 'critical']), count: z.number().int(), message: z.string(), sampleIds: z.array(z.string()) })) })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => businessHealth(tx, vendorId))));

  r.get('/analytics/profitability', {
    config: { access: { permission: 'analytics:read' } },
    schema: {
      tags: TAGS, summary: 'Profitability by product, marketplace or order, with actual / estimated / missing data kept apart',
      description: 'Revenue and discounts are actual; shipping is the courier cost recorded on the shipment; fees and penalties come from `PUT /orders/{id}/financials` (fees may fall back to a vendor-entered fee profile, labelled estimated); product cost is the variant\'s CURRENT cost price (estimated). `contributionMinor` is null while any component is missing: nothing is guessed.',
      querystring: z.object({ from: D.optional(), to: D.optional(), groupBy: z.enum(['product', 'marketplace', 'order']).default('product') }),
      response: { 200: successEnvelope(z.object({
        range: z.object({ from: z.string(), to: z.string() }), groupBy: z.string(), ordersAnalysed: z.number().int(), truncated: z.boolean().describe('More orders than the analysis limit: narrow the range'), allocation: z.string().nullable(),
        total: ProfitBody, groups: z.array(ProfitBody.extend({ key: z.string(), label: z.string(), orders: z.number().int() })),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => profitability(tx, vendorId, range(req.query, 92), req.query.groupBy))));

  // ---------------------------------------------------------------- the financial facts profitability rests on
  const Fin = z.object({ orderId: z.string(), marketplaceFeeMinor: Money.nullable(), penaltyMinor: Money.nullable(), otherCostMinor: Money.nullable(), notes: z.string().nullable(), updatedAt: IsoDate }).meta({ id: 'OrderFinancials' });
  const toFin = (f: typeof schema.orderFinancials.$inferSelect) => ({ orderId: f.orderId, marketplaceFeeMinor: f.marketplaceFeeMinor, penaltyMinor: f.penaltyMinor, otherCostMinor: f.otherCostMinor, notes: f.notes, updatedAt: f.updatedAt.toISOString() });

  r.get('/orders/:id/financials', {
    config: { access: { permission: 'orders:read' } },
    schema: { tags: TAGS, summary: 'Marketplace fee / penalty / other costs recorded for an order (null = unknown)', params: IdParamSchema, response: { 200: successEnvelope(Fin.nullable()) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    if (!(await tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.id, req.params.id), eq(schema.orders.vendorId, vendorId))))[0]) throw Errors.notFound('Order', req.params.id);
    const [f] = await tx.select().from(schema.orderFinancials).where(and(eq(schema.orderFinancials.orderId, req.params.id), eq(schema.orderFinancials.vendorId, vendorId)));
    return f ? toFin(f) : null;
  })));

  r.put('/orders/:id/financials', {
    config: { access: { permission: 'orders:write' } },
    schema: {
      tags: TAGS, summary: 'Record what the marketplace actually charged for an order', description: 'Omitted fields are unchanged; `null` clears a value back to "unknown". These are ACTUAL figures: profitability trusts them.',
      params: IdParamSchema, body: z.object({ marketplaceFeeMinor: z.number().int().min(0).max(1_000_000_000).nullish(), penaltyMinor: z.number().int().min(0).max(1_000_000_000).nullish(), otherCostMinor: z.number().int().min(0).max(1_000_000_000).nullish(), notes: z.string().max(500).nullish() }),
      response: { 200: successEnvelope(Fin) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    if (!(await tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.id, req.params.id), eq(schema.orders.vendorId, vendorId))))[0]) throw Errors.notFound('Order', req.params.id);
    const [cur] = await tx.select().from(schema.orderFinancials).where(eq(schema.orderFinancials.orderId, req.params.id));
    const pick = <T>(n: T | undefined, c: T | null | undefined): T | null => (n !== undefined ? n : c ?? null) as T | null;
    const v = { marketplaceFeeMinor: pick(req.body.marketplaceFeeMinor, cur?.marketplaceFeeMinor), penaltyMinor: pick(req.body.penaltyMinor, cur?.penaltyMinor), otherCostMinor: pick(req.body.otherCostMinor, cur?.otherCostMinor), notes: pick(req.body.notes, cur?.notes), updatedBy: req.ctx.principal?.actorId ?? null };
    const [row] = await tx.insert(schema.orderFinancials).values({ vendorId, orderId: req.params.id, ...v }).onConflictDoUpdate({ target: schema.orderFinancials.orderId, set: v }).returning();
    await audit(tx, req, { action: 'order.financials_set', resourceType: 'order', resourceId: req.params.id, before: cur ? { fee: cur.marketplaceFeeMinor, penalty: cur.penaltyMinor, other: cur.otherCostMinor } : null, after: { fee: v.marketplaceFeeMinor, penalty: v.penaltyMinor, other: v.otherCostMinor } });
    return toFin(row!);
  })));

  const Fee = z.object({ marketplaceAccountId: z.string(), feePercentBps: z.number().int(), fixedFeeMinor: Money, label: z.string().nullable() }).meta({ id: 'FeeProfile' });
  r.get('/analytics/fee-profiles', {
    config: { access: { permission: 'analytics:read' } },
    schema: { tags: TAGS, summary: 'Commission terms per marketplace account (used for ESTIMATED fees only)', response: { 200: successEnvelope(z.array(Fee)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => tx.select().from(schema.feeProfiles).where(eq(schema.feeProfiles.vendorId, vendorId)))).map((f) => ({ marketplaceAccountId: f.marketplaceAccountId, feePercentBps: f.feePercentBps, fixedFeeMinor: f.fixedFeeMinor, label: f.label }))));

  r.put('/analytics/fee-profiles/:id', {
    config: { access: { permission: 'pricing:write' } },
    schema: { tags: TAGS, summary: 'Set the commission terms of a marketplace account', description: '`:id` is the marketplace account id. 100 bps = 1%.', params: IdParamSchema, body: z.object({ feePercentBps: z.number().int().min(0).max(10_000), fixedFeeMinor: z.number().int().min(0).max(100_000_000).default(0), label: z.string().max(80).nullish() }), response: { 200: successEnvelope(Fee) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    if (!(await tx.select({ id: schema.marketplaceAccounts.id }).from(schema.marketplaceAccounts).where(and(eq(schema.marketplaceAccounts.id, req.params.id), eq(schema.marketplaceAccounts.vendorId, vendorId))))[0]) throw Errors.notFound('Marketplace account', req.params.id);
    const v = { feePercentBps: req.body.feePercentBps, fixedFeeMinor: req.body.fixedFeeMinor, label: req.body.label ?? null };
    const [row] = await tx.insert(schema.feeProfiles).values({ vendorId, marketplaceAccountId: req.params.id, ...v }).onConflictDoUpdate({ target: schema.feeProfiles.marketplaceAccountId, set: v }).returning();
    await audit(tx, req, { action: 'analytics.fee_profile_set', resourceType: 'marketplace_account', resourceId: req.params.id, after: v });
    return { marketplaceAccountId: row!.marketplaceAccountId, feePercentBps: row!.feePercentBps, fixedFeeMinor: row!.fixedFeeMinor, label: row!.label };
  })));

  r.post('/analytics/rollups/rebuild', {
    config: { access: { permission: 'sync:write' } },
    schema: { tags: TAGS, summary: 'Rebuild the daily roll-ups for a date range (backfill after a late import or correction)', description: 'Idempotent. At most 400 days; built in slices.', body: z.object({ from: D, to: D }), response: { 200: successEnvelope(z.object({ from: z.string(), to: z.string(), rebuilt: z.literal(true) })) } },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const w = range(req.body, 400);
    await rollupVendor(c, vendorId, w);
    await withVendor(c.database.db, vendorId, (tx) => tx.execute(sql`select 1`));
    return ok(req, { ...w, rebuilt: true as const });
  });
};
