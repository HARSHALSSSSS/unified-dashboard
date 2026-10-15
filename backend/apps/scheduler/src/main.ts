import { createRuntime, startOpsServer } from '@oms/runtime';
import { newId } from '@oms/shared';
import { QUEUES, type QueueKey } from '@oms/messaging';
import { SCHEDULES } from './schedules';

/**
 * Scheduler: registers repeatable job schedulers in Redis (BullMQ Job Schedulers). It does NOT execute work, it
 * only enqueues. `upsertJobScheduler` is idempotent and Redis-coordinated, so running several scheduler
 * replicas never produces duplicate runs, and a restart never loses or duplicates the schedule.
 */
const rt = await createRuntime('scheduler');
startOpsServer(rt, rt.config.WORKER_HEALTH_PORT);

for (const s of SCHEDULES) {
  const queue = rt.container.queues.queue(s.queue as QueueKey);
  await queue.upsertJobScheduler(
    s.id,
    s.every ? { every: s.every } : { pattern: s.cron!, tz: 'Asia/Kolkata' },
    { name: s.job, data: { vendorId: null, correlationId: newId(), data: s.data ?? {} } },
  );
  rt.logger.info({ schedule: s.id, queue: QUEUES[s.queue as QueueKey].name, job: s.job, every: s.every, cron: s.cron }, 'schedule registered');
}

// Remove schedulers that no longer exist in code (config is the source of truth).
for (const key of Object.keys(QUEUES) as QueueKey[]) {
  const q = rt.container.queues.queue(key);
  const known = new Set(SCHEDULES.map((s) => s.id));
  for (const js of await q.getJobSchedulers()) {
    if (js.key && !known.has(js.key)) {
      await q.removeJobScheduler(js.key);
      rt.logger.info({ schedule: js.key }, 'stale schedule removed');
    }
  }
}

rt.logger.info({ count: SCHEDULES.length }, 'scheduler started');
