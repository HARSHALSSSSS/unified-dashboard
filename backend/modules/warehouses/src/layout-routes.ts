import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { Errors } from '@oms/shared';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { audit, created, ok, vendorTx } from '@oms/module-kit';
import * as svc from './layout';

const CODE = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/, 'letters, digits and . _ / - only').transform((s) => s.toUpperCase());
const Deleted = z.object({ id: z.string(), deleted: z.literal(true) });

const LocationSchema = z.object({ id: z.string(), warehouseId: z.string(), code: z.string(), name: z.string(), type: z.enum(schema.LOCATION_TYPES), status: z.enum(['active', 'inactive']), version: z.number().int(), createdAt: IsoDate }).meta({ id: 'WarehouseLocation' });
const BinSchema = z.object({
  id: z.string(), warehouseId: z.string(), locationId: z.string().nullable(), code: z.string(), barcode: z.string().nullable().describe('Scanned to confirm "I am at this bin"'), capacity: z.number().int().nullable(),
  pickable: z.boolean(), status: z.enum(schema.BIN_STATUSES), version: z.number().int(), createdAt: IsoDate,
}).meta({ id: 'WarehouseBin' });
const CapabilitySchema = z.enum(schema.WAREHOUSE_CAPABILITIES);
const MemberSchema = z.object({ id: z.string(), warehouseId: z.string(), userId: z.string(), role: z.enum(schema.WAREHOUSE_ROLES), capabilities: z.array(CapabilitySchema).describe('Extra capabilities on top of the role'), effectiveCapabilities: z.array(CapabilitySchema), email: z.string().optional(), fullName: z.string().optional(), createdAt: IsoDate }).meta({ id: 'WarehouseMember' });

/** Zones, bins and the people who work in a warehouse (mounted next to the warehouse CRUD routes). */
export const warehouseLayoutRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Warehouses'];

  // ---- locations
  r.post('/warehouses/:id/locations', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Add a location (zone) to a warehouse', description: 'e.g. RECEIVING, STORAGE-A, PACKING, DISPATCH, RETURNS, QUARANTINE.', params: IdParamSchema, body: z.object({ code: CODE, name: z.string().trim().min(2).max(80), type: z.enum(schema.LOCATION_TYPES).default('storage') }), response: { 201: successEnvelope(LocationSchema) } },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const row = await svc.createLocation(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'warehouse_location.create', resourceType: 'warehouse_location', resourceId: row.id, after: { warehouseId: req.params.id, code: row.code, type: row.type } });
      return svc.toLocationDto(row);
    });
    return created(req, reply, dto, `/api/v1/warehouse-locations/${dto.id}`);
  });
  r.get('/warehouses/:id/locations', {
    config: { access: { permission: 'warehouses:read' } },
    schema: { tags: TAGS, summary: 'List a warehouse\'s locations', params: IdParamSchema, response: { 200: successEnvelope(z.array(LocationSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => svc.listLocations(tx, vendorId, req.params.id))).map(svc.toLocationDto)));
  r.patch('/warehouse-locations/:id', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Update a location', params: IdParamSchema, body: z.object({ name: z.string().trim().min(2).max(80), type: z.enum(schema.LOCATION_TYPES), status: z.enum(['active', 'inactive']) }).partial(), response: { 200: successEnvelope(LocationSchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const { before, after } = await svc.updateLocation(tx, vendorId, req.params.id, req.body);
    await audit(tx, req, { action: 'warehouse_location.update', resourceType: 'warehouse_location', resourceId: after.id, before: { name: before.name, type: before.type, status: before.status }, after: { name: after.name, type: after.type, status: after.status } });
    return svc.toLocationDto(after);
  })));
  r.delete('/warehouse-locations/:id', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Delete an empty location', params: IdParamSchema, response: { 200: successEnvelope(Deleted) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => { const l = await svc.deleteLocation(tx, vendorId, req.params.id); await audit(tx, req, { action: 'warehouse_location.delete', resourceType: 'warehouse_location', resourceId: l.id, before: { code: l.code } }); });
    return ok(req, { id: req.params.id, deleted: true as const });
  });

  // ---- bins
  const BinBody = z.object({ code: CODE, barcode: z.string().trim().min(3).max(64).nullish(), locationId: z.uuid().nullish(), capacity: z.number().int().min(0).max(1_000_000).nullish(), pickable: z.boolean().default(true) });
  r.post('/warehouses/:id/bins', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Add a bin to a warehouse', description: 'A bin is the smallest place stock is stored (shelf / tote). Its barcode is unique per vendor and is what pickers scan.', params: IdParamSchema, body: BinBody, response: { 201: successEnvelope(BinSchema) } },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const row = await svc.createBin(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'warehouse_bin.create', resourceType: 'warehouse_bin', resourceId: row.id, after: { warehouseId: req.params.id, code: row.code, barcode: row.barcode } });
      return svc.toBinDto(row);
    });
    return created(req, reply, dto, `/api/v1/warehouse-bins/${dto.id}`);
  });
  r.get('/warehouses/:id/bins', {
    config: { access: { permission: 'warehouses:read' } },
    schema: { tags: TAGS, summary: 'List a warehouse\'s bins', params: IdParamSchema, response: { 200: successEnvelope(z.array(BinSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => svc.listBins(tx, vendorId, req.params.id))).map(svc.toBinDto)));
  r.get('/warehouse-bins/by-barcode/:barcode', {
    config: { access: { permission: 'warehouses:read' } },
    schema: { tags: TAGS, summary: 'Look a bin up by its barcode (scan)', params: z.object({ barcode: z.string().min(1).max(64) }), response: { 200: successEnvelope(BinSchema) } },
  }, async (req) => {
    const bin = await vendorTx(req, (tx, vendorId) => svc.findBinByBarcode(tx, vendorId, req.params.barcode));
    if (!bin) throw Errors.notFound('Bin');
    return ok(req, svc.toBinDto(bin));
  });
  r.patch('/warehouse-bins/:id', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Update a bin', params: IdParamSchema, body: BinBody.omit({ code: true }).partial().extend({ status: z.enum(schema.BIN_STATUSES).optional() }), response: { 200: successEnvelope(BinSchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const { before, after } = await svc.updateBin(tx, vendorId, req.params.id, req.body);
    await audit(tx, req, { action: 'warehouse_bin.update', resourceType: 'warehouse_bin', resourceId: after.id, before: { status: before.status, pickable: before.pickable, barcode: before.barcode }, after: { status: after.status, pickable: after.pickable, barcode: after.barcode } });
    return svc.toBinDto(after);
  })));
  r.delete('/warehouse-bins/:id', {
    config: { access: { permission: 'warehouses:write' } },
    schema: { tags: TAGS, summary: 'Delete an empty bin', params: IdParamSchema, response: { 200: successEnvelope(Deleted) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => { const b = await svc.deleteBin(tx, vendorId, req.params.id); await audit(tx, req, { action: 'warehouse_bin.delete', resourceType: 'warehouse_bin', resourceId: b.id, before: { code: b.code } }); });
    return ok(req, { id: req.params.id, deleted: true as const });
  });

  // ---- members
  r.post('/warehouses/:id/members', {
    config: { access: { permission: 'warehouses:admin' } },
    schema: {
      tags: TAGS,
      summary: 'Assign a user to a warehouse',
      description: 'Roles: manager (everything), picker, packer, receiver, dispatcher, viewer. `capabilities` add to the role. Once a user is assigned to ANY warehouse they can only act in their assigned warehouses and only with these capabilities (users with no assignment are governed by their account role alone).',
      params: IdParamSchema,
      body: z.object({ userId: z.uuid(), role: z.enum(schema.WAREHOUSE_ROLES), capabilities: z.array(CapabilitySchema).max(10).optional() }),
      response: { 201: successEnvelope(MemberSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const row = await svc.addMember(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'warehouse_member.assign', resourceType: 'warehouse_member', resourceId: row.id, after: { warehouseId: req.params.id, userId: row.userId, role: row.role, capabilities: row.capabilities } });
      return svc.toMemberDto(row);
    });
    return created(req, reply, dto);
  });
  r.get('/warehouses/:id/members', {
    config: { access: { permission: 'warehouses:read' } },
    schema: { tags: TAGS, summary: 'People assigned to a warehouse', params: IdParamSchema, response: { 200: successEnvelope(z.array(MemberSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => svc.listMembers(tx, vendorId, req.params.id))).map((x) => svc.toMemberDto(x.m, { email: x.email, fullName: x.fullName }))));
  r.patch('/warehouse-members/:id', {
    config: { access: { permission: 'warehouses:admin' } },
    schema: { tags: TAGS, summary: 'Change a member\'s role / capabilities', params: IdParamSchema, body: z.object({ role: z.enum(schema.WAREHOUSE_ROLES), capabilities: z.array(CapabilitySchema).max(10) }).partial(), response: { 200: successEnvelope(MemberSchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const { before, after } = await svc.updateMember(tx, vendorId, req.params.id, req.body);
    await audit(tx, req, { action: 'warehouse_member.update', resourceType: 'warehouse_member', resourceId: after.id, before: { role: before.role, capabilities: before.capabilities }, after: { role: after.role, capabilities: after.capabilities } });
    return svc.toMemberDto(after);
  })));
  r.delete('/warehouse-members/:id', {
    config: { access: { permission: 'warehouses:admin' } },
    schema: { tags: TAGS, summary: 'Remove a user from a warehouse', params: IdParamSchema, response: { 200: successEnvelope(Deleted) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => { const m = await svc.removeMember(tx, vendorId, req.params.id); await audit(tx, req, { action: 'warehouse_member.remove', resourceType: 'warehouse_member', resourceId: m.id, before: { userId: m.userId, role: m.role, warehouseId: m.warehouseId } }); });
    return ok(req, { id: req.params.id, deleted: true as const });
  });
  r.get('/warehouse-access/me', {
    config: { access: 'authenticated' },
    schema: { tags: TAGS, summary: 'Which warehouses can I work in, and how?', description: '`restricted: false` = no warehouse assignment: you act according to your account role.', response: { 200: successEnvelope(z.object({ restricted: z.boolean(), warehouses: z.array(z.object({ warehouseId: z.string(), role: z.string(), capabilities: z.array(CapabilitySchema) })) })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.myAccess(tx, req.ctx.principal, vendorId)) as never));
};
