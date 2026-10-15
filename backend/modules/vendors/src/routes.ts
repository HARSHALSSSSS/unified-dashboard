import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, emit, ok, paginated, requireScope, scopedTx, vendorTx } from '@oms/module-kit';
import { IdParamSchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { notifyVendorChanged } from '@oms/shared';
import * as svc from './service';
import { SetStatusBodySchema, UpdateVendorBodySchema, VendorListQuerySchema, VendorSchema, VendorSettingsSchema } from './schemas';

const snapshot = (v: svc.VendorRow) => ({ displayName: v.displayName, legalName: v.legalName, status: v.status, gstin: v.gstin, pan: v.pan, timezone: v.timezone, currency: v.currency.trim(), settings: v.settings });

export const vendorRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Vendors'];

  // ------------------------------------------------------------------ the caller's own vendor
  r.get('/vendor', {
    config: { access: { permission: 'vendors:read' } },
    schema: { tags: TAGS, summary: 'Get my vendor (business) profile', response: { 200: successEnvelope(VendorSchema) } },
  }, async (req) => ok(req, svc.toVendorDto(await vendorTx(req, (tx, vendorId) => svc.getVendor(tx, vendorId)))));

  r.patch('/vendor', {
    config: { access: { permission: 'vendors:write' } },
    schema: {
      tags: TAGS,
      summary: 'Update my vendor profile',
      description: 'Partial update. Send `version` for optimistic locking. Status, plan and slug cannot be changed here.',
      body: UpdateVendorBodySchema,
      response: { 200: successEnvelope(VendorSchema) },
    },
  }, async (req) => {
    const res = await vendorTx(req, async (tx, vendorId) => {
      const out = await svc.updateVendor(tx, vendorId, req.body);
      await audit(tx, req, { action: 'vendor.update', resourceType: 'vendor', resourceId: vendorId, before: snapshot(out.before), after: snapshot(out.after) });
      await emit(tx, req, { type: 'vendor.updated', aggregateType: 'vendor', aggregateId: vendorId, payload: { fields: Object.keys(req.body) } });
      return out.after;
    });
    return ok(req, svc.toVendorDto(res));
  });

  r.get('/vendor/settings', {
    config: { access: { permission: 'vendors:read' } },
    schema: { tags: TAGS, summary: 'Get my business settings', response: { 200: successEnvelope(VendorSettingsSchema) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => svc.getVendor(tx, vendorId))).settings as Record<string, unknown>));

  r.patch('/vendor/settings', {
    config: { access: { permission: 'vendors:write' } },
    schema: {
      tags: TAGS,
      summary: 'Update my business settings',
      description: 'Each top-level section is merged, so `{ "notifications": { "lowStock": false } }` keeps the other notification flags.',
      body: VendorSettingsSchema,
      response: { 200: successEnvelope(VendorSettingsSchema) },
    },
  }, async (req) => {
    const after = await vendorTx(req, async (tx, vendorId) => {
      const out = await svc.updateSettings(tx, vendorId, req.body);
      await audit(tx, req, { action: 'vendor.settings_update', resourceType: 'vendor', resourceId: vendorId, before: out.before.settings, after: out.after.settings });
      return out.after;
    });
    return ok(req, after.settings as Record<string, unknown>);
  });

  // ------------------------------------------------------------------ platform administration
  const PLATFORM = { access: { permission: 'platform:vendors' } } as const;

  r.get('/vendors', {
    config: PLATFORM,
    schema: {
      tags: TAGS,
      summary: 'List all vendors (platform staff)',
      description: 'Cross-tenant directory with search (`q`), `filter[status]`, `sort` (createdAt, displayName) and keyset pagination.',
      querystring: VendorListQuerySchema,
      response: { 200: paginatedEnvelope(VendorSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await scopedTx(req, (tx, scope) => svc.listVendors(tx, scope, { limit: q.limit, cursor: q.cursor, q: q.q, status: q['filter[status]'], sort: q.sort }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/vendors/:id', {
    config: PLATFORM,
    schema: { tags: TAGS, summary: 'Get a vendor (platform staff)', params: IdParamSchema, response: { 200: successEnvelope(VendorSchema) } },
  }, async (req) => {
    requireScope(req);
    return ok(req, svc.toVendorDto(await scopedTx(req, (tx) => svc.getVendor(tx, req.params.id))));
  });

  r.patch('/vendors/:id/status', {
    config: { access: { permission: 'platform:system' } },
    schema: {
      tags: TAGS,
      summary: 'Change a vendor\'s status (platform staff)',
      description: 'Platform admins only. Suspending a vendor blocks all of its users immediately (login and API access return TENANT_SUSPENDED).',
      params: IdParamSchema,
      body: SetStatusBodySchema,
      response: { 200: successEnvelope(VendorSchema) },
    },
  }, async (req) => {
    const out = await scopedTx(req, async (tx) => {
      const res = await svc.setVendorStatus(tx, req.params.id, req.body.status, req.body.reason);
      await audit(tx, req, { vendorId: req.params.id, action: 'vendor.status_change', resourceType: 'vendor', resourceId: req.params.id, before: { status: res.before.status }, after: { status: res.after.status, reason: req.body.reason ?? null } });
      await emit(tx, req, { vendorId: req.params.id, type: req.body.status === 'active' ? 'vendor.reactivated' : 'vendor.suspended', aggregateType: 'vendor', aggregateId: req.params.id, payload: { status: req.body.status } });
      return res.after;
    });
    notifyVendorChanged(req.params.id); // after commit: access cache must not re-read the old status
    return ok(req, svc.toVendorDto(out));
  });
};
