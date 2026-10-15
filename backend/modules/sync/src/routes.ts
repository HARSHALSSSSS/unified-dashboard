import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gt, gte, keyset, schema, sql, type Tx } from '@oms/database';
import { IdParamSchema, IsoDate, PaginationQuerySchema, paginatedEnvelope, sortQuery, successEnvelope, toIso } from '@oms/contracts';
import { audit, ok, paginated, vendorTx } from '@oms/module-kit';
import { cancelSyncJob, dispatchSyncJob, getSyncJobRow, resetForManualRetry, type SyncJobRow } from './engine';

const S = schema.syncJobs;

export const SyncJobSchema = z
  .object({
    id: z.string(),
    type: z.enum(schema.SYNC_TYPES),
    status: z.enum(schema.SYNC_STATUSES).describe('queued -> running -> succeeded | partially_failed | failed; retrying = waiting for the next attempt; dead_lettered = out of attempts (retry it manually)'),
    trigger: z.enum(schema.SYNC_TRIGGERS),
    marketplaceAccountId: z.string().nullable(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    nextRetryAt: IsoDate.nullable(),
    scheduledAt: IsoDate,
    startedAt: IsoDate.nullable(),
    finishedAt: IsoDate.nullable(),
    deadLetteredAt: IsoDate.nullable(),
    progress: z.object({ total: z.number().int(), done: z.number().int(), failed: z.number().int() }),
    stats: z.record(z.string(), z.number()),
    error: z.object({ code: z.string(), message: z.string() }).nullable().describe('Why the last attempt failed'),
    failureDetails: z.array(z.object({ ref: z.string(), code: z.string().optional(), message: z.string() })).describe('Per-item failures of the last attempt (bounded)'),
    payload: z.record(z.string(), z.unknown()),
    requestedBy: z.string().nullable(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'SyncJob' });

export const toSyncJobDto = (j: SyncJobRow): z.infer<typeof SyncJobSchema> => ({
  id: j.id, type: j.type as never, status: j.status as never, trigger: j.trigger as never, marketplaceAccountId: j.marketplaceAccountId, attempts: j.attempts, maxAttempts: j.maxAttempts,
  nextRetryAt: toIso(j.nextRetryAt), scheduledAt: j.scheduledAt.toISOString(), startedAt: toIso(j.startedAt), finishedAt: toIso(j.finishedAt), deadLetteredAt: toIso(j.deadLetteredAt),
  progress: j.progress, stats: j.stats, error: j.error, failureDetails: j.failureDetails, payload: j.payload, requestedBy: j.requestedBy, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString(),
});

const LogSchema = z.object({ id: z.number().int(), level: z.enum(schema.LOG_LEVELS), message: z.string(), context: z.record(z.string(), z.unknown()), createdAt: IsoDate }).meta({ id: 'SyncLog' });

const ListQuery = PaginationQuerySchema.extend({
  'filter[type]': z.enum(schema.SYNC_TYPES).optional(),
  'filter[status]': z.enum(schema.SYNC_STATUSES).optional(),
  'filter[accountId]': z.uuid().optional(),
  sort: sortQuery(['createdAt'] as const),
});

export async function listSyncJobs(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; sort?: Array<{ field: string; direction: 'asc' | 'desc' }>; type?: string; status?: string; accountId?: string }) {
  const ks = keyset<SyncJobRow>({ sorts: { createdAt: { column: S.createdAt, kind: 'timestamp' } }, idColumn: S.id, sort: q.sort, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx
    .select()
    .from(S)
    .where(and(eq(S.vendorId, vendorId), q.type ? eq(S.type, q.type) : undefined, q.status ? eq(S.status, q.status) : undefined, q.accountId ? eq(S.marketplaceAccountId, q.accountId) : undefined, ks.where))
    .orderBy(...ks.orderBy)
    .limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const TAGS = ['Sync Jobs'];

  r.get('/sync/jobs', {
    config: { access: { permission: 'sync:read' } },
    schema: {
      tags: TAGS,
      summary: 'List sync jobs',
      description: 'Every marketplace synchronisation run: order imports, inventory/price pushes, listing publishes and status checks, catalogue imports, order status pushes. Keyset-paginated, newest first.',
      querystring: ListQuery,
      response: { 200: paginatedEnvelope(SyncJobSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => listSyncJobs(tx, vendorId, { limit: q.limit, cursor: q.cursor, sort: q.sort, type: q['filter[type]'], status: q['filter[status]'], accountId: q['filter[accountId]'] }));
    return paginated(req, page.items.map(toSyncJobDto), { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/sync/summary', {
    config: { access: { permission: 'sync:read' } },
    schema: {
      tags: TAGS,
      summary: 'Sync health summary (last 24 hours)',
      response: { 200: successEnvelope(z.object({ since: IsoDate, byStatus: z.record(z.string(), z.number().int()), needsAttention: z.number().int().describe('failed + dead_lettered jobs'), deadLettered: z.number().int() })) },
    },
  }, async (req) => {
    const since = new Date(Date.now() - 24 * 3600_000);
    const rows = await vendorTx(req, (tx, vendorId) =>
      tx.select({ status: S.status, n: sql<number>`count(*)::int` }).from(S).where(and(eq(S.vendorId, vendorId), gte(S.createdAt, since))).groupBy(S.status),
    );
    const byStatus = Object.fromEntries(rows.map((x) => [x.status, x.n]));
    return ok(req, { since: since.toISOString(), byStatus, needsAttention: (byStatus.failed ?? 0) + (byStatus.dead_lettered ?? 0), deadLettered: byStatus.dead_lettered ?? 0 });
  });

  r.get('/sync/jobs/:id', {
    config: { access: { permission: 'sync:read' } },
    schema: { tags: TAGS, summary: 'One sync job (status, attempts, progress, failure details)', params: IdParamSchema, response: { 200: successEnvelope(SyncJobSchema) } },
  }, async (req) => ok(req, toSyncJobDto(await vendorTx(req, (tx, vendorId) => getSyncJobRow(tx, vendorId, req.params.id)))));

  r.get('/sync/jobs/:id/logs', {
    config: { access: { permission: 'sync:read' } },
    schema: {
      tags: TAGS,
      summary: 'Sync log of one job',
      description: 'Append-only, oldest first. Pass `after=<last id>` to page.',
      params: IdParamSchema,
      querystring: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      response: { 200: successEnvelope(z.object({ items: z.array(LogSchema), nextAfter: z.number().int().nullable() })) },
    },
  }, async (req) => {
    const { items, nextAfter } = await vendorTx(req, async (tx, vendorId) => {
      await getSyncJobRow(tx, vendorId, req.params.id);
      const L = schema.syncLogs;
      const rows = await tx.select().from(L).where(and(eq(L.vendorId, vendorId), eq(L.syncJobId, req.params.id), gt(L.id, req.query.after))).orderBy(L.id).limit(req.query.limit);
      return { items: rows, nextAfter: rows.length === req.query.limit ? rows[rows.length - 1]!.id : null };
    });
    return ok(req, { items: items.map((l) => ({ id: l.id, level: l.level as never, message: l.message, context: l.context, createdAt: l.createdAt.toISOString() })), nextAfter });
  });

  r.post('/sync/jobs/:id/retry', {
    config: { access: { permission: 'sync:write' } },
    schema: {
      tags: TAGS,
      summary: 'Retry a failed / dead-lettered job',
      description: 'Resets the attempt budget and queues the job again. Only failed, dead_lettered, partially_failed and cancelled jobs can be retried. Runners are idempotent, so already-processed items are not duplicated.',
      params: IdParamSchema,
      response: { 202: successEnvelope(SyncJobSchema) },
    },
  }, async (req, reply) => {
    const job = await vendorTx(req, async (tx, vendorId) => {
      const before = await getSyncJobRow(tx, vendorId, req.params.id);
      const j = await resetForManualRetry(tx, vendorId, req.params.id, req.ctx.principal?.actorId ?? null);
      await audit(tx, req, { action: 'sync.job_retry', resourceType: 'sync_job', resourceId: j.id, before: { status: before.status, attempts: before.attempts }, after: { status: j.status } });
      return j;
    });
    await dispatchSyncJob(c, job);
    reply.code(202);
    return ok(req, toSyncJobDto(job));
  });

  r.post('/sync/jobs/:id/cancel', {
    config: { access: { permission: 'sync:write' } },
    schema: { tags: TAGS, summary: 'Cancel a queued / retrying job', params: IdParamSchema, response: { 200: successEnvelope(SyncJobSchema) } },
  }, async (req) => ok(req, toSyncJobDto(await vendorTx(req, async (tx, vendorId) => {
    const j = await cancelSyncJob(tx, vendorId, req.params.id);
    await audit(tx, req, { action: 'sync.job_cancel', resourceType: 'sync_job', resourceId: j.id });
    return j;
  }))));
};


