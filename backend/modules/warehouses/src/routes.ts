import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, created, emit, ok, paginated, vendorTx } from '@oms/module-kit';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import * as svc from './service';

export const WarehouseSchema = z
  .object({
    id: z.string(),
    code: z.string().describe('Short vendor-unique code, e.g. BLR-1'),
    name: z.string(),
    address: z.record(z.string(), z.unknown()),
    status: z.enum(['active', 'inactive']),
    isDefault: z.boolean().describe('Exactly one active warehouse is the default; it receives stock first'),
    priority: z.number().int().describe('Allocation order after the default (lower = earlier)'),
    version: z.number().int(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'Warehouse' });

const CodeSchema = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, - and _').transform((s) => s.toUpperCase());
const AddressSchema = z.object({ line1: z.string().max(200), line2: z.string().max(200).optional(), city: z.string().max(100), state: z.string().max(100), pincode: z.string().max(12), country: z.string().length(2).default('IN') }).partial().passthrough();
const CreateBody = z.object({ code: CodeSchema, name: z.string().trim().min(2).max(120), address: AddressSchema.optional(), priority: z.number().int().min(0).max(10_000).optional(), isDefault: z.boolean().optional() });
const UpdateBody = z.object({ code: CodeSchema, name: z.string().trim().min(2).max(120), address: AddressSchema, priority: z.number().int().min(0).max(10_000), isDefault: z.boolean(), status: z.enum(['active', 'inactive']), version: z.number().int() }).partial();
const ListQuery = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({ 'filter[status]': z.enum(['active', 'inactive']).optional() });

export const warehouseRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Warehouses'];

  r.post('/warehouses', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Create a warehouse', description: 'The first warehouse becomes the default. Stock is held per warehouse in /inventory.', body: CreateBody, response: { 201: successEnvelope(WarehouseSchema) } },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const w = svc.toWarehouseDto(await svc.createWarehouse(tx, vendorId, req.body));
      await audit(tx, req, { action: 'warehouse.create', resourceType: 'warehouse', resourceId: w.id, after: { code: w.code, isDefault: w.isDefault } });
      await emit(tx, req, { type: 'warehouse.created', aggregateType: 'warehouse', aggregateId: w.id, payload: { code: w.code } });
      return w;
    });
    return created(req, reply, dto, `/api/v1/warehouses/${dto.id}`);
  });

  r.get('/warehouses', {
    config: { access: { permission: 'warehouses:read' } },
    schema: { tags: TAGS, summary: 'List warehouses', querystring: ListQuery, response: { 200: paginatedEnvelope(WarehouseSchema) } },
  }, async (req) => {
    const page = await vendorTx(req, (tx, vendorId) => svc.listWarehouses(tx, vendorId, { limit: req.query.limit, cursor: req.query.cursor, q: req.query.q, status: req.query['filter[status]'] }));
    return paginated(req, page.items.map(svc.toWarehouseDto), { limit: req.query.limit, nextCursor: page.nextCursor });
  });

  r.get('/warehouses/:id', {
    config: { access: { permission: 'warehouses:read' } },
    schema: { tags: TAGS, summary: 'Get a warehouse', params: IdParamSchema, response: { 200: successEnvelope(WarehouseSchema) } },
  }, async (req) => ok(req, svc.toWarehouseDto(await vendorTx(req, (tx, vendorId) => svc.getWarehouseRow(tx, vendorId, req.params.id)))));

  r.patch('/warehouses/:id', {
    config: { access: { permission: 'warehouses:write' } },
    schema: {
      tags: TAGS,
      summary: 'Update / deactivate a warehouse',
      description: 'Send `version` for optimistic concurrency. The default warehouse cannot be deactivated or unset; a warehouse with reserved stock cannot be deactivated.',
      params: IdParamSchema,
      body: UpdateBody,
      response: { 200: successEnvelope(WarehouseSchema) },
    },
  }, async (req) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const { before, after } = await svc.updateWarehouse(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'warehouse.update', resourceType: 'warehouse', resourceId: after.id, before: { status: before.status, isDefault: before.isDefault, name: before.name }, after: { status: after.status, isDefault: after.isDefault, name: after.name } });
      await emit(tx, req, { type: before.status === 'active' && after.status === 'inactive' ? 'warehouse.deactivated' : 'warehouse.updated', aggregateType: 'warehouse', aggregateId: after.id, payload: { code: after.code } });
      return svc.toWarehouseDto(after);
    });
    return ok(req, dto);
  });

  r.delete('/warehouses/:id', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Delete a warehouse', description: 'Only an empty, non-default warehouse. Use PATCH status=inactive to retire one that holds history.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const w = await svc.deleteWarehouse(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'warehouse.delete', resourceType: 'warehouse', resourceId: w.id, before: { code: w.code } });
      await emit(tx, req, { type: 'warehouse.deactivated', aggregateType: 'warehouse', aggregateId: w.id, payload: { code: w.code, deleted: true } });
    });
    return ok(req, { id: req.params.id, deleted: true as const });
  });
};
