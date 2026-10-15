import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, sortQuery, successEnvelope } from '@oms/contracts';
import { audit, created, ok, paginated, vendorTx } from '@oms/module-kit';
import { assertWarehouseCapability } from '@oms/mod-warehouses';
import * as svc from './service';

const Qty = z.number().int().min(1).max(10_000_000);
const Reason = z.string().trim().min(2).max(300);
const Key = z.string().trim().min(8).max(100).optional().describe('Optional idempotency key: repeating the same key never moves stock twice');

const StockSchema = z
  .object({
    id: z.string(), variantId: z.string(), sku: z.string(), productTitle: z.string(), warehouseId: z.string(), warehouseCode: z.string(),
    onHand: z.number().int().describe('Good physical stock in the warehouse'),
    reserved: z.number().int().describe('Promised to orders (part of onHand)'),
    available: z.number().int().describe('onHand - reserved: what can still be sold'),
    incoming: z.number().int().describe('Ordered / in transit, not yet received'),
    damaged: z.number().int().describe('Physically present but unsellable'),
    returned: z.number().int().describe('Customer returns awaiting inspection'),
    reorderLevel: z.number().int().nullable(), version: z.number().int(), updatedAt: IsoDate,
  })
  .meta({ id: 'StockLevel' });

const MovementSchema = z
  .object({
    id: z.number().int(), variantId: z.string(), warehouseId: z.string(), type: z.enum(schema.MOVEMENT_TYPES),
    deltaOnHand: z.number().int(), deltaReserved: z.number().int(), deltaIncoming: z.number().int(), deltaDamaged: z.number().int(), deltaReturned: z.number().int(),
    onHandAfter: z.number().int(), reservedAfter: z.number().int(), reason: z.string().nullable(), referenceType: z.string().nullable(), referenceId: z.string().nullable(),
    actorType: z.string(), actorId: z.string().nullable(), createdAt: IsoDate,
  })
  .meta({ id: 'InventoryMovement' });

const MovementResultSchema = z.object({ duplicate: z.boolean().describe('true when the idempotency key was already applied (nothing changed)'), movement: z.object({ id: z.number().int() }), stock: StockSchema }).meta({ id: 'StockChangeResult' });

const ReservationSchema = z
  .object({ id: z.string(), orderId: z.string(), orderItemId: z.string(), variantId: z.string(), warehouseId: z.string(), quantity: z.number().int(), status: z.enum(schema.RESERVATION_STATUSES), createdAt: IsoDate, releasedAt: IsoDate.nullable(), committedAt: IsoDate.nullable() })
  .meta({ id: 'InventoryReservation' });

const TransferSchema = z
  .object({
    id: z.string(), number: z.string(), fromWarehouseId: z.string(), toWarehouseId: z.string(), status: z.enum(schema.TRANSFER_STATUSES), notes: z.string().nullable(),
    shippedAt: IsoDate.nullable(), receivedAt: IsoDate.nullable(), version: z.number().int(), createdAt: IsoDate,
    items: z.array(z.object({ variantId: z.string(), sku: z.string(), quantity: z.number().int(), receivedQuantity: z.number().int() })),
  })
  .meta({ id: 'StockTransfer' });

const Target = z.object({ variantId: z.uuid(), warehouseId: z.uuid(), reason: Reason.optional(), idempotencyKey: Key });

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Inventory'];
  const actorOf = (req: FastifyRequest) => ({ type: (req.ctx.principal?.actorType ?? 'system') as 'user' | 'api_key' | 'system' | 'webhook', id: req.ctx.principal?.actorId ?? null });

  /** runs one stock operation, audits it, returns the uniform result shape */
  const change = async (req: FastifyRequest, action: string, op: (tx: Parameters<Parameters<typeof vendorTx>[1]>[0], vendorId: string) => Promise<Awaited<ReturnType<typeof svc.receiveStock>>>) => {
    const res = await vendorTx(req, async (tx, vendorId) => {
      const wid = (req.body as { warehouseId?: string }).warehouseId;
      if (wid) await assertWarehouseCapability(tx, req.ctx.principal, vendorId, wid, action === 'receive' || action === 'incoming' ? 'receive' : 'adjust');
      const mv = await op(tx, vendorId);
      if (!mv.duplicate) await audit(tx, req, { action: `inventory.${action}`, resourceType: 'inventory', resourceId: mv.stock.id, after: { movementId: mv.movementId, onHand: mv.stock.quantityOnHand, reserved: mv.stock.quantityReserved } });
      const detail = await svc.variantOverview(tx, vendorId, mv.stock.variantId);
      const row = detail.warehouses.find((w) => w.warehouseId === mv.stock.warehouseId)!;
      return { duplicate: mv.duplicate, movement: { id: mv.movementId }, stock: row };
    });
    return ok(req, res);
  };
  const common = (req: FastifyRequest, vendorId: string, b: z.infer<typeof Target>) => ({ vendorId, variantId: b.variantId, warehouseId: b.warehouseId, reason: b.reason ?? null, idempotencyKey: b.idempotencyKey ?? null, actor: actorOf(req) });

  r.get('/inventory', {
    config: { access: { permission: 'inventory:read' } },
    schema: {
      tags: TAGS,
      summary: 'Stock levels (per variant per warehouse)',
      description: 'onHand / reserved / available / incoming / damaged / returned. `filter[low]` = at or below the reorder level; `filter[out]` = nothing available.',
      querystring: PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
        'filter[variantId]': z.uuid().optional(), 'filter[warehouseId]': z.uuid().optional(), 'filter[low]': z.coerce.boolean().optional(), 'filter[out]': z.coerce.boolean().optional(),
        sort: sortQuery(['updatedAt', 'sku'] as const),
      }),
      response: { 200: paginatedEnvelope(StockSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listStock(tx, vendorId, { limit: q.limit, cursor: q.cursor, sort: q.sort, variantId: q['filter[variantId]'], warehouseId: q['filter[warehouseId]'], q: q.q, lowStock: q['filter[low]'], outOfStock: q['filter[out]'] }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/inventory/variants/:id', {
    config: { access: { permission: 'inventory:read' } },
    schema: {
      tags: TAGS,
      summary: 'Stock of one variant across all warehouses',
      params: IdParamSchema,
      response: { 200: successEnvelope(z.object({ variantId: z.string(), sku: z.string(), productTitle: z.string(), totals: z.object({ onHand: z.number().int(), reserved: z.number().int(), available: z.number().int(), incoming: z.number().int(), damaged: z.number().int(), returned: z.number().int() }), warehouses: z.array(StockSchema) }).meta({ id: 'VariantStock' })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.variantOverview(tx, vendorId, req.params.id))));

  r.post('/inventory/receive', {
    config: { access: { permission: 'inventory:write' } },
    schema: { tags: TAGS, summary: 'Receive stock into a warehouse', description: 'Adds to on-hand (writes a `receive` movement). With `fromIncoming` it also clears the same quantity from the warehouse\'s incoming bucket.', body: Target.extend({ quantity: Qty, fromIncoming: z.boolean().optional() }), response: { 200: successEnvelope(MovementResultSchema) } },
  }, (req) => change(req, 'receive', (tx, vendorId) => svc.receiveStock(tx, { ...common(req, vendorId, req.body), quantity: req.body.quantity, fromIncoming: req.body.fromIncoming })));

  r.post('/inventory/incoming', {
    config: { access: { permission: 'inventory:write' } },
    schema: { tags: TAGS, summary: 'Record stock that is on its way', description: 'Increases the `incoming` bucket (not sellable until received).', body: Target.extend({ quantity: Qty }), response: { 200: successEnvelope(MovementResultSchema) } },
  }, (req) => change(req, 'incoming', (tx, vendorId) => svc.addIncoming(tx, { ...common(req, vendorId, req.body), quantity: req.body.quantity })));

  r.post('/inventory/adjust', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Adjust stock (delta) or record a stock count',
      description: 'Exactly one of `delta` (+/- units) or `setOnHand` (a physical count: the ledger records the DIFFERENCE). A `reason` is mandatory. Never goes below zero or below what is reserved.',
      body: Target.extend({ reason: Reason, delta: z.number().int().min(-10_000_000).max(10_000_000).optional(), setOnHand: z.number().int().min(0).max(10_000_000).optional() }),
      response: { 200: successEnvelope(MovementResultSchema) },
    },
  }, (req) => change(req, 'adjust', (tx, vendorId) => svc.adjustStock(tx, { ...common(req, vendorId, req.body), delta: req.body.delta, setOnHand: req.body.setOnHand })));

  r.post('/inventory/damage', {
    config: { access: { permission: 'inventory:write' } },
    schema: { tags: TAGS, summary: 'Move stock to / from the damaged bucket', body: Target.extend({ reason: Reason, quantity: Qty, restore: z.boolean().optional().describe('true = damaged -> sellable again') }), response: { 200: successEnvelope(MovementResultSchema) } },
  }, (req) => change(req, req.body.restore ? 'undamage' : 'damage', (tx, vendorId) => svc.markDamaged(tx, { ...common(req, vendorId, req.body), quantity: req.body.quantity, restore: req.body.restore })));

  r.post('/inventory/returns', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Receive a customer return',
      description: '`hold` = quarantine in the returned bucket until inspected; `restock` = sellable immediately; `damaged` = write-off bucket. Resolve held returns with POST /inventory/returns/resolve.',
      body: Target.extend({ quantity: Qty, disposition: z.enum(['hold', 'restock', 'damaged']).default('hold') }),
      response: { 200: successEnvelope(MovementResultSchema) },
    },
  }, (req) => change(req, 'return', (tx, vendorId) => svc.receiveReturn(tx, { ...common(req, vendorId, req.body), quantity: req.body.quantity, disposition: req.body.disposition })));

  r.post('/inventory/returns/resolve', {
    config: { access: { permission: 'inventory:write' } },
    schema: { tags: TAGS, summary: 'Inspect held returns: restock or write off', body: Target.extend({ quantity: Qty, to: z.enum(['restock', 'damaged']) }), response: { 200: successEnvelope(MovementResultSchema) } },
  }, (req) => change(req, 'return_resolve', (tx, vendorId) => svc.resolveReturned(tx, { ...common(req, vendorId, req.body), quantity: req.body.quantity, to: req.body.to })));

  r.put('/inventory/reorder-level', {
    config: { access: { permission: 'inventory:write' } },
    schema: { tags: TAGS, summary: 'Set the low-stock threshold of a variant in a warehouse', body: z.object({ variantId: z.uuid(), warehouseId: z.uuid(), reorderLevel: z.number().int().min(0).nullable() }), response: { 200: successEnvelope(z.object({ ok: z.literal(true) })) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      await svc.setReorderLevel(tx, vendorId, req.body.variantId, req.body.warehouseId, req.body.reorderLevel);
      await audit(tx, req, { action: 'inventory.reorder_level', resourceType: 'variant', resourceId: req.body.variantId, after: { warehouseId: req.body.warehouseId, reorderLevel: req.body.reorderLevel } });
    });
    return ok(req, { ok: true as const });
  });

  // ---- ledger
  r.get('/inventory/movements', {
    config: { access: { permission: 'inventory:read' } },
    schema: {
      tags: TAGS,
      summary: 'Movement ledger (append-only)',
      description: 'Every quantity change, newest first, with running balances. Page with `before=<last id>`.',
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional(), 'filter[variantId]': z.uuid().optional(), 'filter[warehouseId]': z.uuid().optional(),
        'filter[type]': z.enum(schema.MOVEMENT_TYPES).optional(), 'filter[referenceType]': z.string().max(30).optional(), 'filter[referenceId]': z.string().max(100).optional(),
      }),
      response: { 200: successEnvelope(z.object({ items: z.array(MovementSchema), nextBefore: z.number().int().nullable() })) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listMovements(tx, vendorId, { limit: q.limit, before: q.before, variantId: q['filter[variantId]'], warehouseId: q['filter[warehouseId]'], type: q['filter[type]'], referenceType: q['filter[referenceType]'], referenceId: q['filter[referenceId]'] }));
    return ok(req, { items: page.items.map(svc.toMovementDto), nextBefore: page.nextBefore });
  });

  r.get('/inventory/ledger-check', {
    config: { access: { permission: 'inventory:read' } },
    schema: {
      tags: TAGS,
      summary: 'Verify stock equals the movement ledger',
      description: 'Recomputes every quantity from the ledger and lists mismatches. An empty `drift` means no stock was ever changed without a movement.',
      response: { 200: successEnvelope(z.object({ healthy: z.boolean(), drift: z.array(z.object({ variantId: z.string(), warehouseId: z.string(), onHand: z.number(), ledgerOnHand: z.number(), reserved: z.number(), ledgerReserved: z.number(), incoming: z.number(), ledgerIncoming: z.number(), damaged: z.number(), ledgerDamaged: z.number(), returned: z.number(), ledgerReturned: z.number() })) })) },
    },
  }, async (req) => {
    const drift = await vendorTx(req, (tx, vendorId) => svc.ledgerDrift(tx, vendorId));
    return ok(req, { healthy: drift.length === 0, drift });
  });

  // ---- reservations (read-only: orders create and release them)
  r.get('/inventory/reservations', {
    config: { access: { permission: 'inventory:read' } },
    schema: {
      tags: TAGS,
      summary: 'Stock reservations',
      description: 'Created when an order is imported, committed when it is dispatched, released when it is cancelled.',
      querystring: PaginationQuerySchema.extend({ 'filter[orderId]': z.uuid().optional(), 'filter[variantId]': z.uuid().optional(), 'filter[status]': z.enum(schema.RESERVATION_STATUSES).optional() }),
      response: { 200: paginatedEnvelope(ReservationSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listReservations(tx, vendorId, { limit: q.limit, cursor: q.cursor, orderId: q['filter[orderId]'], variantId: q['filter[variantId]'], status: q['filter[status]'] }));
    return paginated(req, page.items.map((x) => ({ id: x.id, orderId: x.orderId, orderItemId: x.orderItemId, variantId: x.variantId, warehouseId: x.warehouseId, quantity: x.quantity, status: x.status as never, createdAt: x.createdAt.toISOString(), releasedAt: x.releasedAt ? x.releasedAt.toISOString() : null, committedAt: x.committedAt ? x.committedAt.toISOString() : null })), { limit: q.limit, nextCursor: page.nextCursor });
  });

  // ---- transfers
  r.post('/inventory/transfers', {
    config: { access: { permission: 'inventory:write' } },
    schema: {
      tags: TAGS,
      summary: 'Create a stock transfer between warehouses (draft)',
      body: z.object({ fromWarehouseId: z.uuid(), toWarehouseId: z.uuid(), items: z.array(z.object({ variantId: z.uuid(), quantity: Qty })).min(1).max(200), notes: z.string().max(500).optional() }),
      response: { 201: successEnvelope(TransferSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const t = svc.toTransferDto(await svc.createTransfer(tx, vendorId, req.body));
      await audit(tx, req, { action: 'inventory.transfer_create', resourceType: 'stock_transfer', resourceId: t.id, after: { number: t.number, items: t.items.length } });
      return t;
    });
    return created(req, reply, dto, `/api/v1/inventory/transfers/${dto.id}`);
  });

  r.get('/inventory/transfers', {
    config: { access: { permission: 'inventory:read' } },
    schema: { tags: TAGS, summary: 'List stock transfers', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(schema.TRANSFER_STATUSES).optional() }), response: { 200: paginatedEnvelope(TransferSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => svc.listTransfers(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'] }));
    return paginated(req, page.items, { limit: req.query.limit, nextCursor: page.nextCursor });
  });

  r.get('/inventory/transfers/:id', {
    config: { access: { permission: 'inventory:read' } },
    schema: { tags: TAGS, summary: 'Get a stock transfer', params: IdParamSchema, response: { 200: successEnvelope(TransferSchema) } },
  }, async (req) => ok(req, svc.toTransferDto(await vendorTx(req, (tx, vendorId) => svc.loadTransfer(tx, vendorId, req.params.id)))));

  const transition = (path: 'ship' | 'receive' | 'cancel', summary: string, description: string, body?: z.ZodType) => {
    r.post(`/inventory/transfers/:id/${path}`, {
      config: { access: { permission: 'inventory:write' } },
      schema: { tags: TAGS, summary, description, params: IdParamSchema, ...(body ? { body } : {}), response: { 200: successEnvelope(TransferSchema) } },
    }, async (req) => {
      const dto = await vendorTx(req, async (tx, vendorId) => {
        const actor = actorOf(req);
        const input = (req.body ?? {}) as { items?: Array<{ variantId: string; quantity: number }> };
        const t = svc.toTransferDto(path === 'ship' ? await svc.shipTransfer(tx, vendorId, req.params.id, actor) : path === 'receive' ? await svc.receiveTransfer(tx, vendorId, req.params.id, input.items, actor) : await svc.cancelTransfer(tx, vendorId, req.params.id, actor));
        await audit(tx, req, { action: `inventory.transfer_${path}`, resourceType: 'stock_transfer', resourceId: t.id, after: { status: t.status } });
        return t;
      });
      return ok(req, dto);
    });
  };
  transition('ship', 'Ship a transfer', 'Stock leaves the source warehouse now and shows as `incoming` at the destination.');
  transition('receive', 'Receive a transfer', 'Defaults to receiving everything that was shipped. Pass `items` for a partial receipt: the shortfall is written back to the source warehouse.', z.object({ items: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(0) })).optional() }));
  transition('cancel', 'Cancel a transfer', 'A draft is simply cancelled; an in-transit transfer returns the stock to the source warehouse.');
};
