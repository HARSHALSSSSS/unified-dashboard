import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema, type Tx } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { created, ok, opCtxFromRequest, paginated, requireVendor, vendorTx, type OpCtx } from '@oms/module-kit';
import { Work, getFulfillment } from '@oms/mod-fulfillment';
import { allowedWarehouses, assertWarehouseCapability } from '@oms/mod-warehouses';
import { SHIPMENT_STATUSES, TRACKING_STATUSES } from './domain';
import {
  actOnNdr, cancelManifest, cancelShipment, closeManifest, createManifest, createShipment, dispatchManifest, dispatchShipment, enableProvider, getLabel, getManifest, getNdr, getShipment, ingestTracking, latestShipmentOfOrder,
  listManifests, listNdr, listShipments, listVendorProviders, providerCatalog, refreshTracking, simulateTracking, toManifestDto, toNdrDto, toShipmentDto, trackingEvents, updateProvider,
} from './service';

const ShipmentSchema = z.object({
  id: z.string(), number: z.string(), fulfillmentId: z.string(), orderId: z.string(), warehouseId: z.string(), providerCode: z.string(), service: z.string().nullable(), carrier: z.string().nullable(), awb: z.string().nullable(), trackingUrl: z.string().nullable(),
  hasLabel: z.boolean(), status: z.enum(SHIPMENT_STATUSES), costMinor: z.number().int().nullable(), codAmountMinor: z.number().int().nullable(), weightGrams: z.number().int().nullable(), manifestId: z.string().nullable(), attempts: z.number().int(), isRto: z.boolean(),
  estimatedDeliveryAt: IsoDate.nullable(), dispatchedAt: IsoDate.nullable(), deliveredAt: IsoDate.nullable(), rtoDeliveredAt: IsoDate.nullable(), cancelledAt: IsoDate.nullable(), lastTrackedAt: IsoDate.nullable(), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
}).meta({ id: 'Shipment' });
const ManifestSchema = z.object({
  id: z.string(), number: z.string(), warehouseId: z.string(), providerCode: z.string(), status: z.enum(schema.MANIFEST_STATUSES), closedAt: IsoDate.nullable(), dispatchedAt: IsoDate.nullable(), shipmentCount: z.number().int(),
  shipments: z.array(z.object({ id: z.string(), number: z.string(), awb: z.string().nullable(), orderId: z.string(), weightGrams: z.number().int().nullable(), status: z.enum(SHIPMENT_STATUSES) })), version: z.number().int(), createdAt: IsoDate,
}).meta({ id: 'Manifest' });
const NdrSchema = z.object({
  id: z.string(), shipmentId: z.string(), orderId: z.string(), attemptNo: z.number().int(), reasonCode: z.string(), reasonText: z.string().nullable(), status: z.enum(schema.NDR_STATUSES), action: z.enum(schema.NDR_ACTIONS).nullable(),
  actionBy: z.string().nullable(), nextAttemptAt: IsoDate.nullable(), resolvedAt: IsoDate.nullable(), createdAt: IsoDate,
}).meta({ id: 'NdrCase' });
const VendorProviderSchema = z.object({ id: z.string(), providerCode: z.string(), label: z.string(), status: z.enum(['active', 'disabled']), isDefault: z.boolean(), config: z.record(z.string(), z.unknown()), version: z.number().int(), createdAt: IsoDate }).meta({ id: 'VendorShippingProvider' });
const TrackingEventSchema = z.object({ id: z.number().int(), status: z.enum(SHIPMENT_STATUSES), rawStatus: z.string().nullable(), location: z.string().nullable(), note: z.string().nullable(), source: z.string(), occurredAt: IsoDate });
const TrackingResultSchema = z.object({ shipment: ShipmentSchema, applied: z.number().int().describe('Updates that moved the shipment'), recorded: z.number().int().describe('New events stored'), duplicates: z.number().int() });
/** ids the system writes itself; a client cannot use them to pre-empt (and so suppress) the real event */
const RESERVED_EVENT_IDS = ['label-created', 'dispatched', 'cancelled'];
const Barcodes = z.object({ packageBarcodes: z.array(z.string().min(1).max(100)).max(200).optional().describe('What was scanned at the dock; when given, every package of the shipment must be among them') }).default({});

/** Shipping: providers, shipments, labels, manifests, dispatch, tracking, NDR. */
export const shippingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Shipping'];
  async function run<T>(req: FastifyRequest, fn: (tx: Tx, ctx: OpCtx, w: Work) => Promise<T>): Promise<T> {
    const vendorId = requireVendor(req);
    const w = new Work();
    const ctx = opCtxFromRequest(req, vendorId);
    const out = await vendorTx(req, (tx) => fn(tx, ctx, w));
    await w.flush(req.server.container);
    return out;
  }
  const ctxOf = (req: FastifyRequest) => opCtxFromRequest(req, requireVendor(req));
  const can = (req: FastifyRequest, tx: Tx, warehouseId: string) => assertWarehouseCapability(tx, req.ctx.principal, requireVendor(req), warehouseId, 'dispatch');
  /** warehouse-restricted staff act only on shipments of THEIR warehouses (cancel, tracking, NDR, refresh, simulate) */
  const guardShipment = async (req: FastifyRequest): Promise<void> => {
    await vendorTx(req, async (tx, vendorId) => { await can(req, tx, (await getShipment(tx, vendorId, (req.params as { id: string }).id)).warehouseId); });
  };
  const guardNdr = async (req: FastifyRequest): Promise<void> => {
    await vendorTx(req, async (tx, vendorId) => { const n = await getNdr(tx, vendorId, (req.params as { id: string }).id); await can(req, tx, (await getShipment(tx, vendorId, n.shipmentId)).warehouseId); });
  };

  // ------------------------------------------------------------ providers
  r.get('/shipping/providers/catalog', {
    config: { access: { permission: 'shipping:read' } },
    schema: {
      tags: TAGS, summary: 'Available shipping providers', description: 'Every provider the platform can talk to, with its capabilities and the (non-secret) settings it accepts. No courier is hardcoded: a new provider is one adapter implementing the same interface.',
      response: { 200: successEnvelope(z.array(z.object({ code: z.string(), name: z.string(), description: z.string(), capabilities: z.object({ labels: z.boolean(), polling: z.boolean(), cancel: z.boolean(), reattempt: z.boolean(), rto: z.boolean(), manifest: z.boolean() }), configFields: z.array(z.object({ key: z.string(), description: z.string(), required: z.boolean() })) }))) },
    },
  }, async (req) => ok(req, providerCatalog(req.server.container)));
  r.get('/shipping/providers', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Providers enabled for this vendor', response: { 200: successEnvelope(z.array(VendorProviderSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listVendorProviders(tx, vendorId))));
  r.post('/shipping/providers', {
    config: { access: { permission: 'shipping:configure' } },
    schema: { tags: TAGS, summary: 'Enable a shipping provider', description: 'The first provider becomes the default. `manual` always works without being enabled.', body: z.object({ providerCode: z.string().min(2).max(40), label: z.string().max(80).optional(), config: z.record(z.string(), z.unknown()).default({}), isDefault: z.boolean().optional() }), response: { 201: successEnvelope(VendorProviderSchema) } },
  }, async (req, reply) => {
    const dto = await run(req, (tx, ctx) => enableProvider(tx, ctx, req.body));
    return created(req, reply, dto, `/api/v1/shipping/providers/${dto.id}`);
  });
  r.patch('/shipping/providers/:id', {
    config: { access: { permission: 'shipping:configure' } },
    schema: { tags: TAGS, summary: 'Update / disable a shipping provider or make it the default', params: IdParamSchema, body: z.object({ label: z.string().max(80).optional(), config: z.record(z.string(), z.unknown()).optional(), status: z.enum(['active', 'disabled']).optional(), isDefault: z.boolean().optional() }), response: { 200: successEnvelope(VendorProviderSchema) } },
  }, async (req) => ok(req, await run(req, (tx, ctx) => updateProvider(tx, ctx, req.params.id, req.body))));

  // ------------------------------------------------------------ shipments
  r.post('/shipments', {
    config: { access: { permission: 'shipping:write' } },
    schema: {
      tags: TAGS, summary: 'Create a shipment (label) for a packed fulfillment',
      description: 'Books the parcel(s) with the chosen provider (default provider when omitted), stores the label and moves the fulfillment to `ready_to_ship`. The provider call is made outside the database transaction; if saving fails afterwards the booking is cancelled. `manual` accepts your own `awb` / `carrier`.',
      body: z.object({ fulfillmentId: z.uuid(), providerCode: z.string().max(40).optional(), service: z.string().max(60).nullish(), manual: z.object({ awb: z.string().min(3).max(80).optional(), carrier: z.string().max(80).optional(), trackingUrl: z.url({ protocol: /^https$/ }).optional() }).optional() }),
      response: { 201: successEnvelope(ShipmentSchema) },
    },
  }, async (req, reply) => {
    await vendorTx(req, async (tx, vendorId) => { const f = await getFulfillment(tx, vendorId, req.body.fulfillmentId); await can(req, tx, f.warehouseId); });
    const s = await createShipment(ctxOf(req), req.body);
    return created(req, reply, toShipmentDto(s), `/api/v1/shipments/${s.id}`);
  });
  r.get('/shipments', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'List shipments', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(SHIPMENT_STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional(), 'filter[orderId]': z.uuid().optional(), 'filter[providerCode]': z.string().optional(), 'filter[awb]': z.string().optional() }), response: { 200: paginatedEnvelope(ShipmentSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, async (tx, vendorId) => listShipments(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], warehouseId: req.query['filter[warehouseId]'], orderId: req.query['filter[orderId]'], providerCode: req.query['filter[providerCode]'], awb: req.query['filter[awb]'], allowedWarehouses: await allowedWarehouses(tx, req.ctx.principal, vendorId) }));
    return paginated(req, page.items.map(toShipmentDto), { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.get('/orders/:id/shipments', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Shipments of an order', params: IdParamSchema, response: { 200: successEnvelope(z.array(ShipmentSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => latestShipmentOfOrder(tx, vendorId, req.params.id))).map(toShipmentDto)));
  r.get('/shipments/:id', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Get a shipment', params: IdParamSchema, response: { 200: successEnvelope(ShipmentSchema) } },
  }, async (req) => ok(req, toShipmentDto(await vendorTx(req, (tx, vendorId) => getShipment(tx, vendorId, req.params.id)))));
  r.get('/shipments/:id/label', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Get the shipping label', description: '`format` text = printable text label, pdf_base64 = base64 PDF.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ shipmentId: z.string(), awb: z.string().nullable(), format: z.enum(['text', 'pdf_base64']), content: z.string() })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getLabel(tx, vendorId, req.params.id))));
  r.get('/shipments/:id/tracking', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Delivery tracking timeline', params: IdParamSchema, response: { 200: successEnvelope(z.array(TrackingEventSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => trackingEvents(tx, vendorId, req.params.id))));
  r.post('/shipments/:id/tracking-events', {
    preHandler: guardShipment,
    config: { access: { permission: 'shipping:write' } },
    schema: {
      tags: TAGS, summary: 'Record tracking updates', description: 'For the manual provider (staff) and for courier webhook adapters. Idempotent per `eventId`; an update that the shipment state machine does not allow is stored but does not change the shipment.',
      params: IdParamSchema, body: z.object({ events: z.array(z.object({ eventId: z.string().min(1).max(120).refine((v) => !RESERVED_EVENT_IDS.includes(v) && !v.startsWith('auto-rto-') && !v.startsWith('ndr-rto-') && !v.startsWith('sim-'), 'reserved event id'), status: z.enum(TRACKING_STATUSES).refine((v) => v !== 'dispatched', 'dispatching is done with POST /shipments/{id}/dispatch'), rawStatus: z.string().max(120).optional(), location: z.string().max(200).nullish(), note: z.string().max(500).nullish(), occurredAt: z.coerce.date().refine((d) => d.getTime() < Date.now() + 5 * 60_000, 'occurredAt cannot be in the future') })).min(1).max(100) }),
      response: { 200: successEnvelope(TrackingResultSchema) },
    },
  }, async (req) => {
    const res = await ingestTracking(ctxOf(req), req.params.id, req.body.events.map((e) => ({ ...e, eventId: e.eventId })), 'manual');
    return ok(req, { shipment: toShipmentDto(res.shipment), applied: res.applied, recorded: res.recorded, duplicates: res.duplicates });
  });
  r.post('/shipments/:id/refresh-tracking', {
    preHandler: guardShipment,
    config: { access: { permission: 'shipping:write' } },
    schema: { tags: TAGS, summary: 'Ask the provider for the latest tracking', description: 'Providers that cannot be polled (manual, sandbox) simply report nothing new.', params: IdParamSchema, response: { 200: successEnvelope(TrackingResultSchema) } },
  }, async (req) => {
    const res = await refreshTracking(ctxOf(req), req.params.id);
    return ok(req, { shipment: toShipmentDto(res.shipment), applied: res.applied, recorded: res.recorded, duplicates: res.duplicates });
  });
  r.post('/shipments/:id/simulate', {
    preHandler: guardShipment,
    config: { access: { permission: 'shipping:write' } },
    schema: {
      tags: TAGS, summary: 'Simulate a courier event (sandbox courier only)', description: 'Pushes an event through the same path real tracking uses (state machine, fulfillment/order updates, NDR/RTO). Refused for real providers.',
      params: IdParamSchema, body: z.object({ status: z.enum(TRACKING_STATUSES), reason: z.string().max(120).nullish(), note: z.string().max(300).nullish(), location: z.string().max(120).nullish() }), response: { 200: successEnvelope(TrackingResultSchema) },
    },
  }, async (req) => {
    const res = await simulateTracking(ctxOf(req), req.params.id, req.body);
    return ok(req, { shipment: toShipmentDto(res.shipment), applied: res.applied, recorded: res.recorded, duplicates: res.duplicates });
  });
  r.post('/shipments/:id/dispatch', {
    config: { access: { permission: 'shipping:write' } },
    schema: { tags: TAGS, summary: 'Dispatch (hand over to the courier)', description: 'The fulfillment becomes `shipped`, the order `dispatched` with the AWB (the marketplace is told) and the stock reservation is consumed.', params: IdParamSchema, body: Barcodes, response: { 200: successEnvelope(ShipmentSchema) } },
  }, async (req) => ok(req, toShipmentDto(await run(req, async (tx, ctx, w) => { await can(req, tx, (await getShipment(tx, ctx.vendorId, req.params.id)).warehouseId); return dispatchShipment(tx, ctx, w, req.params.id, req.body); }))));
  r.post('/shipments/:id/cancel', {
    preHandler: guardShipment,
    config: { access: { permission: 'shipping:write' } },
    schema: { tags: TAGS, summary: 'Cancel a shipment before dispatch', description: 'The booking is cancelled at the provider, the packages are released and the fulfillment returns to `packed`.', params: IdParamSchema, body: z.object({ reason: z.string().max(300).nullish() }).default({}), response: { 200: successEnvelope(ShipmentSchema) } },
  }, async (req) => ok(req, toShipmentDto(await cancelShipment(ctxOf(req), req.params.id, req.body.reason))));

  // ------------------------------------------------------------ manifests
  r.post('/manifests', {
    config: { access: { permission: 'shipping:write' } },
    schema: { tags: TAGS, summary: 'Create a manifest from labelled shipments', description: 'Same warehouse, same provider. The shipments become `manifested`.', body: z.object({ warehouseId: z.uuid(), providerCode: z.string().max(40).optional(), shipmentIds: z.array(z.uuid()).min(1).max(500) }), response: { 201: successEnvelope(ManifestSchema) } },
  }, async (req, reply) => {
    const res = await run(req, async (tx, ctx) => { await can(req, tx, req.body.warehouseId); return createManifest(tx, ctx, req.body); });
    return created(req, reply, toManifestDto(res.m, res.shipments), `/api/v1/manifests/${res.m.id}`);
  });
  r.get('/manifests', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'List manifests', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(schema.MANIFEST_STATUSES).optional(), 'filter[warehouseId]': z.uuid().optional() }), response: { 200: paginatedEnvelope(ManifestSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => listManifests(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], warehouseId: req.query['filter[warehouseId]'] }));
    return paginated(req, page.items.map((m) => toManifestDto(m)), { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.get('/manifests/:id', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Get a manifest with its shipments (the hand-over document)', params: IdParamSchema, response: { 200: successEnvelope(ManifestSchema) } },
  }, async (req) => { const x = await vendorTx(req, (tx, vendorId) => getManifest(tx, vendorId, req.params.id)); return ok(req, toManifestDto(x.m, x.shipments)); });
  for (const [path, summary, fn, body] of [
    ['close', 'Close a manifest (no more shipments can be added)', (tx: Tx, ctx: OpCtx, _w: Work, id: string) => closeManifest(tx, ctx, id), z.object({}).default({})],
    ['dispatch', 'Dispatch a closed manifest: hand every shipment to the courier', (tx: Tx, ctx: OpCtx, w: Work, id: string, b?: { packageBarcodes?: string[] }) => dispatchManifest(tx, ctx, w, id, b), Barcodes],
    ['cancel', 'Cancel a manifest (shipments go back to label_ready)', (tx: Tx, ctx: OpCtx, _w: Work, id: string) => cancelManifest(tx, ctx, id), z.object({}).default({})],
  ] as const) {
    r.post(`/manifests/:id/${path}`, {
      config: { access: { permission: 'shipping:write' } },
      schema: { tags: TAGS, summary, params: IdParamSchema, body, response: { 200: successEnvelope(ManifestSchema) } },
    }, async (req) => { const x = await run(req, async (tx, ctx, w) => { const m = await getManifest(tx, ctx.vendorId, req.params.id); await can(req, tx, m.m.warehouseId); return fn(tx, ctx, w, req.params.id, req.body as never); }); return ok(req, toManifestDto(x.m, x.shipments)); });
  }

  // ------------------------------------------------------------ NDR
  r.get('/ndr-cases', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'List non-delivery reports (failed delivery attempts)', querystring: PaginationQuerySchema.extend({ 'filter[status]': z.enum(schema.NDR_STATUSES).optional(), 'filter[shipmentId]': z.uuid().optional() }), response: { 200: paginatedEnvelope(NdrSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => listNdr(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, status: req.query['filter[status]'], shipmentId: req.query['filter[shipmentId]'] }));
    return paginated(req, page.items.map(toNdrDto), { limit: req.query.limit, nextCursor: page.nextCursor });
  });
  r.get('/ndr-cases/:id', {
    config: { access: { permission: 'shipping:read' } },
    schema: { tags: TAGS, summary: 'Get an NDR case', params: IdParamSchema, response: { 200: successEnvelope(NdrSchema) } },
  }, async (req) => ok(req, toNdrDto(await vendorTx(req, (tx, vendorId) => getNdr(tx, vendorId, req.params.id)))));
  r.post('/ndr-cases/:id/action', {
    preHandler: guardNdr,
    config: { access: { permission: 'shipping:write' } },
    schema: {
      tags: TAGS, summary: 'Decide what to do about a failed delivery', description: '`reattempt` (optionally with a date), `rto` (return to origin), `update_address`, `contact_customer`. After the maximum number of failed attempts the shipment goes RTO automatically.',
      params: IdParamSchema, body: z.object({ action: z.enum(schema.NDR_ACTIONS), nextAttemptAt: z.coerce.date().nullish(), note: z.string().max(300).nullish() }), response: { 200: successEnvelope(z.object({ ndr: NdrSchema, shipment: ShipmentSchema })) },
    },
  }, async (req) => { const x = await actOnNdr(ctxOf(req), req.params.id, req.body); return ok(req, { ndr: toNdrDto(x.ndr), shipment: toShipmentDto(x.shipment) }); });
};
