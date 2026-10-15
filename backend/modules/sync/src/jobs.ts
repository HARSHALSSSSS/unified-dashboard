import { and, eq, lt, or, schema, sql, withSystem, withVendor } from '@oms/database';
import { getContext } from '@oms/logging';
import type { JobHandler } from '@oms/module-kit';
import { createSyncJob, dispatchSyncJob, type SyncType } from './engine';

/**
 * Scheduled fan-out (apps/scheduler -> queue). Each handler does a cheap SELECT across tenants (system scope) and
 * enqueues one idempotent sync job per account: the idempotency key carries a time bucket, so a scheduler that fires
 * twice, or two scheduler replicas, still produce ONE job per account per interval.
 */
export const JOB_SCHEDULE_ORDERS = 'sync.schedule-orders';
export const JOB_SCHEDULE_LISTING_STATUS = 'sync.schedule-listing-status';
export const JOB_SCHEDULE_INVENTORY = 'sync.schedule-inventory';
export const JOB_SWEEP = 'sync.sweep';

const A = schema.marketplaceAccounts;
const L = schema.marketplaceListings;
const S = schema.syncJobs;
const bucket = (intervalSec: number): number => Math.floor(Date.now() / (intervalSec * 1000));

async function fanOut(
  c: Parameters<JobHandler['handle']>[1],
  type: SyncType,
  accountsQuery: () => Promise<Array<{ vendorId: string; id: string; marketplace: string }>>,
  supports: (marketplace: string) => { ok: boolean; intervalSec: number },
): Promise<number> {
  const accounts = await accountsQuery();
  let enqueued = 0;
  for (const a of accounts) {
    const s = supports(a.marketplace);
    if (!s.ok) continue;
    const { job, created } = await withVendor(c.database.db, a.vendorId, (tx) =>
      createSyncJob(tx, c, { vendorId: a.vendorId, accountId: a.id, type, trigger: 'schedule', idempotencyKey: `${type}:${a.id}:${bucket(s.intervalSec)}`, coalesce: type === 'inventory' }),
    );
    if (created) { await dispatchSyncJob(c, job); enqueued++; }
  }
  return enqueued;
}

const activeAccounts = (c: Parameters<JobHandler['handle']>[1], extra?: ReturnType<typeof sql>) => () =>
  withSystem(c.database.db, (tx) =>
    tx.select({ vendorId: A.vendorId, id: A.id, marketplace: A.marketplace }).from(A).where(and(eq(A.status, 'active'), extra)).limit(5000),
  );

/** every active account whose connector can fetch orders gets an order sync per interval */
export const scheduleOrdersHandler: JobHandler = {
  queue: 'maintenance',
  name: JOB_SCHEDULE_ORDERS,
  async handle(_env, c) {
    const n = await fanOut(c, 'orders', activeAccounts(c), (m) => {
      const conn = safeGet(c, m);
      return { ok: Boolean(conn?.capabilities.orders.fetch) && conn?.implementation !== 'planned', intervalSec: conn?.polling?.orders?.intervalSeconds ?? 300 };
    });
    c.logger.info({ enqueued: n }, 'scheduled order syncs');
  },
};

/** accounts with listings still `pending` on the marketplace get a status check */
export const scheduleListingStatusHandler: JobHandler = {
  queue: 'maintenance',
  name: JOB_SCHEDULE_LISTING_STATUS,
  async handle(_env, c) {
    const n = await fanOut(
      c,
      'listing_status',
      () => withSystem(c.database.db, (tx) => tx.selectDistinct({ vendorId: A.vendorId, id: A.id, marketplace: A.marketplace }).from(A).innerJoin(L, and(eq(L.marketplaceAccountId, A.id), eq(L.vendorId, A.vendorId))).where(and(eq(A.status, 'active'), eq(L.status, 'pending'))).limit(5000)),
      (m) => {
        const conn = safeGet(c, m);
        return { ok: Boolean(conn?.capabilities.listings.statusLookup), intervalSec: conn?.polling?.listingStatus?.intervalSeconds ?? 600 };
      },
    );
    c.logger.info({ enqueued: n }, 'scheduled listing status checks');
  },
};

/** safety net for missed events: any account that still has dirty channel quantities gets an inventory job */
export const scheduleInventoryHandler: JobHandler = {
  queue: 'maintenance',
  name: JOB_SCHEDULE_INVENTORY,
  async handle(_env, c) {
    const n = await fanOut(
      c,
      'inventory',
      () => withSystem(c.database.db, (tx) => tx.selectDistinct({ vendorId: A.vendorId, id: A.id, marketplace: A.marketplace }).from(A).innerJoin(L, and(eq(L.marketplaceAccountId, A.id), eq(L.vendorId, A.vendorId))).where(and(eq(A.status, 'active'), eq(L.quantityDirty, true))).limit(5000)),
      (m) => ({ ok: Boolean(safeGet(c, m)?.capabilities.inventory.push), intervalSec: 120 }),
    );
    c.logger.info({ enqueued: n }, 'scheduled inventory syncs');
  },
};

const safeGet = (c: Parameters<JobHandler['handle']>[1], code: string) => { try { return c.connectors.get(code); } catch { return undefined; } };

const STUCK_QUEUED_MS = 5 * 60_000;
const STUCK_RUNNING_MS = 30 * 60_000;

/**
 * Crash recovery. (1) A job committed as `queued` whose queue message was never delivered (process died between commit
 * and enqueue) is dispatched again. (2) A job that has been `running` far longer than any runner should (worker killed)
 * goes back to `retrying`, or is dead-lettered when it has no attempts left.
 */
export const sweepHandler: JobHandler = {
  queue: 'maintenance',
  name: JOB_SWEEP,
  async handle(_env, c) {
    const now = Date.now();
    const stuck = await withSystem(c.database.db, (tx) =>
      tx.select().from(S).where(or(and(eq(S.status, 'queued'), lt(S.scheduledAt, new Date(now - STUCK_QUEUED_MS))), and(eq(S.status, 'retrying'), lt(S.nextRetryAt, new Date(now - STUCK_QUEUED_MS))), and(eq(S.status, 'running'), lt(S.startedAt, new Date(now - STUCK_RUNNING_MS))))).limit(200),
    );
    let redispatched = 0;
    for (const j of stuck) {
      if (j.status === 'running') {
        if (j.attempts >= j.maxAttempts) {
          await withVendor(c.database.db, j.vendorId, (tx) => tx.update(S).set({ status: 'dead_lettered', deadLetteredAt: new Date(), finishedAt: new Date(), error: { code: 'WORKER_LOST', message: 'The worker running this job disappeared' } }).where(eq(S.id, j.id)));
          continue;
        }
        const next = await withVendor(c.database.db, j.vendorId, async (tx) => (await tx.update(S).set({ status: 'retrying', nextRetryAt: new Date(), error: { code: 'WORKER_LOST', message: 'The worker running this job disappeared; retrying' } }).where(and(eq(S.id, j.id), eq(S.status, 'running'))).returning())[0]);
        if (next) { await dispatchSyncJob(c, next); redispatched++; }
      } else {
        await dispatchSyncJob(c, j);
        redispatched++;
      }
    }
    if (stuck.length) c.logger.warn({ stuck: stuck.length, redispatched, correlationId: getContext().correlationId }, 'sync sweep recovered jobs');
  },
};

export const syncJobHandlers: JobHandler[] = [scheduleOrdersHandler, scheduleListingStatusHandler, scheduleInventoryHandler, sweepHandler];

