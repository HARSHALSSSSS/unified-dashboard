import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema, withVendor } from '@oms/database';
import { ORDER_STATUSES } from '@oms/marketplace-core';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, sortQuery, successEnvelope } from '@oms/contracts';
import { ok, opCtxFromRequest, paginated, requireVendor, vendorTx } from '@oms/module-kit';
import { SyncJobSchema, dispatchSyncJob, toSyncJobDto } from '@oms/mod-sync';
import { getAccountRow } from '@oms/mod-marketplace-accounts';
import { requestOrderSync } from './runners';
import { CANCELLATION_REASONS, REASON_CODES, decideCancellation, listCancellations, requestCancellation } from './cancellations';
import { allocateOrder, getOrderDetail, listOrders, listStatusUpdates, orderSummary, orderTimeline, transitionOrder } from './service';
import { retryStatusUpdate, toStatusUpdateDto } from './status';

const Money = z.number().int();
const OrderItemSchema = z.object({
  id: z.string(), externalItemId: z.string(), externalListingId: z.string().nullable(), sku: z.string(), title: z.string(), quantity: z.number().int(), reservedQuantity: z.number().int().describe('Units held in inventory for this line (< quantity = short)'),
  unitPriceMinor: Money, taxMinor: Money, discountMinor: Money, status: z.enum(schema.ORDER_ITEM_STATUSES), variantId: z.string().nullable().describe('null = the marketplace SKU is not mapped to a master variant yet'), listingId: z.string().nullable(),
});
export const OrderSchema = z
  .object({
    id: z.string(), orderNumber: z.string().describe('Our internal order number (per vendor)'), marketplace: z.string(), marketplaceAccountId: z.string(), externalOrderId: z.string().describe('The marketplace\'s own order id'),
    status: z.enum(ORDER_STATUSES).describe('Normalised status: new, confirmed, picking, packed, ready_to_dispatch, dispatched, in_transit, delivered, cancelled, returned'),
    marketplaceStatus: z.string().nullable().describe('The marketplace\'s own status word, verbatim'), statusChangedAt: IsoDate, placedAt: IsoDate, currency: z.string(),
    subtotalMinor: Money, taxMinor: Money, shippingMinor: Money, discountMinor: Money, totalMinor: Money,
    customer: z.record(z.string(), z.unknown()), shippingAddress: z.record(z.string(), z.unknown()),
    payment: z.object({ method: z.enum(['prepaid', 'cod', 'unknown']), status: z.string(), codAmountMinor: Money.nullable() }),
    inventoryStatus: z.enum(schema.ORDER_INVENTORY_STATUSES).describe('reserved = every unit is held; partial/unallocated = short on stock (never oversold); committed = stock left the warehouse; released = nothing held'),
    attentionReason: z.string().nullable().describe('Why a human should look: unmapped_sku:..., insufficient_stock'), warehouseId: z.string().nullable(),
    tracking: z.object({ number: z.string().nullable(), carrier: z.string().nullable() }), dispatchedAt: IsoDate.nullable(), deliveredAt: IsoDate.nullable(), cancelledAt: IsoDate.nullable(), cancelReason: z.string().nullable(),
    lastMarketplaceSyncAt: IsoDate.nullable(), items: z.array(OrderItemSchema), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
  })
  .meta({ id: 'Order' });

const StatusUpdateSchema = z.object({
  id: z.string(), orderId: z.string(), marketplaceAccountId: z.string(), requestedStatus: z.enum(ORDER_STATUSES), status: z.enum(schema.ORDER_STATUS_UPDATE_STATES).describe('requested -> sent -> successful | failed | retrying | skipped'),
  attempts: z.number().int(), marketplaceStatus: z.string().nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), tracking: z.object({ number: z.string().optional(), carrier: z.string().optional() }).nullable(),
  syncJobId: z.string().nullable(), requestedAt: IsoDate, sentAt: IsoDate.nullable(), completedAt: IsoDate.nullable(),
}).meta({ id: 'OrderStatusUpdate' });

const TimelineSchema = z.object({
  id: z.number().int(), fromStatus: z.enum(ORDER_STATUSES).nullable(), toStatus: z.enum(ORDER_STATUSES), marketplaceStatus: z.string().nullable(), source: z.enum(schema.STATUS_EVENT_SOURCES),
  applied: z.boolean().describe('false = the marketplace reported it but it was NOT applied (late / out of order)'), note: z.string().nullable(), actorId: z.string().nullable(), metadata: z.record(z.string(), z.unknown()), createdAt: IsoDate,
}).meta({ id: 'OrderTimelineEntry' });

const ListQuery = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
  'filter[status]': z.enum(ORDER_STATUSES).optional(), 'filter[accountId]': z.uuid().optional(), 'filter[marketplace]': z.string().max(40).optional(),
  'filter[placedFrom]': z.coerce.date().optional(), 'filter[placedTo]': z.coerce.date().optional(), 'filter[attention]': z.enum(['true', 'false']).optional(),
  'filter[inventoryStatus]': z.enum(schema.ORDER_INVENTORY_STATUSES).optional(), 'filter[payment]': z.enum(['prepaid', 'cod', 'unknown']).optional(), sort: sortQuery(['placedAt', 'updatedAt'] as const),
});

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const TAGS = ['Orders'];

  r.get('/orders', {
    config: { access: { permission: 'orders:read' } },
    schema: {
      tags: TAGS,
      summary: 'List orders (all marketplaces, one dashboard)',
      description: 'Normalised orders from every connected marketplace. `q` matches order number, marketplace order id and customer name/e-mail. `filter[attention]=true` lists orders that need a human (unmapped SKU, short stock).',
      querystring: ListQuery,
      response: { 200: paginatedEnvelope(OrderSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => listOrders(tx, vendorId, {
      limit: q.limit, cursor: q.cursor, sort: q.sort, q: q.q, status: q['filter[status]'], accountId: q['filter[accountId]'], marketplace: q['filter[marketplace]'], from: q['filter[placedFrom]'], to: q['filter[placedTo]'],
      attention: q['filter[attention]'] === undefined ? undefined : q['filter[attention]'] === 'true', inventoryStatus: q['filter[inventoryStatus]'], payment: q['filter[payment]'],
    }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/orders/summary', {
    config: { access: { permission: 'orders:read' } },
    schema: {
      tags: TAGS,
      summary: 'Central dashboard numbers',
      description: 'Orders placed in the window (default last 30 days) across ALL marketplaces: totals by normalised status and by marketplace, plus how many open orders need attention.',
      querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      response: { 200: successEnvelope(z.object({ since: IsoDate, total: z.number().int(), byStatus: z.record(z.string(), z.number().int()), byMarketplace: z.record(z.string(), z.object({ orders: z.number().int(), revenueMinor: z.number() })), needsAttention: z.number().int() })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => orderSummary(tx, vendorId, new Date(Date.now() - req.query.days * 86_400_000)))));

  r.get('/orders/:id', {
    config: { access: { permission: 'orders:read' } },
    schema: { tags: TAGS, summary: 'Get an order with its items', params: IdParamSchema, response: { 200: successEnvelope(OrderSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getOrderDetail(tx, vendorId, req.params.id))));

  r.get('/orders/:id/timeline', {
    config: { access: { permission: 'orders:read' } },
    schema: { tags: TAGS, summary: 'Order timeline', description: 'Append-only history of every status change (and every marketplace report that was ignored), oldest first.', params: IdParamSchema, response: { 200: successEnvelope(z.array(TimelineSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => orderTimeline(tx, vendorId, req.params.id))));

  const TransitionResult = z.object({ order: OrderSchema, statusUpdate: StatusUpdateSchema.describe('How the marketplace is being told: requested -> sent -> successful. `skipped` = this marketplace does not take this status from sellers.') }).meta({ id: 'OrderTransitionResult' });
  r.post('/orders/:id/transition', {
    config: { access: { permission: 'orders:write' } },
    schema: {
      tags: TAGS,
      summary: 'Move an order to its next status',
      description: 'Allowed steps: new -> confirmed -> picking -> packed -> ready_to_dispatch -> dispatched -> in_transit -> delivered; cancel is possible until dispatch; returned after dispatch. Dispatching consumes the reserved stock, cancelling releases it. The marketplace is informed asynchronously where it accepts that status (see `statusUpdate`).',
      params: IdParamSchema,
      body: z.object({
        status: z.enum(ORDER_STATUSES), note: z.string().trim().max(500).optional(), version: z.number().int().optional(),
        tracking: z.object({ number: z.string().trim().min(1).max(100).optional(), carrier: z.string().trim().min(1).max(100).optional() }).optional(),
      }),
      response: { 200: successEnvelope(TransitionResult) },
    },
  }, async (req) => ok(req, (await transitionOrder(opCtxFromRequest(req, requireVendor(req)), req.params.id, req.body.status, { note: req.body.note, tracking: req.body.tracking, version: req.body.version })) as never));

  r.post('/orders/:id/cancel', {
    config: { access: { permission: 'orders:write' } },
    schema: {
      tags: TAGS,
      summary: 'Cancel an order',
      description: 'Allowed until the order is dispatched. Records who cancelled and why (see GET /orders/{id}/cancellations), releases held stock, and tells the marketplace where it supports cancellation. Downstream work (fulfillment, shipment) is cancelled by events.',
      params: IdParamSchema,
      body: z.object({ reason: z.string().trim().min(2).max(300), reasonCode: z.enum(REASON_CODES).default('other'), initiator: z.enum(['seller', 'customer']).default('seller').describe('Who wanted it: the seller, or the customer (the seller cancels at the customer request)') }),
      response: { 200: successEnvelope(TransitionResult) },
    },
  }, async (req) => ok(req, (await transitionOrder(opCtxFromRequest(req, requireVendor(req)), req.params.id, 'cancelled', { cancelReason: req.body.reason, note: req.body.reason, reasonCode: req.body.reasonCode, initiator: req.body.initiator })) as never));

  const CancellationSchema = z.object({
    id: z.string(), orderId: z.string(), initiator: z.enum(schema.CANCELLATION_INITIATORS), reasonCode: z.string(), reasonText: z.string().nullable(), status: z.enum(schema.CANCELLATION_STATUSES),
    orderStatusAtRequest: z.string().describe('How far fulfilment had got when it was asked for'), requestedBy: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: IsoDate.nullable(), decisionNote: z.string().nullable(),
    releasedUnits: z.number().int().describe('Units of held stock given back to available'), createdAt: IsoDate, updatedAt: IsoDate,
  }).meta({ id: 'OrderCancellation' });
  r.get('/orders/cancellation-reasons', {
    config: { access: { permission: 'orders:read' } },
    schema: { tags: TAGS, summary: 'Cancellation reason codes', response: { 200: successEnvelope(z.array(z.object({ code: z.string(), label: z.string(), initiators: z.array(z.string()) }))) } },
  }, async (req) => ok(req, CANCELLATION_REASONS.map((x) => ({ code: x.code, label: x.label, initiators: [...x.initiators] }))));
  r.get('/orders/:id/cancellations', {
    config: { access: { permission: 'orders:read' } },
    schema: { tags: TAGS, summary: 'Cancellation history of an order', description: 'Requests (customer / marketplace / seller) and their outcome, newest first. The order timeline shows the resulting status change.', params: IdParamSchema, response: { 200: successEnvelope(z.array(CancellationSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listCancellations(tx, vendorId, req.params.id))));
  r.post('/orders/:id/cancellation-requests', {
    config: { access: { permission: 'orders:write' } },
    schema: {
      tags: TAGS,
      summary: 'Record a cancellation REQUEST (not yet decided)',
      description: 'For a customer / marketplace asking to cancel while the seller still decides. Accept or reject it with the endpoints below. Only possible before dispatch.',
      params: IdParamSchema,
      body: z.object({ initiator: z.enum(schema.CANCELLATION_INITIATORS).default('customer'), reasonCode: z.enum(REASON_CODES).default('other'), reasonText: z.string().trim().max(300).optional() }),
      response: { 201: successEnvelope(CancellationSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, (tx, vendorId) => requestCancellation(tx, opCtxFromRequest(req, vendorId), req.params.id, req.body));
    reply.code(201);
    return ok(req, dto);
  });
  for (const decision of ['accept', 'reject'] as const) {
    r.post(`/orders/:id/cancellation-requests/:cid/${decision}`, {
      config: { access: { permission: 'orders:write' } },
      schema: {
        tags: TAGS,
        summary: decision === 'accept' ? 'Accept a cancellation request (cancels the order and releases stock)' : 'Reject a cancellation request (the order carries on)',
        params: z.object({ id: z.uuid(), cid: z.uuid() }),
        body: z.object({ note: z.string().trim().max(300).optional() }).default({}),
        response: { 200: successEnvelope(z.object({ cancellation: CancellationSchema, order: OrderSchema.nullable() })) },
      },
    }, async (req) => {
      const vendorId = requireVendor(req);
      const ctx = opCtxFromRequest(req, vendorId);
      const res = await withVendor(c.database.db, vendorId, (tx) => decideCancellation(tx, ctx, req.params.id, req.params.cid, decision, req.body.note));
      if (res.sync?.job) await dispatchSyncJob(c, res.sync.job);
      return ok(req, { cancellation: res.cancellation, order: res.order } as never);
    });
  }

  r.post('/orders/:id/allocate', {
    config: { access: { permission: 'orders:write' } },
    schema: {
      tags: TAGS,
      summary: 'Hold stock for the lines that are still short',
      description: 'Re-runs the reservation for an order that arrived while stock was short (it is also done automatically when stock is received). Never oversells.',
      params: IdParamSchema,
      response: { 200: successEnvelope(z.object({ order: OrderSchema, reserved: z.number().int(), wanted: z.number().int() })) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const res = await withVendor(c.database.db, vendorId, async (tx) => ({ a: await allocateOrder(tx, opCtxFromRequest(req, vendorId), req.params.id) }));
    return ok(req, { order: await vendorTx(req, (tx, v) => getOrderDetail(tx, v, req.params.id)), reserved: res.a.reserved, wanted: res.a.wanted });
  });

  r.get('/orders/:id/status-updates', {
    config: { access: { permission: 'orders:read' } },
    schema: { tags: TAGS, summary: 'Status pushes to the marketplace', description: 'Our system -> connector -> marketplace: every status change we asked a marketplace to apply, with its outcome (requested / sent / successful / failed / retrying / skipped).', params: IdParamSchema, response: { 200: successEnvelope(z.array(StatusUpdateSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listStatusUpdates(tx, vendorId, req.params.id))));

  r.post('/orders/:id/status-updates/:updateId/retry', {
    config: { access: { permission: 'orders:write' } },
    schema: { tags: TAGS, summary: 'Retry a failed status push', params: z.object({ id: z.uuid(), updateId: z.uuid() }), response: { 202: successEnvelope(z.object({ statusUpdate: StatusUpdateSchema, job: SyncJobSchema })) } },
  }, async (req, reply) => {
    const vendorId = requireVendor(req);
    const res = await withVendor(c.database.db, vendorId, (tx) => retryStatusUpdate(tx, opCtxFromRequest(req, vendorId), req.params.id, req.params.updateId));
    await dispatchSyncJob(c, res.job);
    reply.code(202);
    return ok(req, { statusUpdate: toStatusUpdateDto(res.update), job: toSyncJobDto(res.job) } as never);
  });

  r.post('/marketplace-accounts/:id/sync-orders', {
    config: { access: { permission: 'orders:write' } },
    schema: {
      tags: TAGS,
      summary: 'Import orders from the marketplace now',
      description: 'Asynchronous (202). Normally scheduled; this runs it now. Optional `since` re-reads orders changed after that time (e.g. to backfill). Importing is idempotent: orders already imported are not duplicated.',
      params: IdParamSchema,
      body: z.object({ since: z.coerce.date().optional() }).default({}),
      response: { 202: successEnvelope(z.object({ job: SyncJobSchema, alreadyQueued: z.boolean() })) },
    },
  }, async (req, reply) => {
    const vendorId = requireVendor(req);
    await vendorTx(req, (tx, v) => getAccountRow(tx, v, req.params.id));
    const res = await requestOrderSync(c, vendorId, req.params.id, { requestedBy: req.ctx.principal?.actorId ?? null, since: req.body.since?.toISOString() });
    reply.code(202);
    return ok(req, { job: toSyncJobDto(res.job), alreadyQueued: !res.created });
  });
};

