import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { audit, created, ok, paginated, vendorTx } from '@oms/module-kit';
import { assertWarehouseCapability } from '@oms/mod-warehouses';
import { addToBin, binStockOf, moveBetweenBins, removeFromBin, stockLocations } from './bins';
import { cancelInbound, closeInbound, createInbound, listInbound, loadInbound, receiveInbound, toInboundDto } from './inbound';
import { issueOutbound } from './service';

const Qty = z.number().int().min(1).max(10_000_000);
const InboundItem = z.object({ variantId: z.string(), sku: z.string(), expectedQuantity: z.number().int(), receivedQuantity: z.number().int(), damagedQuantity: z.number().int(), outstandingQuantity: z.number().int(), binId: z.string().nullable() });
const InboundSchema = z.object({
  id: z.string(), number: z.string(), warehouseId: z.string(), supplier: z.string().nullable(), reference: z.string().nullable(), status: z.enum(schema.INBOUND_STATUSES), notes: z.string().nullable(),
  expectedAt: IsoDate.nullable(), receivedAt: IsoDate.nullable(), version: z.number().int(), createdAt: IsoDate, items: z.array(InboundItem),
}).meta({ id: 'InboundShipment' });
const BinStockSchema = z.object({ binId: z.string(), binCode: z.string(), binBarcode: z.string().nullable(), warehouseId: z.string(), variantId: z.string(), sku: z.string(), quantity: z.number().int() }).meta({ id: 'BinStock' });

/** Warehouse operations on stock: inbound (receiving), bins / put-away, outbound. */
export const inventoryOpsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Inventory'];
  const actorOf = (req: FastifyRequest) => ({ type: (req.ctx.principal?.actorType ?? 'system') as 'user' | 'api_key' | 'system' | 'webhook', id: req.ctx.principal?.actorId ?? null });

  // ---------------------------------------------------------------- inbound
  r.post('/inbound-shipments', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Announce an inbound shipment (expected goods)',
      description: 'Expected quantities show as `incoming` until received. Receive with POST /inbound-shipments/{id}/receive.',
      body: z.object({ warehouseId: z.uuid(), supplier: z.string().max(120).nullish(), reference: z.string().max(120).nullish(), expectedAt: z.coerce.date().nullish(), notes: z.string().max(500).nullish(), items: z.array(z.object({ variantId: z.uuid(), expectedQuantity: Qty })).min(1).max(500) }),
      response: { 201: successEnvelope(InboundSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      await assertWarehouseCapability(tx, req.ctx.principal, vendorId, req.body.warehouseId, 'receive');
      const x = toInboundDto(await createInbound(tx, vendorId, actorOf(req), req.body));
      await audit(tx, req, { action: 'inbound.create', resourceType: 'inbound_shipment', resourceId: x.id, after: { number: x.number, warehouseId: x.warehouseId, items: x.items.length } });
      return x;
    });
    return created(req, reply, dto as never, `/api/v1/inbound-shipments/${dto.id}`);
  });
  r.get('/inbound-shipments', {
    config: { access: { permission: 'inventory:read' } },
    schema: { tags: TAGS, summary: 'List inbound shipments', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(schema.INBOUND_STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional() }), response: { 200: paginatedEnvelope(InboundSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => listInbound(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], warehouseId: req.query['filter[warehouseId]'] }));
    return paginated(req, page.items as never, { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.get('/inbound-shipments/:id', {
    config: { access: { permission: 'inventory:read' } },
    schema: { tags: TAGS, summary: 'Get an inbound shipment', params: IdParamSchema, response: { 200: successEnvelope(InboundSchema) } },
  }, async (req) => ok(req, toInboundDto(await vendorTx(req, (tx, vendorId) => loadInbound(tx, vendorId, req.params.id))) as never));
  r.post('/inbound-shipments/:id/receive', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Receive goods (good + damaged), optionally into a bin',
      description: '`receivedQuantity` is what physically arrived now; `damagedQuantity` is the damaged part of it (goes to the damaged bucket, not sellable). Partial receipts are fine; the shipment becomes `received` when every line is complete. Over-receipts are accepted and reported in `overReceived`.',
      params: IdParamSchema,
      body: z.object({ items: z.array(z.object({ variantId: z.uuid(), receivedQuantity: Qty, damagedQuantity: z.number().int().min(0).optional(), binId: z.uuid().nullish() })).min(1).max(500) }),
      response: { 200: successEnvelope(z.object({ inbound: InboundSchema, overReceived: z.array(z.object({ variantId: z.string(), extra: z.number().int() })) })) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const before = await loadInbound(tx, vendorId, req.params.id);
    await assertWarehouseCapability(tx, req.ctx.principal, vendorId, before.s.warehouseId, 'receive');
    const res = await receiveInbound(tx, vendorId, actorOf(req), req.params.id, req.body.items);
    await audit(tx, req, { action: 'inbound.receive', resourceType: 'inbound_shipment', resourceId: req.params.id, before: { status: before.s.status }, after: { status: res.inbound.s.status, lines: req.body.items.length } });
    return { inbound: toInboundDto(res.inbound), overReceived: res.overReceived };
  }) as never));
  for (const [path, label, fn] of [['close', 'Close a part-received shipment (clears what will never arrive)', closeInbound], ['cancel', 'Cancel an inbound shipment with nothing received', cancelInbound]] as const) {
    r.post(`/inbound-shipments/:id/${path}`, {
      config: { access: { permission: 'inventory:write' } },
      schema: { tags: TAGS, summary: label, params: IdParamSchema, response: { 200: successEnvelope(InboundSchema) } },
    }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
      const before = await loadInbound(tx, vendorId, req.params.id);
      await assertWarehouseCapability(tx, req.ctx.principal, vendorId, before.s.warehouseId, 'receive');
      const x = toInboundDto(await fn(tx, vendorId, actorOf(req), req.params.id));
      await audit(tx, req, { action: `inbound.${path}`, resourceType: 'inbound_shipment', resourceId: x.id, before: { status: before.s.status }, after: { status: x.status } });
      return x;
    }) as never));
  }

  // ---------------------------------------------------------------- bins / put-away
  r.get('/bin-stock', {
    config: { access: { permission: 'inventory:read' } },
    schema: { tags: TAGS, summary: 'What is in which bin', querystring: z.object({ 'filter[warehouseId]': z.uuid().optional(), 'filter[variantId]': z.uuid().optional(), 'filter[binId]': z.uuid().optional() }), response: { 200: successEnvelope(z.array(BinStockSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => binStockOf(tx, vendorId, { warehouseId: req.query['filter[warehouseId]'], variantId: req.query['filter[variantId]'], binId: req.query['filter[binId]'] }))));
  r.get('/inventory/variants/:id/locations', {
    config: { access: { permission: 'inventory:read' } },
    schema: {
      tags: TAGS, summary: 'Where a variant is stored (warehouse -> bins, plus unbinned stock)', params: IdParamSchema,
      response: { 200: successEnvelope(z.array(z.object({ warehouseId: z.string(), onHand: z.number().int(), reserved: z.number().int(), binned: z.number().int(), unbinned: z.number().int().describe('Received but not put away into a bin yet'), bins: z.array(z.object({ binId: z.string(), binCode: z.string(), quantity: z.number().int() })) }))) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => stockLocations(tx, vendorId, req.params.id))));
  r.post('/bin-stock/put-away', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Put away / move stock between bins',
      description: 'Without `fromBinId`: bins units that were received but not yet put away. With it: moves units between two bins of the warehouse. Never bins more than the warehouse holds and respects bin capacity. Quantities in the warehouse do not change (this is location, not stock).',
      body: z.object({ warehouseId: z.uuid(), variantId: z.uuid(), binId: z.uuid().describe('Destination bin'), fromBinId: z.uuid().optional(), quantity: Qty }),
      response: { 200: successEnvelope(z.array(BinStockSchema)) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const b = req.body;
    await assertWarehouseCapability(tx, req.ctx.principal, vendorId, b.warehouseId, 'receive');
    if (b.fromBinId) await moveBetweenBins(tx, { vendorId, warehouseId: b.warehouseId, variantId: b.variantId, binId: b.fromBinId, toBinId: b.binId, quantity: b.quantity });
    else await addToBin(tx, { vendorId, warehouseId: b.warehouseId, variantId: b.variantId, binId: b.binId, quantity: b.quantity });
    await audit(tx, req, { action: b.fromBinId ? 'bin_stock.move' : 'bin_stock.put_away', resourceType: 'variant', resourceId: b.variantId, after: { warehouseId: b.warehouseId, binId: b.binId, fromBinId: b.fromBinId ?? null, quantity: b.quantity } });
    return binStockOf(tx, vendorId, { warehouseId: b.warehouseId, variantId: b.variantId });
  })));
  r.post('/bin-stock/remove', {
    config: { access: { permission: 'inventory:write' } },
    schema: { tags: TAGS, summary: 'Take units out of a bin (they become unbinned; stock quantity is unchanged)', body: z.object({ warehouseId: z.uuid(), variantId: z.uuid(), binId: z.uuid(), quantity: Qty }), response: { 200: successEnvelope(z.array(BinStockSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    await assertWarehouseCapability(tx, req.ctx.principal, vendorId, req.body.warehouseId, 'adjust');
    await removeFromBin(tx, { vendorId, ...req.body });
    await audit(tx, req, { action: 'bin_stock.remove', resourceType: 'variant', resourceId: req.body.variantId, after: req.body });
    return binStockOf(tx, vendorId, { warehouseId: req.body.warehouseId, variantId: req.body.variantId });
  })));

  // ---------------------------------------------------------------- outbound (no order)
  r.post('/inventory/outbound', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Issue stock out of a warehouse without an order',
      description: 'For B2B issues, samples, internal use. Order dispatches go through the fulfillment/shipping flow and consume their own reservation. A reason is mandatory; the stock cannot go below what is reserved.',
      body: z.object({ variantId: z.uuid(), warehouseId: z.uuid(), quantity: Qty, reason: z.string().trim().min(2).max(300), reference: z.string().max(100).optional(), binId: z.uuid().optional(), idempotencyKey: z.string().min(8).max(100).optional() }),
      response: { 200: successEnvelope(z.object({ movementId: z.number().int(), duplicate: z.boolean(), onHand: z.number().int(), available: z.number().int() })) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const b = req.body;
    await assertWarehouseCapability(tx, req.ctx.principal, vendorId, b.warehouseId, 'dispatch');
    const res = await issueOutbound(tx, { vendorId, variantId: b.variantId, warehouseId: b.warehouseId, quantity: b.quantity, reason: b.reason, referenceId: b.reference ?? null, idempotencyKey: b.idempotencyKey ?? null, actor: actorOf(req) });
    if (!res.duplicate && b.binId) await removeFromBin(tx, { vendorId, variantId: b.variantId, warehouseId: b.warehouseId, binId: b.binId, quantity: b.quantity });
    if (!res.duplicate) await audit(tx, req, { action: 'inventory.outbound', resourceType: 'inventory', resourceId: res.stock.id, after: { quantity: b.quantity, reason: b.reason, reference: b.reference ?? null } });
    return { movementId: res.movementId, duplicate: res.duplicate, onHand: res.stock.quantityOnHand, available: res.availableAfter };
  })));
};
