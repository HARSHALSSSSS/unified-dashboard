import { and, eq, inArray, lt, or, schema, withSystem } from '@oms/database';
import type { JobHandler } from '@oms/module-kit';
import { manifest } from './manifest';
import { webhookRoutes } from './routes';
import { enqueueProcessing, PROCESS_JOB, processWebhookEvent, retentionSql } from './service';

export { manifest };
export { webhookRoutes } from './routes';
export { receiveWebhook, processWebhookEvent, rotateSecret } from './service';

const W = schema.webhookEvents;

/** processes one stored event (queue: webhooks-inbound) */
const processHandler: JobHandler = {
  queue: 'webhooksInbound',
  name: PROCESS_JOB,
  async handle(env, c) {
    const eventId = (env.data as { eventId?: string } | null)?.eventId;
    if (eventId && env.vendorId) await processWebhookEvent(c, env.vendorId, eventId);
  },
};

/**
 * Safety net: an event that was stored but whose queue message was lost (Redis down at receipt, worker crash) is queued
 * again; old finished events are purged. Idempotent: processing only claims `received` / `failed` events.
 */
const sweepHandler: JobHandler = {
  queue: 'maintenance',
  name: 'webhooks.sweep',
  async handle(_env, c) {
    const now = Date.now();
    // a worker that died between "claim" and "outcome" leaves an event in `processing` forever: hand it back after 10 minutes
    await withSystem(c.database.db, (tx) => tx.update(W).set({ status: 'failed', nextRetryAt: new Date(now) }).where(and(eq(W.status, 'processing'), lt(W.updatedAt, new Date(now - 10 * 60_000)))));
    const stale = await withSystem(c.database.db, (tx) =>
      tx.select().from(W).where(or(and(inArray(W.status, ['received']), lt(W.receivedAt, new Date(now - 2 * 60_000))), and(inArray(W.status, ['failed']), lt(W.nextRetryAt, new Date(now - 60_000))))).limit(500),
    );
    for (const e of stale) await enqueueProcessing(c, e.vendorId, e.id, e.attempts + 1);
    const purged = await withSystem(c.database.db, (tx) => tx.delete(W).where(retentionSql(c.config.WEBHOOK_RETENTION_DAYS)).returning({ id: W.id }));
    if (stale.length || purged.length) c.logger.info({ requeued: stale.length, purged: purged.length }, 'webhook sweep');
  },
};

/**
 * Webhooks: public receipt with per-account signature verification, idempotent persistence, fast acknowledgement and
 * asynchronous processing with retries and dead-lettering.
 */
export const webhooksModule = { manifest, routes: webhookRoutes, jobs: [processHandler, sweepHandler] };
