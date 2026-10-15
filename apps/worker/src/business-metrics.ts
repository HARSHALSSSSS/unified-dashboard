import { sql, withSystem } from '@oms/database';
import { Gauge } from '@oms/observability';
import type { Runtime } from '@oms/runtime';

/**
 * Operational gauges for dashboards and alerts, sampled from the database every 30 seconds (cheap aggregate queries on indexed status
 * columns). Labels are low-cardinality on purpose (status / queue), never a vendor or order id.
 */
export function startBusinessMetrics(rt: Runtime): () => void {
  const reg = rt.metrics.registry;
  const syncJobs = new Gauge({ name: 'oms_sync_jobs', help: 'Marketplace sync jobs by status', labelNames: ['status'], registers: [reg] });
  const webhooks = new Gauge({ name: 'oms_webhook_events', help: 'Inbound webhook events by status', labelNames: ['status'], registers: [reg] });
  const outbox = new Gauge({ name: 'oms_outbox_unpublished', help: 'Domain events waiting to be published (queue depth of the outbox)', registers: [reg] });
  const outboxAge = new Gauge({ name: 'oms_outbox_oldest_seconds', help: 'Age of the oldest unpublished domain event', registers: [reg] });
  const stuck = new Gauge({ name: 'oms_sync_jobs_stuck', help: 'Sync jobs running for more than 30 minutes', registers: [reg] });
  const accounts = new Gauge({ name: 'oms_marketplace_accounts', help: 'Marketplace accounts by connection health', labelNames: ['marketplace', 'health'], registers: [reg] });
  const pendingApprovals = new Gauge({ name: 'oms_automation_pending_approvals', help: 'Automation executions waiting for a person', registers: [reg] });
  const dbLat = new Gauge({ name: 'oms_db_ping_seconds', help: 'Database round-trip time of the metrics sampler', registers: [reg] });

  const sample = async () => {
    try {
      const t0 = process.hrtime.bigint();
      await rt.container.database.ping();
      dbLat.set(Number(process.hrtime.bigint() - t0) / 1e9);
      await withSystem(rt.container.database.db, async (tx) => {
        const rows = async (q: ReturnType<typeof sql>) => (await tx.execute<Record<string, unknown>>(q)).rows;
        syncJobs.reset(); for (const r of await rows(sql`select status, count(*)::int c from sync_jobs where created_at > now() - interval '7 days' or status in ('queued','running','retrying','dead_lettered') group by 1`)) syncJobs.set({ status: String(r.status) }, Number(r.c));
        webhooks.reset(); for (const r of await rows(sql`select status, count(*)::int c from webhook_events where status in ('received','processing','failed','dead_lettered') group by 1`)) webhooks.set({ status: String(r.status) }, Number(r.c));
        const [o] = await rows(sql`select count(*)::int n, coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 age from outbox_events where published_at is null`);
        outbox.set(Number(o?.n ?? 0)); outboxAge.set(Number(o?.age ?? 0));
        const [s] = await rows(sql`select count(*)::int n from sync_jobs where status = 'running' and started_at < now() - interval '30 minutes'`);
        stuck.set(Number(s?.n ?? 0));
        accounts.reset(); for (const r of await rows(sql`select marketplace, case when status = 'active' and connection_status in ('connected','unknown') then 'healthy' else 'unhealthy' end h, count(*)::int c from marketplace_accounts where status <> 'revoked' group by 1, 2`)) accounts.set({ marketplace: String(r.marketplace), health: String(r.h) }, Number(r.c));
        const [p] = await rows(sql`select count(*)::int n from automation_executions where status = 'pending_approval'`);
        pendingApprovals.set(Number(p?.n ?? 0));
      });
    } catch (err) { rt.logger.warn({ err: (err as Error).message }, 'business metrics sample failed'); }
  };
  void sample();
  const timer = setInterval(() => void sample(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
