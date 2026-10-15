import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '@oms/shared';
import { IsoDate, successEnvelope } from '@oms/contracts';
import { ok, vendorTx } from '@oms/module-kit';
import { fulfillmentReport, inventoryReport, marketplacesReport, ordersReport, productsReport, returnsReport, salesReport, type Window } from './queries';

const DAY = 86_400_000;
const WindowQuery = z.object({
  from: z.coerce.date().optional().describe('Start of the window (default: 30 days ago)'),
  to: z.coerce.date().optional().describe('End of the window, exclusive (default: now)'),
});
const win = (q: { from?: Date; to?: Date }): Window => {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 30 * DAY);
  if (from >= to) throw new AppError('BAD_REQUEST', '`from` must be before `to`');
  if (to.getTime() - from.getTime() > 366 * DAY) throw new AppError('BAD_REQUEST', 'A report window is at most 366 days');
  return { from, to };
};
const Period = z.enum(['day', 'week', 'month']).default('day');
const WindowOut = z.object({ from: IsoDate, to: IsoDate });
const Series = (extra: z.ZodRawShape) => z.array(z.object({ bucket: IsoDate, ...extra }));
const Money = z.number().int();

/** Reports: tenant-scoped read APIs over the operational tables. Money in minor units. */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Reports'];

  r.get('/reports/sales', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Sales report', description: 'Orders placed in the window, cancelled orders excluded. Totals, a time series (`period`), and the split by marketplace and payment method.',
      querystring: WindowQuery.extend({ period: Period, marketplace: z.string().max(40).optional() }),
      response: { 200: successEnvelope(z.object({
        window: WindowOut, period: z.string(),
        totals: z.object({ orders: z.number().int(), units: z.number().int(), subtotalMinor: Money, taxMinor: Money, shippingMinor: Money, discountMinor: Money, grossMinor: Money, averageOrderValueMinor: Money }),
        series: Series({ orders: z.number().int(), grossMinor: Money }), byMarketplace: z.array(z.object({ marketplace: z.string(), orders: z.number().int(), grossMinor: Money })), byPaymentMethod: z.array(z.object({ method: z.string(), orders: z.number().int(), grossMinor: Money })),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => salesReport(tx, vendorId, win(req.query), { period: req.query.period, marketplace: req.query.marketplace }))));

  r.get('/reports/orders', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Order report', description: 'Volume by status and marketplace, cancellation rate and reasons, orders needing attention, and the average time from order to dispatch and to delivery.',
      querystring: WindowQuery.extend({ period: Period, marketplace: z.string().max(40).optional() }),
      response: { 200: successEnvelope(z.object({
        window: WindowOut, period: z.string(),
        totals: z.object({ orders: z.number().int(), cancelled: z.number().int(), cancellationRate: z.number(), needingAttention: z.number().int(), avgHoursToDispatch: z.number().nullable(), avgHoursToDeliver: z.number().nullable() }),
        byStatus: z.array(z.object({ status: z.string(), orders: z.number().int() })), byMarketplace: z.array(z.object({ marketplace: z.string(), orders: z.number().int(), cancelled: z.number().int() })),
        cancellationReasons: z.array(z.object({ reasonCode: z.string(), initiator: z.string(), count: z.number().int() })), series: Series({ orders: z.number().int(), cancelled: z.number().int() }),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => ordersReport(tx, vendorId, win(req.query), { period: req.query.period, marketplace: req.query.marketplace }))));

  r.get('/reports/inventory', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Inventory report', description: 'A snapshot of stock now (on hand, reserved, available, damaged, returned, value at cost, out-of-stock and low-stock counts, per warehouse) plus the ledger activity in the window and the SKUs at or below their reorder level.',
      querystring: WindowQuery.extend({ warehouseId: z.uuid().optional() }),
      response: { 200: successEnvelope(z.object({
        asOf: IsoDate, window: WindowOut,
        totals: z.object({ onHand: z.number().int(), reserved: z.number().int(), available: z.number().int(), incoming: z.number().int(), damaged: z.number().int(), returned: z.number().int(), stockValueMinor: Money, stockLines: z.number().int(), outOfStock: z.number().int(), lowStock: z.number().int() }),
        byWarehouse: z.array(z.object({ warehouseId: z.string(), code: z.string(), name: z.string(), onHand: z.number().int(), reserved: z.number().int(), damaged: z.number().int(), returned: z.number().int(), stockValueMinor: Money })),
        movements: z.array(z.object({ type: z.string(), count: z.number().int(), deltaOnHand: z.number().int(), deltaReserved: z.number().int() })),
        lowStock: z.array(z.object({ variantId: z.string(), sku: z.string(), warehouseId: z.string(), available: z.number().int(), reorderLevel: z.number().int() })),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => inventoryReport(tx, vendorId, win(req.query), { warehouseId: req.query.warehouseId }))));

  r.get('/reports/products', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Product performance', description: 'Best sellers by revenue or units with their return rate.',
      querystring: WindowQuery.extend({ marketplace: z.string().max(40).optional(), sort: z.enum(['revenue', 'units']).default('revenue'), limit: z.coerce.number().int().min(1).max(200).default(20) }),
      response: { 200: successEnvelope(z.object({ window: WindowOut, skusSold: z.number().int(), products: z.array(z.object({ variantId: z.string().nullable(), sku: z.string(), title: z.string(), units: z.number().int(), orders: z.number().int(), revenueMinor: Money, returnedUnits: z.number().int(), returnRate: z.number() })) })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => productsReport(tx, vendorId, win(req.query), { marketplace: req.query.marketplace, sort: req.query.sort, limit: req.query.limit }))));

  r.get('/reports/marketplaces', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Marketplace performance', description: 'Per connected account: orders, revenue, cancellation and return rates, listings by status and sync health.',
      querystring: WindowQuery,
      response: { 200: successEnvelope(z.object({ window: WindowOut, accounts: z.array(z.object({
        accountId: z.string(), marketplace: z.string(), displayName: z.string().nullable(), status: z.string(), orders: z.number().int(), revenueMinor: Money, cancelled: z.number().int(), cancellationRate: z.number(), returns: z.number().int(), returnRate: z.number(),
        listings: z.record(z.string(), z.number().int()), syncJobs: z.number().int(), syncFailures: z.number().int(), syncFailureRate: z.number(),
      })) })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => marketplacesReport(tx, vendorId, win(req.query)))));

  r.get('/reports/returns', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Returns report', description: 'Returns by status, source and reason; units received / restocked / decided; dispositions; refunds; return rate and processing times.',
      querystring: WindowQuery,
      response: { 200: successEnvelope(z.object({
        window: WindowOut,
        totals: z.object({ returns: z.number().int(), unitsRequested: z.number().int(), unitsReceived: z.number().int(), unitsRestocked: z.number().int(), unitsDecided: z.number().int(), unitReturnRate: z.number(), avgDaysToReceive: z.number().nullable(), avgDaysToComplete: z.number().nullable() }),
        byStatus: z.array(z.object({ status: z.string(), count: z.number().int() })), bySource: z.array(z.object({ source: z.string(), count: z.number().int() })), byReason: z.array(z.object({ reasonCode: z.string(), count: z.number().int() })),
        dispositions: z.array(z.object({ disposition: z.string(), units: z.number().int() })), refunds: z.array(z.object({ status: z.string(), count: z.number().int(), amountMinor: Money })),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => returnsReport(tx, vendorId, win(req.query)))));

  r.get('/reports/fulfillment', {
    config: { access: { permission: 'reports:read' } },
    schema: {
      tags: TAGS, summary: 'Fulfillment report', description: 'Warehouse speed (pick / pack / ship times, per warehouse), exceptions, shipments by status and carrier, on-time delivery, NDR and RTO rates.',
      querystring: WindowQuery.extend({ warehouseId: z.uuid().optional() }),
      response: { 200: successEnvelope(z.object({
        window: WindowOut,
        totals: z.object({ fulfillments: z.number().int(), avgHoursToPick: z.number().nullable(), avgHoursToPack: z.number().nullable(), avgHoursToShip: z.number().nullable(), avgHoursToDeliver: z.number().nullable() }),
        byStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
        byWarehouse: z.array(z.object({ warehouseId: z.string(), code: z.string(), fulfillments: z.number().int(), shipped: z.number().int(), avgHoursToPick: z.number().nullable(), avgHoursToPack: z.number().nullable(), avgHoursToShip: z.number().nullable() })),
        exceptions: z.array(z.object({ kind: z.string(), status: z.string(), count: z.number().int() })),
        shipping: z.object({ byStatus: z.array(z.object({ status: z.string(), count: z.number().int() })), byCarrier: z.array(z.object({ carrier: z.string(), count: z.number().int() })), delivered: z.number().int(), dispatched: z.number().int(), rto: z.number().int(), rtoRate: z.number(), onTimeRate: z.number(), ndrCases: z.number().int(), openNdr: z.number().int() }),
      })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => fulfillmentReport(tx, vendorId, win(req.query), { warehouseId: req.query.warehouseId }))));
};
