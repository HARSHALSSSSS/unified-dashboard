import { describe, expect, it } from 'vitest';
import { createRedis, QueueRegistry, QUEUES, defaultJobOptions } from '@oms/messaging';

/**
 * Needs a real Redis: `pnpm infra:up` then `TEST_REDIS_URL=redis://localhost:6379 pnpm test:integration`.
 * Skipped automatically when TEST_REDIS_URL is not set (the CI integration job sets it).
 */
describe.skipIf(!process.env.TEST_REDIS_URL)('queues (redis)', () => {
  it('dedupes enqueues by idempotency key and carries tenant + correlation in the envelope', async () => {
    const redis = createRedis(process.env.TEST_REDIS_URL!);
    const q = new QueueRegistry(redis, `test:${Date.now()}`);
    const env = { vendorId: 'v1', correlationId: 'c1', idempotencyKey: 'order-123', data: { a: 1 } };
    const a = await q.enqueue('syncMarketplace', 'sync-orders', env);
    const b = await q.enqueue('syncMarketplace', 'sync-orders', env);
    expect(a.id).toBe(b.id);
    expect((await q.queue('syncMarketplace').getJobCounts('waiting')).waiting).toBe(1);
    expect(a.data).toMatchObject({ vendorId: 'v1', correlationId: 'c1' });
    await q.queue('syncMarketplace').obliterate({ force: true });
    await q.close();
    redis.disconnect();
  });
});

describe('queue catalogue', () => {
  it('every queue has a bounded retry policy and keeps failed jobs for inspection (dead-letter view)', () => {
    for (const def of Object.values(QUEUES)) {
      const o = defaultJobOptions(def);
      expect(o.attempts).toBeGreaterThan(0);
      expect(o.backoff).toMatchObject({ type: 'exponential' });
      expect(o.removeOnFail).toBeTruthy();
    }
  });
});
