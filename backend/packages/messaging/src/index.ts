import { Queue, Worker, QueueEvents, type Processor, type JobsOptions, type WorkerOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import { z } from 'zod';
import { newId } from '@oms/shared';

// ---------------------------------------------------------------------------------------------
// Redis connections
// ---------------------------------------------------------------------------------------------
export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  // BullMQ requires maxRetriesPerRequest=null on blocking connections.
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, ...opts });
}

// ---------------------------------------------------------------------------------------------
// Domain event envelope. Events are written to the `outbox_events` table in the SAME transaction as the
// state change (transactional outbox), then relayed to the queue below by the outbox relay.
// ---------------------------------------------------------------------------------------------
export const DomainEventSchema = z.object({
  id: z.string(),
  type: z.string().regex(/^[a-z_]+\.[a-z_]+$/, 'event type must look like "order.created"'),
  version: z.number().int().default(1),
  vendorId: z.string().nullable(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  occurredAt: z.string().datetime(),
  correlationId: z.string(),
  causationId: z.string().nullable().default(null),
  payload: z.unknown(),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const createEvent = (e: Omit<DomainEvent, 'id' | 'occurredAt' | 'version' | 'causationId'> & Partial<Pick<DomainEvent, 'causationId'>>): DomainEvent => ({
  id: newId(),
  version: 1,
  occurredAt: new Date().toISOString(),
  causationId: null,
  ...e,
});

// ---------------------------------------------------------------------------------------------
// Queue catalogue. Every queue is declared here: name, default retry policy, intent.
// Separate queues per workload type so a marketplace outage can't starve other work.
// ---------------------------------------------------------------------------------------------
export const QUEUES = {
  /** relayed domain events fan out to module consumers */
  domainEvents: { name: 'domain-events', attempts: 5, backoffMs: 2_000 },
  /** inbound webhook payloads (already verified + deduped) awaiting processing */
  webhooksInbound: { name: 'webhooks-inbound', attempts: 8, backoffMs: 5_000 },
  /** marketplace synchronisation runs (per marketplace_account) */
  syncMarketplace: { name: 'sync-marketplace', attempts: 3, backoffMs: 30_000 },
  /** outbound pushes (inventory/price/listing) — rate limited per account in the processor */
  marketplacePush: { name: 'marketplace-push', attempts: 5, backoffMs: 10_000 },
  /** notifications, emails */
  notifications: { name: 'notifications', attempts: 5, backoffMs: 5_000 },
  /** heavy async work: reports, exports, image processing, AI */
  heavy: { name: 'heavy', attempts: 2, backoffMs: 60_000 },
  /** housekeeping triggered by the scheduler */
  maintenance: { name: 'maintenance', attempts: 2, backoffMs: 30_000 },
} as const;
export type QueueKey = keyof typeof QUEUES;

export const defaultJobOptions = (q: (typeof QUEUES)[QueueKey]): JobsOptions => ({
  attempts: q.attempts,
  backoff: { type: 'exponential', delay: q.backoffMs },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 }, // retained as the dead-letter view for operators
});

/** Job payloads are always an envelope so tenant + correlation travel with every job. */
export const JobEnvelopeSchema = z.object({
  vendorId: z.string().nullable(),
  correlationId: z.string(),
  /** business idempotency key; also used as BullMQ jobId to dedupe enqueues */
  idempotencyKey: z.string().optional(),
  data: z.unknown(),
});
export type JobEnvelope<T = unknown> = Omit<z.infer<typeof JobEnvelopeSchema>, 'data'> & { data: T };

export class QueueRegistry {
  private readonly queues = new Map<QueueKey, Queue>();
  constructor(private readonly connection: Redis, private readonly prefix: string) {}

  queue(key: QueueKey): Queue {
    let q = this.queues.get(key);
    if (!q) {
      const def = QUEUES[key];
      q = new Queue(def.name, { connection: this.connection, prefix: this.prefix, defaultJobOptions: defaultJobOptions(def) });
      this.queues.set(key, q);
    }
    return q;
  }

  async enqueue<T>(key: QueueKey, jobName: string, envelope: JobEnvelope<T>, opts: JobsOptions = {}) {
    return this.queue(key).add(jobName, envelope, { ...(envelope.idempotencyKey ? { jobId: envelope.idempotencyKey } : {}), ...opts });
  }

  createWorker<T>(key: QueueKey, processor: Processor<JobEnvelope<T>>, opts: Partial<WorkerOptions> = {}): Worker<JobEnvelope<T>> {
    return new Worker(QUEUES[key].name, processor, { connection: this.connection, prefix: this.prefix, concurrency: 5, ...opts });
  }

  events(key: QueueKey): QueueEvents {
    return new QueueEvents(QUEUES[key].name, { connection: this.connection.duplicate(), prefix: this.prefix });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
