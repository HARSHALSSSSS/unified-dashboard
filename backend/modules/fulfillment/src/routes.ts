import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema, type Tx } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { created, ok, opCtxFromRequest, paginated, requireVendor, vendorTx, type OpCtx } from '@oms/module-kit';
import { allowedWarehouses, assertWarehouseCapability, type Capability } from '@oms/mod-warehouses';
import { STATUSES } from './domain';
import { Work, cancelFulfillment, fulfillmentDetail, fulfillmentTimeline, getFulfillment, holdFulfillment, listFulfillments, resumeFulfillment } from './core';
import { getException, listExceptions, raiseException, resolveException, toExceptionDto } from './exceptions';
import { assignPickList, createPickList, flagTask, getPickList, listPickLists, listPickTasks, pickTask, scanTask, shortPick, taskWarehouse } from './picking';
import { cancelPackage, closePackage, createPackage, listPackages, loadPackage, packageDetail, packingTasks, scanPackageItem, setDimensions } from './packing';
import { previewRouting, startFulfillment } from './start';

const Item = z.object({ id: z.string(), orderItemId: z.string(), variantId: z.string(), sku: z.string(), barcode: z.string().nullable(), quantity: z.number().int(), pickedQuantity: z.number().int(), packedQuantity: z.number().int(), shortQuantity: z.number().int() });
const PackageLine = z.object({ id: z.string(), fulfillmentItemId: z.string(), variantId: z.string(), sku: z.string(), barcode: z.string().nullable(), quantity: z.number().int(), verified: z.boolean() });
const PackageSchema = z.object({
  id: z.string(), number: z.string(), fulfillmentId: z.string(), warehouseId: z.string(), status: z.enum(schema.PACKAGE_STATUSES), barcode: z.string(), boxType: z.string().nullable(),
  weightGrams: z.number().int().nullable(), lengthMm: z.number().int().nullable(), widthMm: z.number().int().nullable(), heightMm: z.number().int().nullable(), shipmentId: z.string().nullable(), packedAt: IsoDate.nullable(),
  items: z.array(PackageLine), version: z.number().int(), createdAt: IsoDate,
}).meta({ id: 'Package' });
const FulfillmentSchema = z.object({
  id: z.string(), number: z.string(), orderId: z.string(), order: z.object({ orderNumber: z.string(), marketplace: z.string(), externalOrderId: z.string(), status: z.string() }).nullable(), warehouseId: z.string(),
  status: z.enum(STATUSES), holdFrom: z.string().nullable(), priority: z.enum(schema.FULFILLMENT_PRIORITIES), routing: z.record(z.string(), z.unknown()).describe('Why this warehouse: strategy, rules that fired, reasons and the ranked candidates'),
  openExceptions: z.number().int(), items: z.array(Item), packages: z.array(z.object({ id: z.string(), number: z.string(), barcode: z.string(), status: z.enum(schema.PACKAGE_STATUSES), boxType: z.string().nullable(), weightGrams: z.number().int().nullable(), lengthMm: z.number().int().nullable(), widthMm: z.number().int().nullable(), heightMm: z.number().int().nullable(), shipmentId: z.string().nullable(), items: z.array(z.object({ fulfillmentItemId: z.string(), variantId: z.string(), quantity: z.number().int(), verified: z.boolean() })) })),
  pickedAt: IsoDate.nullable(), packedAt: IsoDate.nullable(), readyAt: IsoDate.nullable(), shippedAt: IsoDate.nullable(), deliveredAt: IsoDate.nullable(), cancelledAt: IsoDate.nullable(), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
}).meta({ id: 'Fulfillment' });
const TaskSchema = z.object({
  id: z.string(), pickListId: z.string(), fulfillmentId: z.string(), fulfillmentItemId: z.string(), variantId: z.string(), sku: z.string(), barcode: z.string().nullable(), title: z.string().nullable(), binId: z.string().nullable(), binCode: z.string().nullable(),
  binBarcode: z.string().nullable(), sequence: z.number().int(), quantity: z.number().int(), pickedQuantity: z.number().int(), status: z.enum(schema.PICK_TASK_STATUSES), verified: z.boolean(), pickedBy: z.string().nullable(), pickedAt: IsoDate.nullable(), notes: z.string().nullable(),
}).meta({ id: 'PickTask' });
const PickListSchema = z.object({ id: z.string(), number: z.string(), warehouseId: z.string(), status: z.enum(schema.PICK_LIST_STATUSES), assignedTo: z.string().nullable(), startedAt: IsoDate.nullable(), completedAt: IsoDate.nullable(), version: z.number().int(), createdAt: IsoDate, tasks: z.array(TaskSchema) }).meta({ id: 'PickList' });
const ExceptionSchema = z.object({
  id: z.string(), fulfillmentId: z.string(), pickTaskId: z.string().nullable(), kind: z.enum(schema.EXCEPTION_KINDS), status: z.enum(schema.EXCEPTION_STATUSES), details: z.record(z.string(), z.unknown()), resolution: z.record(z.string(), z.unknown()).nullable(),
  raisedBy: z.string().nullable(), resolvedBy: z.string().nullable(), resolvedAt: IsoDate.nullable(), createdAt: IsoDate,
}).meta({ id: 'FulfillmentException' });
const TimelineSchema = z.object({ id: z.number().int(), fromStatus: z.string().nullable(), toStatus: z.string(), actorId: z.string().nullable(), note: z.string().nullable(), metadata: z.record(z.string(), z.unknown()), createdAt: IsoDate });
const Qty = z.number().int().min(1).max(100_000);
const Dims = { boxType: z.string().max(60).nullish(), weightGrams: z.number().int().min(1).max(1_000_000).nullish(), lengthMm: z.number().int().min(1).max(100_000).nullish(), widthMm: z.number().int().min(1).max(100_000).nullish(), heightMm: z.number().int().min(1).max(100_000).nullish() };
const StartBody = z.object({ warehouseIds: z.array(z.uuid()).max(50).optional(), strategy: z.enum(['priority', 'nearest', 'single_warehouse', 'balanced']).optional(), allowSplit: z.boolean().optional(), priority: z.enum(schema.FULFILLMENT_PRIORITIES).optional() }).default({});
const PlanSchema = z.object({
  strategy: z.string(), allocations: z.array(z.object({ warehouseId: z.string(), lines: z.array(z.object({ orderItemId: z.string(), variantId: z.string(), quantity: z.number().int() })) })),
  unallocated: z.array(z.object({ orderItemId: z.string(), variantId: z.string(), quantity: z.number().int() })), reasons: z.array(z.string()),
  candidates: z.array(z.object({ warehouseId: z.string(), code: z.string(), rank: z.number().int(), score: z.number(), canFulfilAll: z.boolean(), fulfilableUnits: z.number().int() })),
});

/** Fulfillment: routing, lifecycle, picking, packing, exceptions. */
export const fulfillmentRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** one request = one transaction; marketplace status pushes queued inside are dispatched only after it commits */
  async function run<T>(req: FastifyRequest, fn: (tx: Tx, ctx: OpCtx, w: Work) => Promise<T>): Promise<T> {
    const vendorId = requireVendor(req);
    const w = new Work();
    const ctx = opCtxFromRequest(req, vendorId);
    const out = await vendorTx(req, (tx) => fn(tx, ctx, w));
    await w.flush(req.server.container);
    return out;
  }
  const can = (req: FastifyRequest, tx: Tx, warehouseId: string, cap: Capability) => assertWarehouseCapability(tx, req.ctx.principal, requireVendor(req), warehouseId, cap);
  /** passes when the user holds ANY of the capabilities (warehouse staff handling an exception: manager, picker or packer) */
  const canAny = async (req: FastifyRequest, tx: Tx, warehouseId: string, caps: Capability[]) => {
    let last: unknown;
    for (const c of caps) { try { await can(req, tx, warehouseId, c); return; } catch (e) { last = e; } }
    throw last;
  };

  // ------------------------------------------------------------ fulfillments
  r.get('/fulfillments', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Fulfillment'], summary: 'List fulfillments', description: 'Users restricted to some warehouses only see those.', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional(), 'filter[orderId]': z.uuid().optional(), 'filter[priority]': z.enum(schema.FULFILLMENT_PRIORITIES).optional() }), response: { 200: paginatedEnvelope(FulfillmentSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, async (tx, vendorId) => {
      const p = await listFulfillments(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], warehouseId: req.query['filter[warehouseId]'], orderId: req.query['filter[orderId]'], priority: req.query['filter[priority]'], allowedWarehouses: await allowedWarehouses(tx, req.ctx.principal, vendorId) });
      return { items: await Promise.all(p.items.map((f) => fulfillmentDetail(tx, vendorId, f.id))), nextCursor: p.nextCursor };
    });
    return paginated(req, page.items as never, { limit: req.query.limit, nextCursor: page.nextCursor });
  });

  r.get('/fulfillments/:id', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Fulfillment'], summary: 'Get a fulfillment (items, packages, routing explanation)', params: IdParamSchema, response: { 200: successEnvelope(FulfillmentSchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const f = await getFulfillment(tx, vendorId, req.params.id);
    await can(req, tx, f.warehouseId, 'read');
    return fulfillmentDetail(tx, vendorId, f.id);
  }) as never));

  r.get('/fulfillments/:id/timeline', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Fulfillment'], summary: 'Fulfillment status timeline', params: IdParamSchema, response: { 200: successEnvelope(z.array(TimelineSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => fulfillmentTimeline(tx, vendorId, req.params.id)) as never));

  r.get('/orders/:id/fulfillment', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Fulfillment'], summary: 'Fulfillments of an order', description: 'An order ships from one warehouse, or from several when stock is split.', params: IdParamSchema, response: { 200: successEnvelope(z.array(FulfillmentSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const p = await listFulfillments(tx, vendorId, { limit: 100, orderId: req.params.id });
    return Promise.all(p.items.reverse().map((f) => fulfillmentDetail(tx, vendorId, f.id)));
  }) as never));

  r.get('/orders/:id/fulfillment/routing-preview', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: {
      tags: ['Fulfillment'], summary: 'Preview order routing', description: 'Which warehouse(s) would fulfil the open lines of this order, and why. Changes nothing. Query overrides mirror the start body.',
      params: IdParamSchema, querystring: z.object({ strategy: z.enum(['priority', 'nearest', 'single_warehouse', 'balanced']).optional(), allowSplit: z.coerce.boolean().optional() }),
      response: { 200: successEnvelope(z.object({ plan: PlanSchema, ruleIds: z.array(z.string()), priority: z.string(), unmappedSkus: z.array(z.string()) })) },
    },
  }, async (req) => ok(req, await run(req, async (tx, ctx) => {
    const x = await previewRouting(tx, ctx, req.params.id, { strategy: req.query.strategy, allowSplit: req.query.allowSplit });
    return { plan: x.plan, ruleIds: x.ruleIds, priority: x.priority, unmappedSkus: x.unmapped };
  }) as never));

  r.post('/orders/:id/fulfillment', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: {
      tags: ['Fulfillment'], summary: 'Start fulfilling an order (routing)',
      description: 'Chooses the warehouse(s) from the routing rules, stock availability and warehouse priority (or your explicit `warehouseIds` / `strategy`), moves the stock reservation to the chosen warehouse and creates one fulfillment per warehouse. A `new` order is confirmed first. 409 when lines are unmapped; 422-style INSUFFICIENT_STOCK when no warehouse has stock.',
      params: IdParamSchema, body: StartBody, response: { 201: successEnvelope(z.object({ fulfillments: z.array(FulfillmentSchema), plan: PlanSchema })) },
    },
  }, async (req, reply) => {
    const out = await run(req, async (tx, ctx, w) => {
      const res = await startFulfillment(tx, ctx, w, req.params.id, req.body);
      for (const f of res.fulfillments) await can(req, tx, f.warehouseId, 'manage');
      return { fulfillments: await Promise.all(res.fulfillments.map((f) => fulfillmentDetail(tx, ctx.vendorId, f.id))), plan: res.plan };
    });
    return created(req, reply, out as never, `/api/v1/orders/${req.params.id}/fulfillment`);
  });

  for (const [path, label, summary] of [['hold', 'hold', 'Put a fulfillment on hold'], ['cancel', 'cancel', 'Cancel a fulfillment (before shipping)']] as const) {
    r.post(`/fulfillments/:id/${path}`, {
      config: { access: { permission: 'fulfillment:write' } },
      schema: { tags: ['Fulfillment'], summary, description: label === 'hold' ? 'Any step before shipping can be parked. `resume` returns to where it was.' : 'Open pick tasks are cancelled, picked units go back to their bin, packages are voided. The order\'s stock reservation is kept (re-route it, or cancel the order to release it).', params: IdParamSchema, body: z.object({ reason: z.string().min(2).max(300) }), response: { 200: successEnvelope(FulfillmentSchema) } },
    }, async (req) => ok(req, await run(req, async (tx, ctx, w) => {
      const f = await getFulfillment(tx, ctx.vendorId, req.params.id);
      await canAny(req, tx, f.warehouseId, ['manage', 'pick', 'pack']);
      if (label === 'hold') await holdFulfillment(tx, ctx, w, req.params.id, req.body.reason); else await cancelFulfillment(tx, ctx, w, req.params.id, req.body.reason);
      return fulfillmentDetail(tx, ctx.vendorId, req.params.id);
    }) as never));
  }
  r.post('/fulfillments/:id/resume', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: { tags: ['Fulfillment'], summary: 'Resume a fulfillment on hold', params: IdParamSchema, response: { 200: successEnvelope(FulfillmentSchema) } },
  }, async (req) => ok(req, await run(req, async (tx, ctx, w) => {
    await canAny(req, tx, (await getFulfillment(tx, ctx.vendorId, req.params.id)).warehouseId, ['manage', 'pick', 'pack']);
    await resumeFulfillment(tx, ctx, w, req.params.id);
    return fulfillmentDetail(tx, ctx.vendorId, req.params.id);
  }) as never));

  // ------------------------------------------------------------ picking
  r.post('/pick-lists', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: { tags: ['Picking'], summary: 'Create a pick list', description: 'For one or more CONFIRMED fulfillments of the same warehouse. Tasks follow the bins holding the stock (walking order). The fulfillments move to `picking`.', body: z.object({ fulfillmentIds: z.array(z.uuid()).min(1).max(100), assignedTo: z.uuid().nullish() }), response: { 201: successEnvelope(PickListSchema) } },
  }, async (req, reply) => {
    const dto = await run(req, async (tx, ctx, w) => {
      const f = await getFulfillment(tx, ctx.vendorId, req.body.fulfillmentIds[0]!);
      await can(req, tx, f.warehouseId, 'pick');
      return createPickList(tx, ctx, w, req.body);
    });
    return created(req, reply, dto as never, `/api/v1/pick-lists/${dto.id}`);
  });
  r.get('/pick-lists', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Picking'], summary: 'List pick lists', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(schema.PICK_LIST_STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional(), 'filter[assignedTo]': z.uuid().optional() }), response: { 200: paginatedEnvelope(PickListSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, async (tx, vendorId) => listPickLists(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], warehouseId: req.query['filter[warehouseId]'], assignedTo: req.query['filter[assignedTo]'], allowedWarehouses: await allowedWarehouses(tx, req.ctx.principal, vendorId) }));
    return paginated(req, page.items as never, { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.get('/pick-lists/:id', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Picking'], summary: 'Get a pick list with its tasks', params: IdParamSchema, response: { 200: successEnvelope(PickListSchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { const l = await getPickList(tx, vendorId, req.params.id); await can(req, tx, l.warehouseId, 'read'); return l; }) as never));
  r.post('/pick-lists/:id/assign', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: { tags: ['Picking'], summary: 'Assign a pick list to a picker', params: IdParamSchema, body: z.object({ userId: z.uuid().nullable() }), response: { 200: successEnvelope(PickListSchema) } },
  }, async (req) => ok(req, await run(req, async (tx, ctx) => {
    const l = await getPickList(tx, ctx.vendorId, req.params.id);
    await canAny(req, tx, l.warehouseId, ['manage']);
    return assignPickList(tx, ctx, req.params.id, req.body.userId);
  }) as never));

  r.get('/pick-tasks', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Picking'], summary: 'List pick tasks', querystring: z.object({ 'filter[pickListId]': z.uuid().optional(), 'filter[fulfillmentId]': z.uuid().optional(), 'filter[status]': z.enum(schema.PICK_TASK_STATUSES).optional() }), response: { 200: successEnvelope(z.array(TaskSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listPickTasks(tx, vendorId, { pickListId: req.query['filter[pickListId]'], fulfillmentId: req.query['filter[fulfillmentId]'], status: req.query['filter[status]'] })) as never));

  const taskRoute = <B extends z.ZodType, T>(path: string, summary: string, description: string, body: B, run2: (tx: Tx, ctx: OpCtx, w: Work, id: string, b: z.infer<B>) => Promise<T>, resp: z.ZodType) => {
    r.post(`/pick-tasks/:id/${path}`, {
      config: { access: { permission: 'fulfillment:write' } },
      schema: { tags: ['Picking'], summary, description, params: IdParamSchema, body, response: { 200: successEnvelope(resp) } },
    }, async (req) => ok(req, await run(req, async (tx, ctx, w) => {
      await can(req, tx, await taskWarehouse(tx, ctx.vendorId, req.params.id), 'pick');
      return run2(tx, ctx, w, req.params.id, req.body as z.infer<B>);
    }) as never));
  };
  taskRoute('scan', 'Scan the item (and bin) at the shelf', 'Verifies the scanned barcode (or SKU) against the task. A wrong code is refused (`wrong_item`) and nothing changes.', z.object({ itemBarcode: z.string().min(1).max(100), binBarcode: z.string().max(100).nullish() }), (tx, ctx, _w, id, b) => scanTask(tx, ctx, id, b), TaskSchema);
  taskRoute('pick', 'Record picked units', 'Needs a prior scan or `itemBarcode` in this call (or `override` for a manual, audited pick). Partial picks are fine: call again for the rest. The last pick moves the fulfillment to `picked`.', z.object({ quantity: Qty, itemBarcode: z.string().max(100).nullish(), override: z.boolean().optional(), note: z.string().max(300).nullish() }), (tx, ctx, w, id, b) => pickTask(tx, ctx, w, id, b), TaskSchema);
  taskRoute('short', 'Report the remaining units as not found (short pick)', 'The missing units leave the books (reasoned stock adjustment), their reservation is released, the order line is flagged and a `pick_short` exception is opened.', z.object({ reason: z.string().max(300).nullish() }), async (tx, ctx, w, id, b) => { const x = await shortPick(tx, ctx, w, id, b); return { task: x.task, exception: toExceptionDto(x.exception) }; }, z.object({ task: TaskSchema, exception: ExceptionSchema }));
  taskRoute('flag', 'Flag a wrong or damaged item', 'Opens a `wrong_item` / `damaged` exception and blocks the task until it is resolved.', z.object({ kind: z.enum(['wrong_item', 'damaged', 'other']), note: z.string().max(300).nullish() }), async (tx, ctx, _w, id, b) => toExceptionDto(await flagTask(tx, ctx, id, b)), ExceptionSchema);

  // ------------------------------------------------------------ packing
  r.get('/packing-tasks', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: {
      tags: ['Packing'], summary: 'Packing queue', description: 'Fulfillments that are picked or being packed, with the units still to put in a package.',
      querystring: z.object({ 'filter[warehouseId]': z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: successEnvelope(z.array(z.object({ fulfillmentId: z.string(), number: z.string(), orderId: z.string(), warehouseId: z.string(), status: z.string(), priority: z.string(), items: z.array(z.object({ fulfillmentItemId: z.string(), sku: z.string(), barcode: z.string().nullable(), variantId: z.string(), picked: z.number().int(), packed: z.number().int(), toPack: z.number().int() })) }))) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => packingTasks(tx, vendorId, { warehouseId: req.query['filter[warehouseId]'], limit: req.query.limit, allowedWarehouses: await allowedWarehouses(tx, req.ctx.principal, vendorId, 'pack') })) as never));

  r.post('/fulfillments/:id/packages', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: { tags: ['Packing'], summary: 'Create a package', description: 'Puts picked units into a new package (one fulfillment can have several). The fulfillment moves to `packing`.', params: IdParamSchema, body: z.object({ ...Dims, items: z.array(z.object({ fulfillmentItemId: z.uuid(), quantity: Qty })).min(1).max(200) }), response: { 201: successEnvelope(PackageSchema) } },
  }, async (req, reply) => {
    const dto = await run(req, async (tx, ctx, w) => {
      const f = await getFulfillment(tx, ctx.vendorId, req.params.id);
      await can(req, tx, f.warehouseId, 'pack');
      return createPackage(tx, ctx, w, req.params.id, req.body);
    });
    return created(req, reply, dto as never, `/api/v1/packages/${dto.id}`);
  });
  r.get('/packages', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Packing'], summary: 'List packages', querystring: z.object({ 'filter[fulfillmentId]': z.uuid().optional(), 'filter[status]': z.enum(schema.PACKAGE_STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional() }), response: { 200: successEnvelope(z.array(PackageSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listPackages(tx, vendorId, { fulfillmentId: req.query['filter[fulfillmentId]'], status: req.query['filter[status]'], warehouseId: req.query['filter[warehouseId]'] })) as never));
  r.get('/packages/:id', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Packing'], summary: 'Get a package', params: IdParamSchema, response: { 200: successEnvelope(PackageSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => packageDetail(tx, vendorId, req.params.id)) as never));
  const pkgRoute = <B extends z.ZodType>(method: 'post' | 'patch', path: string, summary: string, description: string, body: B, fn: (tx: Tx, ctx: OpCtx, w: Work, id: string, b: z.infer<B>) => Promise<unknown>) => {
    r[method](`/packages/:id${path}`, {
      config: { access: { permission: 'fulfillment:write' } },
      schema: { tags: ['Packing'], summary, description, params: IdParamSchema, body, response: { 200: successEnvelope(PackageSchema) } },
    }, async (req) => ok(req, await run(req, async (tx, ctx, w) => {
      await can(req, tx, (await loadPackage(tx, ctx.vendorId, req.params.id)).warehouseId, 'pack');
      return fn(tx, ctx, w, req.params.id, req.body as z.infer<B>);
    }) as never));
  };
  pkgRoute('patch', '', 'Set weight, dimensions and box type', 'Allowed until the package ships.', z.object(Dims), (tx, ctx, _w, id, b) => setDimensions(tx, ctx, id, b));
  pkgRoute('post', '/scan', 'Scan an item into the package (barcode verification)', 'The code must belong to one of the package items; the line is marked verified.', z.object({ itemBarcode: z.string().min(1).max(100) }), (tx, ctx, _w, id, b) => scanPackageItem(tx, ctx, id, b));
  pkgRoute('post', '/close', 'Close (seal) the package', 'Needs a weight and every item verified by a scan (or `override`). When all picked units are packed the fulfillment becomes `packed`.', z.object({ ...Dims, override: z.boolean().optional() }).default({}), (tx, ctx, w, id, b) => closePackage(tx, ctx, w, id, b));
  pkgRoute('post', '/cancel', 'Cancel a package that has not shipped', 'Its units become packable again.', z.object({ reason: z.string().max(300).nullish() }).default({}), (tx, ctx, w, id, b) => cancelPackage(tx, ctx, w, id, b.reason));

  // ------------------------------------------------------------ exceptions
  r.get('/fulfillment-exceptions', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Fulfillment'], summary: 'List fulfillment exceptions', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(schema.EXCEPTION_STATUSES).optional(), 'filter[kind]': z.enum(schema.EXCEPTION_KINDS).optional(), 'filter[fulfillmentId]': z.uuid().optional() }), response: { 200: paginatedEnvelope(ExceptionSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, async (tx, vendorId) => listExceptions(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], kind: req.query['filter[kind]'], fulfillmentId: req.query['filter[fulfillmentId]'], allowedWarehouses: await allowedWarehouses(tx, req.ctx.principal, vendorId) }));
    return paginated(req, page.items.map(toExceptionDto) as never, { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.post('/fulfillment-exceptions', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: { tags: ['Fulfillment'], summary: 'Raise an exception manually', body: z.object({ fulfillmentId: z.uuid(), kind: z.enum(['damaged', 'wrong_item', 'pack_issue', 'insufficient_stock', 'address_issue', 'other']), details: z.record(z.string(), z.unknown()).default({}) }), response: { 201: successEnvelope(ExceptionSchema) } },
  }, async (req, reply) => {
    const x = await run(req, async (tx, ctx) => { const f = await getFulfillment(tx, ctx.vendorId, req.body.fulfillmentId); await canAny(req, tx, f.warehouseId, ['manage', 'pick', 'pack']); return raiseException(tx, ctx, req.body.fulfillmentId, req.body.kind, req.body.details); });
    return created(req, reply, toExceptionDto(x) as never, `/api/v1/fulfillment-exceptions/${x.id}`);
  });
  r.get('/fulfillment-exceptions/:id', {
    config: { access: { permission: 'fulfillment:read' } },
    schema: { tags: ['Fulfillment'], summary: 'Get an exception', params: IdParamSchema, response: { 200: successEnvelope(ExceptionSchema) } },
  }, async (req) => ok(req, toExceptionDto(await vendorTx(req, (tx, vendorId) => getException(tx, vendorId, req.params.id))) as never));
  r.post('/fulfillment-exceptions/:id/resolve', {
    config: { access: { permission: 'fulfillment:write' } },
    schema: { tags: ['Fulfillment'], summary: 'Resolve or dismiss an exception', description: '`action`: none (acknowledge), hold (park the fulfillment) or cancel_fulfillment.', params: IdParamSchema, body: z.object({ status: z.enum(['resolved', 'dismissed']).default('resolved'), note: z.string().max(300).nullish(), action: z.enum(['none', 'hold', 'cancel_fulfillment']).default('none') }), response: { 200: successEnvelope(ExceptionSchema) } },
  }, async (req) => ok(req, toExceptionDto(await run(req, async (tx, ctx, w) => {
    const x = await getException(tx, ctx.vendorId, req.params.id);
    const f = await getFulfillment(tx, ctx.vendorId, x.fulfillmentId);
    await canAny(req, tx, f.warehouseId, ['manage', 'pick', 'pack']);
    return resolveException(tx, ctx, w, req.params.id, req.body);
  })) as never));
};
