import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, gte, like, lt, lte, schema } from '@oms/database';
import { decodeCursor, encodeCursor } from '@oms/shared';
import { IsoDate, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { ok, paginated, scopedTx, requireScope } from '@oms/module-kit';
import { tenantWhere } from '@oms/database';

const AuditLogSchema = z
  .object({
    id: z.number().int(), vendorId: z.string().nullable(), actorType: z.string(), actorId: z.string().nullable(), onBehalfOfVendorId: z.string().nullable(),
    action: z.string(), source: z.string().describe('Where it came from: api | webhook | job | system | marketplace'), resourceType: z.string().nullable(), resourceId: z.string().nullable(), requestId: z.string().nullable(),
    ip: z.string().nullable(), before: z.unknown().nullable(), after: z.unknown().nullable(), metadata: z.record(z.string(), z.unknown()), createdAt: IsoDate,
  })
  .meta({ id: 'AuditLog' });

const ListQuery = PaginationQuerySchema.extend({
  'filter[action]': z.string().max(100).optional().describe('Exact action, e.g. product.update'),
  'filter[resourceType]': z.string().max(60).optional(),
  'filter[resourceId]': z.string().max(100).optional(),
  'filter[actorId]': z.string().max(100).optional(),
  'filter[actionPrefix]': z.string().max(60).optional().describe('e.g. fulfillment. or return.'),
  'filter[source]': z.enum(['api', 'webhook', 'job', 'system', 'marketplace']).optional(),
  'filter[actorType]': z.enum(['user', 'api_key', 'system', 'webhook']).optional(),
  'filter[requestId]': z.string().max(100).optional().describe('Everything one request did'),
  'filter[from]': z.coerce.date().optional(),
  'filter[to]': z.coerce.date().optional(),
});
const toDto = (a: typeof schema.auditLogs.$inferSelect) => ({
  id: a.id, vendorId: a.vendorId, actorType: a.actorType, actorId: a.actorId, onBehalfOfVendorId: a.onBehalfOfVendorId, action: a.action, source: a.source, resourceType: a.resourceType,
  resourceId: a.resourceId, requestId: a.requestId, ip: a.ip, before: a.before ?? null, after: a.after ?? null, metadata: a.metadata, createdAt: a.createdAt.toISOString(),
});

/** Append-only audit trail. Vendors see their own tenant; platform staff see everything. */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const A = schema.auditLogs;

  r.get('/audit-logs', {
    config: { access: { permission: 'audit:read' } },
    schema: {
      tags: ['Audit'],
      summary: 'Audit trail (newest first)',
      description: 'Who did what, when, from where. Append-only and tenant-scoped; secrets are never recorded. Keyset pagination.',
      querystring: ListQuery,
      response: { 200: paginatedEnvelope(AuditLogSchema) },
    },
  }, async (req) => {
    const q = req.query;
    requireScope(req);
    const before = q.cursor ? Number(decodeCursor<[number]>(q.cursor)[0]) : undefined;
    const rows = await scopedTx(req, (tx, scope) =>
      tx
        .select()
        .from(A)
        .where(and(tenantWhere(A as never, scope), before ? lt(A.id, before) : undefined, q['filter[action]'] ? eq(A.action, q['filter[action]']) : undefined, q['filter[resourceType]'] ? eq(A.resourceType, q['filter[resourceType]']) : undefined, q['filter[resourceId]'] ? eq(A.resourceId, q['filter[resourceId]']) : undefined, q['filter[actorId]'] ? eq(A.actorId, q['filter[actorId]']) : undefined, q['filter[actionPrefix]'] ? like(A.action, `${q['filter[actionPrefix]'].replace(/[%_\\]/g, '')}%`) : undefined, q['filter[source]'] ? eq(A.source, q['filter[source]']) : undefined, q['filter[actorType]'] ? eq(A.actorType, q['filter[actorType]']) : undefined, q['filter[requestId]'] ? eq(A.requestId, q['filter[requestId]']) : undefined, q['filter[from]'] ? gte(A.createdAt, q['filter[from]']) : undefined, q['filter[to]'] ? lte(A.createdAt, q['filter[to]']) : undefined))
        .orderBy(desc(A.id))
        .limit(q.limit + 1),
    );
    const hasMore = rows.length > q.limit;
    const items = (hasMore ? rows.slice(0, q.limit) : rows).map(toDto);
    return paginated(req, items, { limit: q.limit, nextCursor: hasMore ? encodeCursor([items[items.length - 1]!.id]) : null });
  });

  r.get('/audit-logs/entities/:resourceType/:resourceId', {
    config: { access: { permission: 'audit:read' } },
    schema: {
      tags: ['Audit'], summary: 'History of one entity (who changed what, previous and new value)',
      description: 'Every audited action on one resource, oldest first: the actor, the source, the request id, and the previous / new values where the action recorded them.',
      params: z.object({ resourceType: z.string().max(60), resourceId: z.string().max(100) }), querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
      response: { 200: successEnvelope(z.array(AuditLogSchema)) },
    },
  }, async (req) => {
    requireScope(req);
    const rows = await scopedTx(req, (tx, scope) => tx.select().from(A).where(and(tenantWhere(A as never, scope), eq(A.resourceType, req.params.resourceType), eq(A.resourceId, req.params.resourceId))).orderBy(A.id).limit(req.query.limit));
    return ok(req, rows.map(toDto));
  });
};
