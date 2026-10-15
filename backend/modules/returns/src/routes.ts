import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema, withVendor, type Tx } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { created, ok, opCtxFromRequest, paginated, requireVendor, vendorTx, type OpCtx } from '@oms/module-kit';
import { transitionOrder } from '@oms/mod-orders';
import { assertWarehouseCapability } from '@oms/mod-warehouses';
import { RETURN_REASONS, RETURN_STATUSES } from './domain';
import {
  cancelReturn, completeReturn, createReturn, decideReturn, getReturnRow, inspectReturn, listReturns, receiveReturnGoods, recordPickup, recordRefund, returnDetail, returnTimeline, schedulePickup,
} from './service';

const Item = z.object({
  id: z.string(), orderItemId: z.string(), variantId: z.string().nullable(), sku: z.string().nullable(), quantity: z.number().int(), receivedQuantity: z.number().int(), dispositionedQuantity: z.number().int(), restockedQuantity: z.number().int(),
  condition: z.enum(schema.RETURN_CONDITIONS).nullable(), disposition: z.enum(schema.RETURN_DISPOSITIONS).nullable(), notes: z.string().nullable(), inspectedAt: IsoDate.nullable(),
});
const ReturnSchema = z.object({
  id: z.string(), number: z.string(), orderId: z.string(), warehouseId: z.string().nullable(), source: z.enum(schema.RETURN_SOURCES), status: z.enum(RETURN_STATUSES), reasonCode: z.string(), reasonText: z.string().nullable(),
  marketplaceReturnId: z.string().nullable(), shipmentId: z.string().nullable(),
  pickup: z.object({ status: z.enum(schema.PICKUP_STATUSES), awb: z.string().nullable(), scheduledAt: IsoDate.nullable() }),
  refund: z.object({ status: z.enum(schema.REFUND_STATUSES), amountMinor: z.number().int().nullable(), reference: z.string().nullable(), refundedAt: IsoDate.nullable() }),
  receivedAt: IsoDate.nullable(), inspectedAt: IsoDate.nullable(), completedAt: IsoDate.nullable(), notes: z.string().nullable(), items: z.array(Item), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
}).meta({ id: 'ReturnOrder' });
const Qty = z.number().int().min(1).max(100_000);

/** Returns: request -> approve -> pickup -> receive -> inspect -> disposition -> refund, wired to the inventory engine. */
export const returnRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Returns'];
  async function run<T>(req: FastifyRequest, fn: (tx: Tx, ctx: OpCtx) => Promise<T>): Promise<T> {
    const vendorId = requireVendor(req);
    const ctx = opCtxFromRequest(req, vendorId);
    return vendorTx(req, (tx) => fn(tx, ctx));
  }
  const canReceive = (req: FastifyRequest, tx: Tx, warehouseId: string) => assertWarehouseCapability(tx, req.ctx.principal, requireVendor(req), warehouseId, 'receive');
  const detail = async (tx: Tx, ctx: OpCtx, id: string) => returnDetail(tx, ctx.vendorId, id);

  r.get('/returns/reasons', {
    config: { access: { permission: 'returns:read' } },
    schema: { tags: TAGS, summary: 'Return reason catalogue', response: { 200: successEnvelope(z.array(z.object({ code: z.string(), label: z.string(), sources: z.array(z.string()) }))) } },
  }, async (req) => ok(req, RETURN_REASONS.map((x) => ({ code: x.code, label: x.label, sources: [...x.sources] }))));

  r.post('/returns', {
    config: { access: { permission: 'returns:write' } },
    schema: {
      tags: TAGS, summary: 'Create a return', description: 'For an order that has left the warehouse. Quantities are limited to what was sold and is not already being returned; the refund due is computed from what the customer paid. Idempotent per `marketplaceReturnId`.',
      body: z.object({
        orderId: z.uuid(), source: z.enum(['customer', 'marketplace', 'seller']).default('customer'), reasonCode: z.string().min(2).max(60), reasonText: z.string().max(500).nullish(), marketplaceReturnId: z.string().max(120).nullish(), warehouseId: z.uuid().nullish(),
        pickupRequired: z.boolean().default(false), notes: z.string().max(500).nullish(), items: z.array(z.object({ orderItemId: z.uuid(), quantity: Qty })).min(1).max(200),
      }),
      response: { 201: successEnvelope(ReturnSchema) },
    },
  }, async (req, reply) => {
    const dto = await run(req, async (tx, ctx) => { const x = await createReturn(tx, ctx, req.body); return detail(tx, ctx, x.id); });
    return created(req, reply, dto, `/api/v1/returns/${dto.id}`);
  });
  r.get('/returns', {
    config: { access: { permission: 'returns:read' } },
    schema: { tags: TAGS, summary: 'List returns', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(RETURN_STATUSES).optional(), 'filter[orderId]': z.uuid().optional(), 'filter[source]': z.enum(schema.RETURN_SOURCES).optional(), 'filter[refundStatus]': z.enum(schema.REFUND_STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional() }), response: { 200: paginatedEnvelope(ReturnSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => listReturns(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], orderId: req.query['filter[orderId]'], source: req.query['filter[source]'], refundStatus: req.query['filter[refundStatus]'], warehouseId: req.query['filter[warehouseId]'] }));
    return paginated(req, page.items, { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.get('/orders/:id/returns', {
    config: { access: { permission: 'returns:read' } },
    schema: { tags: TAGS, summary: 'Returns of an order', params: IdParamSchema, response: { 200: successEnvelope(z.array(ReturnSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => listReturns(tx, vendorId, { limit: 100, orderId: req.params.id }))).items));
  r.get('/returns/:id', {
    config: { access: { permission: 'returns:read' } },
    schema: { tags: TAGS, summary: 'Get a return', params: IdParamSchema, response: { 200: successEnvelope(ReturnSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => returnDetail(tx, vendorId, req.params.id))));
  r.get('/returns/:id/timeline', {
    config: { access: { permission: 'returns:read' } },
    schema: { tags: TAGS, summary: 'Return timeline', params: IdParamSchema, response: { 200: successEnvelope(z.array(z.object({ id: z.number().int(), fromStatus: z.string().nullable(), toStatus: z.string(), actorId: z.string().nullable(), note: z.string().nullable(), metadata: z.record(z.string(), z.unknown()), createdAt: IsoDate }))) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => returnTimeline(tx, vendorId, req.params.id))));

  const act = <B extends z.ZodType>(path: string, summary: string, description: string, body: B, fn: (tx: Tx, ctx: OpCtx, id: string, b: z.infer<B>, req: FastifyRequest) => Promise<unknown>, perm: 'returns:write' | 'returns:refund' = 'returns:write') => {
    r.post(`/returns/:id/${path}`, {
      config: { access: { permission: perm } },
      schema: { tags: TAGS, summary, description, params: IdParamSchema, body, response: { 200: successEnvelope(ReturnSchema) } },
    }, async (req) => ok(req, await run(req, async (tx, ctx) => { await fn(tx, ctx, req.params.id, req.body as z.infer<B>, req); return detail(tx, ctx, req.params.id); })));
  };
  act('approve', 'Approve a return', 'Optionally say which warehouse should receive the goods.', z.object({ note: z.string().max(300).nullish(), warehouseId: z.uuid().nullish() }).default({}), (tx, ctx, id, b) => decideReturn(tx, ctx, id, 'approve', b.note, b.warehouseId));
  act('reject', 'Reject a return', 'No refund is due.', z.object({ note: z.string().min(2).max(300) }), (tx, ctx, id, b) => decideReturn(tx, ctx, id, 'reject', b.note));
  act('pickup', 'Schedule a reverse pickup', 'Only for returns created with `pickupRequired`.', z.object({ scheduledAt: z.coerce.date().nullish(), awb: z.string().max(80).nullish(), warehouseId: z.uuid().nullish() }).default({}), (tx, ctx, id, b) => schedulePickup(tx, ctx, id, b));
  act('pickup-status', 'Record reverse pickup progress', '`picked_up`, `in_transit`, or `failed` (back to approved so it can be rescheduled).', z.object({ outcome: z.enum(['picked_up', 'in_transit', 'failed']), note: z.string().max(300).nullish() }), (tx, ctx, id, b) => recordPickup(tx, ctx, id, b.outcome, b.note));
  act('receive', 'Receive the returned goods into a warehouse',
    'Units enter the warehouse\'s `returned` bucket (not sellable until inspected). Partial receipts are fine. Needs the `receive` warehouse capability.',
    z.object({ warehouseId: z.uuid(), items: z.array(z.object({ returnItemId: z.uuid(), quantity: Qty })).min(1).max(200), note: z.string().max(300).nullish() }),
    async (tx, ctx, id, b, req) => { await canReceive(req, tx, b.warehouseId); return receiveReturnGoods(tx, ctx, id, b); });
  act('inspect', 'Inspect received units and decide their disposition',
    '`restock` returns sellable units to stock (optionally into a bin), `damaged` moves them to the damaged bucket, `dispose` / `return_to_vendor` write them off, `quarantine` keeps them held. A non-sellable item cannot be restocked. Stock changes go through the inventory ledger.',
    z.object({ items: z.array(z.object({ returnItemId: z.uuid(), quantity: Qty, condition: z.enum(schema.RETURN_CONDITIONS), disposition: z.enum(schema.RETURN_DISPOSITIONS), binId: z.uuid().nullish(), notes: z.string().max(300).nullish() })).min(1).max(200) }),
    async (tx, ctx, id, b, req) => { const row = await getReturnRow(tx, ctx.vendorId, id); if (row.warehouseId) await canReceive(req, tx, row.warehouseId); return inspectReturn(tx, ctx, id, b.items); });
  act('refund', 'Record the refund outcome', 'The money moves in the marketplace / payment system; this records its status and reference.', z.object({ status: z.enum(['processed', 'failed', 'pending']), amountMinor: z.number().int().min(0).nullish(), reference: z.string().max(120).nullish() }), (tx, ctx, id, b) => recordRefund(tx, ctx, id, b), 'returns:refund');
  act('cancel', 'Cancel a return that has not been received', '', z.object({ note: z.string().max(300).nullish() }).default({}), (tx, ctx, id, b) => cancelReturn(tx, ctx, id, b.note));

  r.post('/returns/:id/complete', {
    config: { access: { permission: 'returns:write' } },
    schema: {
      tags: TAGS, summary: 'Complete a return', description: 'Needs every received unit decided. Units that never arrived need `acceptShort`. When the whole order has come back the order becomes `returned`.',
      params: IdParamSchema, body: z.object({ acceptShort: z.boolean().optional(), note: z.string().max(300).nullish() }).default({}), response: { 200: successEnvelope(ReturnSchema) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const ctx = opCtxFromRequest(req, vendorId);
    const res = await withVendor(req.server.container.database.db, vendorId, (tx) => completeReturn(tx, ctx, req.params.id, req.body));
    if (res.fullyReturned) await transitionOrder(ctx, res.row.orderId, 'returned', { note: 'all items returned' }).catch((e) => { if ((e as { code?: string }).code !== 'INVALID_STATE') throw e; });
    return ok(req, await vendorTx(req, (tx) => returnDetail(tx, vendorId, req.params.id)));
  });
};
