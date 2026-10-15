import { UnrecoverableError, type Job } from 'bullmq';
import { runWithContext } from '@oms/logging';
import { DomainEventSchema, QUEUES, type JobEnvelope, type QueueKey } from '@oms/messaging';
import type { JobHandler, ModuleDefinition } from '@oms/module-kit';
import type { Runtime } from './index';

type Handler = JobHandler['handle'];

/**
 * Starts BullMQ workers for the given queues and routes each job to a module-provided handler by
 * `<queue>/<jobName>`. The `domain-events` queue is special: every event fans out to all matching module
 * consumers (isolated: one failing consumer is retried alone, it does not re-run the others).
 *
 * Every job runs inside the logging context of its originating request (correlationId + vendorId), so a single
 * business flow is traceable from the HTTP request through the outbox to the worker.
 */
export function startProcessors(rt: Runtime, modules: ModuleDefinition[], queueKeys: QueueKey[], extra: JobHandler[] = []): void {
  const { container, logger, metrics } = rt;
  const routes = new Map<string, Handler>();
  for (const h of [...modules.flatMap((m) => m.jobs ?? []), ...extra]) routes.set(`${QUEUES[h.queue].name}/${h.name}`, h.handle);
  const consumers = modules.flatMap((m) => m.consumers ?? []);

  for (const key of queueKeys) {
    const queueName = QUEUES[key].name;
    const worker = container.queues.createWorker<unknown>(
      key,
      async (job: Job<JobEnvelope>) => {
        const env = job.data;
        const ended = metrics.jobDuration.startTimer({ queue: queueName });
        return runWithContext(
          { correlationId: env.correlationId, vendorId: env.vendorId, jobId: job.id, queue: queueName },
          async () => {
            if (key === 'domainEvents') {
              const event = DomainEventSchema.parse(env.data);
              const matching = consumers.filter((c) => c.event === event.type || c.event === '*');
              const results = await Promise.allSettled(matching.map((c) => c.handle(event, container)));
              const failed = results.map((r, i) => ({ r, c: matching[i]! })).filter((x) => x.r.status === 'rejected');
              if (failed.length) {
                logger.error({ eventType: event.type, failed: failed.map((f) => f.c.name) }, 'event consumers failed');
                throw new Error(`consumers failed: ${failed.map((f) => f.c.name).join(',')}`);
              }
              return;
            }
            const handler = routes.get(`${queueName}/${job.name}`);
            if (!handler) throw new UnrecoverableError(`No handler registered for ${queueName}/${job.name}`);
            await handler(env, container, { id: job.id, attemptsMade: job.attemptsMade });
          },
        ).finally(() => ended());
      },
      { concurrency: rt.config.WORKER_CONCURRENCY },
    );

    worker.on('completed', () => metrics.jobsProcessed.inc({ queue: queueName, status: 'completed' }));
    worker.on('failed', (job, err) => {
      metrics.jobsProcessed.inc({ queue: queueName, status: 'failed' });
      const final = job ? job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError : true;
      logger[final ? 'error' : 'warn']({ err, queue: queueName, jobId: job?.id, jobName: job?.name, attempts: job?.attemptsMade, deadLettered: final }, 'job failed');
    });
    worker.on('error', (err) => logger.error({ err, queue: queueName }, 'worker error'));
    rt.onShutdown(`worker:${queueName}`, () => worker.close());
    logger.info({ queue: queueName, concurrency: rt.config.WORKER_CONCURRENCY }, 'processor started');
  }
}
