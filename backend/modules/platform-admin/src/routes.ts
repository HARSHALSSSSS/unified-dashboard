import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, effectiveFlags, eq, escapeLike, ilike, inArray, schema, sql } from '@oms/database';
import { AppError, Errors, notifySessionRevoked } from '@oms/shared';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { audit, emit, ok, requireVendor, systemTx, vendorTx, requireScope } from '@oms/module-kit';
import { revokeSessions } from '@oms/mod-identity';

const FlagSchema = z.object({ key: z.string(), description: z.string(), defaultEnabled: z.boolean(), overrides: z.array(z.object({ vendorId: z.string(), enabled: z.boolean() })) }).meta({ id: 'FeatureFlag' });
const KEY = z.string().min(3).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits and . _ -');
const ADMIN = { access: { permission: 'platform:system' } } as const;
const SUPPORT = { access: { permission: 'platform:vendors' } } as const;
const TAGS = ['Platform Admin'];

/**
 * Platform administration: cross-tenant, platform staff only (`platform:*` permissions never reach a vendor role), always through
 * the system scope with every change audited. Vendor users have no route here.
 */
export const platformAdminRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;

  // ---------------------------------------------------------------- overview + health
  r.get('/admin/overview', {
    config: SUPPORT,
    schema: {
      tags: TAGS, summary: 'Platform overview', description: 'Vendors, users, marketplace connections, integration failures and the outbox backlog, across all tenants.',
      response: { 200: successEnvelope(z.object({
        vendors: z.record(z.string(), z.number().int()), users: z.object({ total: z.number().int(), active: z.number().int() }),
        marketplaceAccounts: z.array(z.object({ marketplace: z.string(), status: z.string(), connectionStatus: z.string(), count: z.number().int() })),
        syncJobs: z.object({ failed: z.number().int(), deadLettered: z.number().int(), retrying: z.number().int(), runningOver30m: z.number().int() }),
        webhooks: z.object({ failed: z.number().int(), deadLettered: z.number().int() }),
        outbox: z.object({ unpublished: z.number().int(), oldestSeconds: z.number().int().nullable() }),
        subscriptions: z.record(z.string(), z.number().int()),
      })) },
    },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const rows = async (q: ReturnType<typeof sql>) => (await tx.execute<Record<string, unknown>>(q)).rows;
    const v = await rows(sql`select status, count(*)::int c from vendors group by 1`);
    const [u] = await rows(sql`select count(*)::int total, count(*) filter (where status = 'active')::int active from users where deleted_at is null`);
    const a = await rows(sql`select marketplace, status, connection_status, count(*)::int c from marketplace_accounts group by 1, 2, 3 order by 1`);
    const [sj] = await rows(sql`select count(*) filter (where status = 'failed')::int failed, count(*) filter (where status = 'dead_lettered')::int dead, count(*) filter (where status = 'retrying')::int retrying, count(*) filter (where status = 'running' and started_at < now() - interval '30 minutes')::int stuck from sync_jobs`);
    const [wh] = await rows(sql`select count(*) filter (where status = 'failed')::int failed, count(*) filter (where status = 'dead_lettered')::int dead from webhook_events`);
    const [ob] = await rows(sql`select count(*)::int n, extract(epoch from now() - min(occurred_at))::int oldest from outbox_events where published_at is null`);
    const subs = await rows(sql`select status, count(*)::int c from subscriptions group by 1`);
    return {
      vendors: Object.fromEntries(v.map((x) => [String(x.status), Number(x.c)])), users: { total: Number(u?.total ?? 0), active: Number(u?.active ?? 0) },
      marketplaceAccounts: a.map((x) => ({ marketplace: String(x.marketplace), status: String(x.status), connectionStatus: String(x.connection_status), count: Number(x.c) })),
      syncJobs: { failed: Number(sj?.failed ?? 0), deadLettered: Number(sj?.dead ?? 0), retrying: Number(sj?.retrying ?? 0), runningOver30m: Number(sj?.stuck ?? 0) },
      webhooks: { failed: Number(wh?.failed ?? 0), deadLettered: Number(wh?.dead ?? 0) },
      outbox: { unpublished: Number(ob?.n ?? 0), oldestSeconds: ob?.oldest == null ? null : Number(ob.oldest) },
      subscriptions: Object.fromEntries(subs.map((x) => [String(x.status), Number(x.c)])),
    };
  })));

  r.get('/admin/system/health', {
    config: ADMIN,
    schema: {
      tags: TAGS, summary: 'System health (database, outbox, stuck work)', description: 'Active probes plus the signals that say the pipeline is not draining. `degraded` when the outbox is old, jobs are stuck or the database is slow.',
      response: { 200: successEnvelope(z.object({ status: z.enum(['healthy', 'degraded']), database: z.object({ ok: z.boolean(), latencyMs: z.number().int() }), outboxOldestSeconds: z.number().int().nullable(), stuckJobs: z.number().int(), issues: z.array(z.string()) })) },
    },
  }, async (req) => {
    const t0 = Date.now();
    let dbOk = true;
    try { await c.database.ping(); } catch { dbOk = false; }
    const latencyMs = Date.now() - t0;
    const sig = await systemTx(req, async (tx) => {
      const [ob] = (await tx.execute<Record<string, unknown>>(sql`select extract(epoch from now() - min(occurred_at))::int oldest from outbox_events where published_at is null`)).rows;
      const [sj] = (await tx.execute<Record<string, unknown>>(sql`select count(*)::int n from sync_jobs where status = 'running' and started_at < now() - interval '30 minutes'`)).rows;
      return { oldest: ob?.oldest == null ? null : Number(ob.oldest), stuck: Number(sj?.n ?? 0) };
    });
    const issues: string[] = [];
    if (!dbOk) issues.push('database ping failed');
    if (latencyMs > 500) issues.push(`database slow (${latencyMs} ms)`);
    if (sig.oldest !== null && sig.oldest > 300) issues.push(`outbox not draining (oldest event ${sig.oldest}s)`);
    if (sig.stuck > 0) issues.push(`${sig.stuck} sync job(s) running over 30 minutes`);
    return ok(req, { status: issues.length ? 'degraded' : 'healthy', database: { ok: dbOk, latencyMs }, outboxOldestSeconds: sig.oldest, stuckJobs: sig.stuck, issues });
  });

  // ---------------------------------------------------------------- vendors / users
  r.get('/admin/vendors/:id/summary', {
    config: SUPPORT,
    schema: { tags: TAGS, summary: 'One vendor at a glance', params: IdParamSchema, response: { 200: successEnvelope(z.object({ vendorId: z.string(), name: z.string(), status: z.string(), users: z.number().int(), products: z.number().int(), orders: z.number().int(), marketplaceAccounts: z.number().int(), failedJobs: z.number().int(), subscription: z.object({ plan: z.string(), status: z.string() }).nullable() })) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const id = req.params.id;
    const [vd] = await tx.select().from(schema.vendors).where(eq(schema.vendors.id, id));
    if (!vd) throw Errors.notFound('Vendor', id);
    const [x] = (await tx.execute<Record<string, unknown>>(sql`select
      (select count(*)::int from users where vendor_id = ${id} and deleted_at is null) users, (select count(*)::int from products where vendor_id = ${id} and deleted_at is null) products,
      (select count(*)::int from orders where vendor_id = ${id}) orders, (select count(*)::int from marketplace_accounts where vendor_id = ${id}) accounts,
      (select count(*)::int from sync_jobs where vendor_id = ${id} and status in ('failed','dead_lettered')) failed`)).rows;
    const [sub] = (await tx.execute<Record<string, unknown>>(sql`select p.code, s.status from subscriptions s join plans p on p.id = s.plan_id where s.vendor_id = ${id}`)).rows;
    return { vendorId: id, name: vd.displayName, status: vd.status, users: Number(x?.users), products: Number(x?.products), orders: Number(x?.orders), marketplaceAccounts: Number(x?.accounts), failedJobs: Number(x?.failed), subscription: sub ? { plan: String(sub.code), status: String(sub.status) } : null };
  })));

  r.get('/admin/users', {
    config: SUPPORT,
    schema: {
      tags: TAGS, summary: 'Search users across all vendors', querystring: z.object({ q: z.string().trim().min(2).max(100).optional(), 'filter[vendorId]': z.uuid().optional(), 'filter[status]': z.enum(['invited', 'active', 'disabled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }),
      response: { 200: successEnvelope(z.array(z.object({ id: z.string(), email: z.string(), fullName: z.string(), vendorId: z.string().nullable(), userType: z.string(), status: z.string(), lastLoginAt: IsoDate.nullable() }))) },
    },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const U = schema.users;
    const rows = await tx.select().from(U).where(and(sql`${U.deletedAt} IS NULL`, req.query.q ? ilike(U.email, `%${escapeLike(req.query.q)}%`) : undefined, req.query['filter[vendorId]'] ? eq(U.vendorId, req.query['filter[vendorId]']) : undefined, req.query['filter[status]'] ? eq(U.status, req.query['filter[status]']) : undefined)).orderBy(desc(U.createdAt)).limit(req.query.limit);
    return rows.map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, vendorId: u.vendorId, userType: u.userType, status: u.status, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null }));
  })));

  for (const [action, status] of [['disable', 'disabled'], ['enable', 'active']] as const) {
    r.post(`/admin/users/:id/${action}`, {
      config: ADMIN,
      schema: { tags: TAGS, summary: `${action === 'disable' ? 'Disable' : 'Re-enable'} a user (any vendor)`, description: action === 'disable' ? 'Also ends every session of the user. Audited.' : 'Audited.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), status: z.string() })) } },
    }, async (req) => ok(req, await systemTx(req, async (tx) => {
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, req.params.id));
      if (!u) throw Errors.notFound('User', req.params.id);
      if (u.id === req.ctx.principal?.actorId) throw new AppError('CONFLICT', 'You cannot change your own account here', { details: { rule: 'self_change' } });
      await tx.update(schema.users).set({ status }).where(eq(schema.users.id, u.id));
      if (action === 'disable') (await revokeSessions(tx, { userId: u.id })).forEach(notifySessionRevoked);
      await audit(tx, req, { action: `admin.user_${action}`, resourceType: 'user', resourceId: u.id, vendorId: u.vendorId, before: { status: u.status }, after: { status } });
      return { id: u.id, status };
    })));
  }

  // ---------------------------------------------------------------- connectors + failures
  r.get('/admin/connectors', {
    config: SUPPORT,
    schema: {
      tags: TAGS, summary: 'Marketplace connectors: switch state and connection health across tenants',
      response: { 200: successEnvelope(z.array(z.object({ code: z.string(), displayName: z.string(), implementation: z.string(), live: z.boolean(), enabled: z.boolean(), accounts: z.number().int(), unhealthy: z.number().int() }))) },
    },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const list = c.connectors.list();
    const counts = (await tx.execute<Record<string, unknown>>(sql`select marketplace, count(*)::int n, count(*) filter (where status <> 'active' or connection_status not in ('connected','unknown'))::int bad from marketplace_accounts group by 1`)).rows;
    const flags = await tx.select().from(schema.featureFlags);
    return list.map((x) => ({
      code: x.code, displayName: x.displayName, implementation: x.implementation, live: x.readiness.live,
      enabled: flags.find((f) => f.key === `connector.${x.code}.enabled`)?.defaultEnabled ?? true, accounts: Number(counts.find((k) => k.marketplace === x.code)?.n ?? 0), unhealthy: Number(counts.find((k) => k.marketplace === x.code)?.bad ?? 0),
    }));
  })));

  r.put('/admin/connectors/:code', {
    config: ADMIN,
    schema: { tags: TAGS, summary: 'Switch a marketplace connector on or off for the whole platform', description: 'New accounts of a disabled connector are refused; vendor-specific exceptions use the feature-flag overrides.', params: z.object({ code: z.string().min(2).max(40) }), body: z.object({ enabled: z.boolean() }), response: { 200: successEnvelope(z.object({ code: z.string(), enabled: z.boolean() })) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const code = req.params.code;
    if (!c.connectors.list().some((x) => x.code === code)) throw Errors.notFound('Connector', code);
    const key = `connector.${code}.enabled`;
    await tx.insert(schema.featureFlags).values({ key, description: `${code} marketplace connector`, defaultEnabled: req.body.enabled }).onConflictDoUpdate({ target: schema.featureFlags.key, set: { defaultEnabled: req.body.enabled } });
    await audit(tx, req, { action: 'admin.connector_switched', resourceType: 'connector', resourceId: code, after: { enabled: req.body.enabled } });
    return { code, enabled: req.body.enabled };
  })));

  r.get('/admin/jobs/failed', {
    config: SUPPORT,
    schema: {
      tags: TAGS, summary: 'Failed and dead-lettered sync jobs across all vendors', querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: successEnvelope(z.array(z.object({ id: z.string(), vendorId: z.string(), accountId: z.string().nullable(), type: z.string(), status: z.string(), attempts: z.number().int(), error: z.string().nullable(), finishedAt: IsoDate.nullable() }))) },
    },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const J = schema.syncJobs;
    const rows = await tx.select().from(J).where(inArray(J.status, ['failed', 'dead_lettered'])).orderBy(desc(J.updatedAt)).limit(req.query.limit);
    return rows.map((j) => ({ id: j.id, vendorId: j.vendorId, accountId: j.marketplaceAccountId, type: j.type, status: j.status, attempts: j.attempts, error: (j as { lastFailureMessage?: string | null }).lastFailureMessage ?? null, finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null }));
  })));

  r.get('/admin/integrations/failing', {
    config: SUPPORT,
    schema: {
      tags: TAGS, summary: 'Marketplace connections that are not healthy (all vendors)',
      response: { 200: successEnvelope(z.array(z.object({ accountId: z.string(), vendorId: z.string(), marketplace: z.string(), status: z.string(), connectionStatus: z.string(), lastFailureMessage: z.string().nullable() }))) },
    },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const A = schema.marketplaceAccounts;
    const rows = await tx.select().from(A).where(sql`${A.status} NOT IN ('active', 'pending_authorization') OR ${A.connectionStatus} NOT IN ('connected', 'unknown')`).orderBy(desc(A.updatedAt)).limit(200);
    return rows.map((a) => ({ accountId: a.id, vendorId: a.vendorId, marketplace: a.marketplace, status: a.status, connectionStatus: a.connectionStatus, lastFailureMessage: a.lastFailureMessage ?? null }));
  })));

  // ---------------------------------------------------------------- feature flags
  r.get('/admin/feature-flags', {
    config: SUPPORT,
    schema: { tags: TAGS, summary: 'All feature flags with their per-vendor overrides', response: { 200: successEnvelope(z.array(FlagSchema)) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const flags = await tx.select().from(schema.featureFlags).orderBy(schema.featureFlags.key);
    const ov = await tx.select().from(schema.featureFlagOverrides);
    return flags.map((f) => ({ key: f.key, description: f.description, defaultEnabled: f.defaultEnabled, overrides: ov.filter((o) => o.flagKey === f.key).map((o) => ({ vendorId: o.vendorId, enabled: o.enabled })) }));
  })));

  r.put('/admin/feature-flags/:key', {
    config: ADMIN,
    schema: { tags: TAGS, summary: 'Create or change a feature flag (platform default)', params: z.object({ key: KEY }), body: z.object({ defaultEnabled: z.boolean(), description: z.string().max(300).optional() }), response: { 200: successEnvelope(z.object({ key: z.string(), defaultEnabled: z.boolean() })) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const [before] = await tx.select().from(schema.featureFlags).where(eq(schema.featureFlags.key, req.params.key));
    await tx.insert(schema.featureFlags).values({ key: req.params.key, description: req.body.description ?? '', defaultEnabled: req.body.defaultEnabled }).onConflictDoUpdate({ target: schema.featureFlags.key, set: { defaultEnabled: req.body.defaultEnabled, ...(req.body.description !== undefined ? { description: req.body.description } : {}) } });
    await audit(tx, req, { action: 'admin.flag_set', resourceType: 'feature_flag', resourceId: req.params.key, before: before ? { defaultEnabled: before.defaultEnabled } : null, after: { defaultEnabled: req.body.defaultEnabled } });
    await emit(tx, req, { type: 'admin.flag_changed', aggregateType: 'feature_flag', aggregateId: req.params.key, vendorId: null, payload: { key: req.params.key, defaultEnabled: req.body.defaultEnabled } });
    return { key: req.params.key, defaultEnabled: req.body.defaultEnabled };
  })));

  r.put('/admin/feature-flags/:key/vendors/:vendorId', {
    config: ADMIN,
    schema: { tags: TAGS, summary: 'Override a flag for one vendor (vendor-specific capability)', params: z.object({ key: KEY, vendorId: z.uuid() }), body: z.object({ enabled: z.boolean() }), response: { 200: successEnvelope(z.object({ key: z.string(), vendorId: z.string(), enabled: z.boolean() })) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const { key, vendorId } = req.params;
    if (!(await tx.select({ k: schema.featureFlags.key }).from(schema.featureFlags).where(eq(schema.featureFlags.key, key)))[0]) throw Errors.notFound('Feature flag', key);
    if (!(await tx.select({ id: schema.vendors.id }).from(schema.vendors).where(eq(schema.vendors.id, vendorId)))[0]) throw Errors.notFound('Vendor', vendorId);
    await tx.insert(schema.featureFlagOverrides).values({ vendorId, flagKey: key, enabled: req.body.enabled, updatedBy: req.ctx.principal?.actorId ?? null }).onConflictDoUpdate({ target: [schema.featureFlagOverrides.vendorId, schema.featureFlagOverrides.flagKey], set: { enabled: req.body.enabled, updatedBy: req.ctx.principal?.actorId ?? null } });
    await audit(tx, req, { action: 'admin.flag_override', resourceType: 'feature_flag', resourceId: key, vendorId, after: { enabled: req.body.enabled } });
    return { key, vendorId, enabled: req.body.enabled };
  })));

  r.delete('/admin/feature-flags/:key/vendors/:vendorId', {
    config: ADMIN,
    schema: { tags: TAGS, summary: 'Remove a vendor override (the platform default applies again)', params: z.object({ key: KEY, vendorId: z.uuid() }), response: { 200: successEnvelope(z.object({ removed: z.boolean() })) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const gone = await tx.delete(schema.featureFlagOverrides).where(and(eq(schema.featureFlagOverrides.vendorId, req.params.vendorId), eq(schema.featureFlagOverrides.flagKey, req.params.key))).returning({ id: schema.featureFlagOverrides.id });
    await audit(tx, req, { action: 'admin.flag_override_removed', resourceType: 'feature_flag', resourceId: req.params.key, vendorId: req.params.vendorId });
    return { removed: gone.length > 0 };
  })));

  // the vendor's own view: which capabilities are on for ME
  r.get('/features/me', {
    config: { access: 'authenticated' },
    schema: { tags: TAGS, summary: 'Feature flags as they apply to my business', response: { 200: successEnvelope(z.record(z.string(), z.boolean())) } },
  }, async (req) => { requireScope(req); return ok(req, await vendorTx(req, (tx, vendorId) => effectiveFlags(tx, vendorId))); });

  void requireVendor;
};
