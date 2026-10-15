import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allModules } from '@oms/modules-registry';
import { buildTestApp, clientFor, mockControl, type Actor, type TestApp } from '@oms/testing';

let t: TestApp;
let c: ReturnType<typeof clientFor>;
let admin: Actor;
let viewer: Actor;
let wh: { id: string };

beforeAll(async () => {
  // 3 attempts so a persistent failure reaches the dead-letter state quickly
  t = await buildTestApp({ database: true, config: { SYNC_MAX_ATTEMPTS: '3' } });
  c = clientFor(t);
});
beforeEach(async () => {
  mockControl.reset();
  mockControl.configure({ seedOrders: false });
  admin = await c.registerVendor({ businessName: 'Sync Co' });
  viewer = await c.addMember(admin, 'vendor_viewer');
  wh = await c.makeWarehouse(admin);
});
afterAll(() => t.close());

const jobs = async (q = '', as: Actor = admin) => (await c.get(`/api/v1/sync/jobs${q}`, as)).body.data as any[];
const job = async (id: string, as: Actor = admin) => (await c.get(`/api/v1/sync/jobs/${id}`, as)).body.data;
const sync = async (acct: { id: string }, as: Actor = admin) => (await c.post(`/api/v1/marketplace-accounts/${acct.id}/sync-orders`, {}, as)).body.data.job;
const logs = async (id: string) => (await c.get(`/api/v1/sync/jobs/${id}/logs`, admin)).body.data.items as any[];
/** an order the marketplace holds, so a sync has real work to do */
const withOrder = async () => {
  const acct = await c.connectAccount(admin, 'mock');
  const v = await c.makeVariant(admin);
  await c.stock(admin, v.variantId, wh.id, 10);
  mockControl.state.seller(acct.sellerId).products.set(v.sku, { externalListingId: 'MP-1', externalSku: v.sku, title: 'x', priceMinor: 1000, currency: 'INR', quantity: 5, status: 'active' } as never);
  mockControl.placeOrder(acct.sellerId, [{ sku: v.sku, quantity: 1 }]);
  return { acct, v };
};

describe('job lifecycle: API -> job -> queue -> worker -> connector -> normalise -> DB -> sync log', () => {
  it('a successful run leaves a complete, queryable history', async () => {
    const { acct } = await withOrder();
    const j = await sync(acct);
    expect(j).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 3, type: 'orders', trigger: 'manual', marketplaceAccountId: acct.id });
    expect(t.pendingJobs((p) => p.name === 'sync.orders')).toHaveLength(1);
    await t.pump();
    const done = await job(j.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1, error: null, progress: { total: 0, done: 1, failed: 0 }, stats: { fetched: 1, created: 1 } });
    expect(done.startedAt && done.finishedAt).toBeTruthy();
    const l = await logs(j.id);
    expect(l.map((x) => x.message)).toEqual([expect.stringContaining('attempt 1/3 started'), expect.stringContaining('fetching orders'), 'finished']);
    expect((await c.get('/api/v1/sync/summary', admin)).body.data).toMatchObject({ byStatus: { succeeded: 1 }, needsAttention: 0, deadLettered: 0 });
    // the account records the sync
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data.lastSyncedAt).toBeTruthy();
    expect((await t.outbox('sync.completed')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(1);
  });

  it('redelivery of the same queue message does not run the job twice', async () => {
    const { acct } = await withOrder();
    const j = await sync(acct);
    const recorded = t.pendingJobs((p) => p.name === 'sync.orders')[0]!;
    await t.pump();
    const handler = allModules.flatMap((m) => m.jobs ?? []).find((h) => h.name === 'sync.orders')!;
    await handler.handle(recorded.envelope as never, t.container, { id: 'again', attemptsMade: 0 });
    await handler.handle(recorded.envelope as never, t.container, { id: 'again2', attemptsMade: 0 });
    expect((await job(j.id)).attempts).toBe(1);
    expect((await c.get('/api/v1/orders', admin)).body.data).toHaveLength(1);
  });

  it('manual triggers coalesce while a job is waiting', async () => {
    const { acct } = await withOrder();
    const first = await sync(acct);
    const second = await sync(acct);
    expect(second.id).toBe(first.id);
    expect(await jobs('?filter[type]=orders')).toHaveLength(1);
    await t.pump();
    const third = await sync(acct); // the first one finished: this is new work
    expect(third.id).not.toBe(first.id);
  });

  it('can be filtered, paged and cancelled while waiting', async () => {
    const { acct } = await withOrder();
    const j = await sync(acct);
    const cancelled = await c.post(`/api/v1/sync/jobs/${j.id}/cancel`, {}, admin);
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled' });
    await t.pump(); // the queued message finds a cancelled job and stops
    expect((await job(j.id)).status).toBe('cancelled');
    expect((await c.get('/api/v1/orders', admin)).body.data).toHaveLength(0);
    expect((await c.post(`/api/v1/sync/jobs/${j.id}/cancel`, {}, admin)).status).toBe(409);
    expect(await jobs(`?filter[status]=cancelled&filter[accountId]=${acct.id}`)).toHaveLength(1);
    expect(await jobs('?filter[status]=succeeded')).toHaveLength(0);
  });
});

describe('retries with exponential backoff, dead-lettering, manual retry', () => {
  it('a failing marketplace is retried until it recovers', async () => {
    const { acct } = await withOrder();
    mockControl.setBehavior(acct.sellerId, { failNext: 100, failKind: 'transient' });
    const j = await sync(acct);
    await t.runJobs();
    let cur = await job(j.id);
    expect(cur).toMatchObject({ status: 'retrying', attempts: 1, error: { code: expect.any(String) } });
    expect(cur.nextRetryAt).toBeTruthy();
    expect((await logs(j.id)).some((x) => /retrying in/.test(x.message))).toBe(true);
    // the retry was queued as a DELAYED job
    const retryMsg = t.pendingJobs((p) => p.name === 'sync.orders')[0]!;
    expect(retryMsg.envelope.idempotencyKey).toMatch(/-r0-a1$/);
    expect(retryMsg.opts).toBeDefined();

    mockControl.setBehavior(acct.sellerId, {});
    await t.pump();
    cur = await job(j.id);
    expect(cur).toMatchObject({ status: 'succeeded', attempts: 2, error: null, nextRetryAt: null });
    expect((await c.get('/api/v1/orders', admin)).body.data).toHaveLength(1);
  });

  it('after the last attempt the job is dead-lettered, visible, and can be retried by hand', async () => {
    const { acct } = await withOrder();
    mockControl.setBehavior(acct.sellerId, { failNext: 1000, failKind: 'transient' });
    const j = await sync(acct);
    await t.pump();
    const dead = await job(j.id);
    expect(dead).toMatchObject({ status: 'dead_lettered', attempts: 3, maxAttempts: 3 });
    expect(dead.deadLetteredAt).toBeTruthy();
    expect((await c.get('/api/v1/sync/summary', admin)).body.data).toMatchObject({ deadLettered: 1, needsAttention: 1 });
    expect((await t.outbox('sync.dead_lettered')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(1);
    const l = await logs(j.id);
    expect(l.filter((x) => /started/.test(x.message))).toHaveLength(3);
    expect(l.at(-1)!.message).toMatch(/dead-lettered after 3 attempts/);
    // the account is flagged as degraded by the failures
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data.connectionStatus).toBe('degraded');

    // fix the marketplace; an operator retries: fresh attempt budget, same job row, history kept
    mockControl.setBehavior(acct.sellerId, {});
    const r = await c.post(`/api/v1/sync/jobs/${j.id}/retry`, {}, admin);
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ status: 'queued', attempts: 0, trigger: 'retry', deadLetteredAt: null, stats: { manualRetries: 1 } });
    await t.pump();
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect((await logs(j.id)).some((x) => x.message === 'manual retry requested')).toBe(true);
    expect((await c.post(`/api/v1/sync/jobs/${j.id}/retry`, {}, admin)).status).toBe(409); // succeeded jobs are not retried
  });

  it('rejected credentials fail the job immediately (no blind retries) and expire the authorization', async () => {
    const { acct } = await withOrder();
    mockControl.setBehavior(acct.sellerId, { failNext: 100, failKind: 'auth' });
    const j = await sync(acct);
    await t.pump();
    const cur = await job(j.id);
    expect(cur).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'AUTH_FAILED' } });
    expect((await c.get(`/api/v1/marketplace-accounts/${acct.id}`, admin)).body.data).toMatchObject({ status: 'error', connectionStatus: 'error', authorization: { status: 'expired' } });
    expect((await t.outbox('marketplace_account.authorization_expired')).filter((e) => e.vendorId === admin.vendorId).length).toBeGreaterThan(0);
    expect((await t.outbox('sync.failed')).filter((e) => e.vendorId === admin.vendorId)).toHaveLength(1);
  });

  it('a permanent rejection of a whole request fails the job without retrying', async () => {
    const { acct } = await withOrder();
    mockControl.setBehavior(acct.sellerId, { failNext: 100, failKind: 'permanent' });
    const j = await sync(acct);
    await t.pump();
    expect(await job(j.id)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('rate limiting alone does not fail a job: Retry-After is honoured within the call', async () => {
    const { acct } = await withOrder();
    mockControl.setBehavior(acct.sellerId, { rateLimitNext: 2, retryAfterMs: 1 });
    const j = await sync(acct);
    await t.pump();
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('a sustained rate limit becomes a delayed job retry (not a failure)', async () => {
    const { acct } = await withOrder();
    mockControl.setBehavior(acct.sellerId, { rateLimitNext: 50, retryAfterMs: 1 });
    const j = await sync(acct);
    await t.runJobs();
    expect(await job(j.id)).toMatchObject({ status: 'retrying', error: { code: 'RATE_LIMITED' } });
    mockControl.setBehavior(acct.sellerId, {});
    await t.pump();
    expect((await job(j.id)).status).toBe('succeeded');
  });

  it('an unconnected account fails permanently with a clear reason', async () => {
    const acct = (await c.post('/api/v1/marketplace-accounts', { marketplace: 'mock', displayName: 'Idle' }, admin)).body.data;
    const j = await sync(acct);
    await t.pump();
    expect(await job(j.id)).toMatchObject({ status: 'failed', error: { code: 'ACCOUNT_NOT_CONNECTED' } });
  });
});

describe('scheduling and crash recovery', () => {
  it('the scheduled fan-out creates ONE order sync per active account per interval', async () => {
    const a = await c.connectAccount(admin, 'mock');
    const b = await c.connectAccount(admin, 'mock');
    const paused = await c.connectAccount(admin, 'mock');
    await c.patch(`/api/v1/marketplace-accounts/${paused.id}`, { status: 'paused' }, admin);
    const fan = () => t.queues.enqueue('maintenance', 'sync.schedule-orders', { vendorId: null, correlationId: `fan-${Math.random()}`, data: {} });
    await fan();
    await t.runJobs((p) => p.name === 'sync.schedule-orders');
    await fan(); // a second scheduler tick in the same interval
    await t.runJobs((p) => p.name === 'sync.schedule-orders');
    const queued = await jobs('?filter[type]=orders');
    expect(queued.map((x) => x.marketplaceAccountId).sort()).toEqual([a.id, b.id].sort());
    expect(queued.every((x) => x.trigger === 'schedule')).toBe(true);
    await t.pump();
    expect((await jobs('?filter[type]=orders')).every((x) => x.status === 'succeeded')).toBe(true);
  });

  it('the sweeper re-dispatches a job whose queue message was lost, and recovers a job stuck in `running`', async () => {
    const { acct } = await withOrder();
    const lost = await sync(acct);
    // simulate the process dying between commit and enqueue: the row exists, the message does not, and it is old
    const pg = t.database!.pg;
    await pg.exec('RESET ROLE');
    await pg.query(`update sync_jobs set scheduled_at = now() - interval '10 minutes' where id = $1`, [lost.id]);
    await pg.exec('SET ROLE oms_app');
    t.queues.jobs.length = 0;
    await t.queues.enqueue('maintenance', 'sync.sweep', { vendorId: null, correlationId: 'sweep-1', data: {} });
    await t.pump();
    expect((await job(lost.id)).status).toBe('succeeded');

    // a worker that died mid-run: `running` for far too long
    mockControl.placeOrder(acct.sellerId, [{ sku: [...mockControl.state.seller(acct.sellerId).products.keys()][0]!, quantity: 1 }]);
    const stuck = await sync(acct);
    t.queues.jobs.length = 0;
    await pg.exec('RESET ROLE');
    await pg.query(`update sync_jobs set status = 'running', attempts = 1, started_at = now() - interval '2 hours' where id = $1`, [stuck.id]);
    await pg.exec('SET ROLE oms_app');
    await t.queues.enqueue('maintenance', 'sync.sweep', { vendorId: null, correlationId: 'sweep-2', data: {} });
    await t.pump();
    expect(await job(stuck.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});

describe('access control', () => {
  it('sync history is tenant-isolated and permission-gated', async () => {
    const { acct } = await withOrder();
    const j = await sync(acct);
    const other = await c.registerVendor({ businessName: 'Spy Co' });
    expect((await c.get(`/api/v1/sync/jobs/${j.id}`, other)).status).toBe(404);
    expect((await c.get(`/api/v1/sync/jobs/${j.id}/logs`, other)).status).toBe(404);
    expect((await c.post(`/api/v1/sync/jobs/${j.id}/retry`, {}, other)).status).toBe(404);
    expect(await jobs('', other)).toHaveLength(0);
    expect((await c.post(`/api/v1/sync/jobs/${j.id}/cancel`, {}, viewer)).status).toBe(403);
    expect((await c.get(`/api/v1/sync/jobs/${j.id}`, viewer)).status).toBe(200);
    // other vendors cannot start a sync on MY account
    expect((await c.post(`/api/v1/marketplace-accounts/${acct.id}/sync-orders`, {}, other)).status).toBe(404);
  });
});
