import { sql } from 'drizzle-orm';
import { schema, withSystem } from '@oms/database';
import type { Runtime } from './index';

const BATCH = 100;
const MAX_ATTEMPTS = 10;

/**
 * Transactional-outbox relay. Domain events are INSERTed into `outbox_events` in the same DB transaction as the
 * state change that caused them (so an event exists iff the change committed). This loop moves them to the
 * `domain-events` queue (at-least-once; consumers must be idempotent; BullMQ jobId = event id dedupes enqueues).
 *
 * `FOR UPDATE SKIP LOCKED` lets many relay instances run concurrently without double-publishing.
 */
export function startOutboxRelay(rt: Runtime, intervalMs = 1000): void {
  const { database, queues } = rt.container;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      let published = 0;
      do {
        published = await withSystem(database.db, async (tx) => {
          const rows = await tx.execute<{ id: string; vendor_id: string | null; type: string; aggregate_type: string; aggregate_id: string; payload: unknown; correlation_id: string; occurred_at: Date }>(
            sql`SELECT id, vendor_id, type, aggregate_type, aggregate_id, payload, correlation_id, occurred_at
                FROM outbox_events WHERE published_at IS NULL AND attempts < ${MAX_ATTEMPTS}
                ORDER BY occurred_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
          );
          for (const r of rows.rows) {
            try {
              await queues.enqueue('domainEvents', r.type, {
                vendorId: r.vendor_id,
                correlationId: r.correlation_id,
                idempotencyKey: r.id,
                data: {
                  id: r.id, type: r.type, version: 1, vendorId: r.vendor_id, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
                  occurredAt: new Date(r.occurred_at).toISOString(), correlationId: r.correlation_id, causationId: null, payload: r.payload,
                },
              });
              await tx.update(schema.outboxEvents).set({ publishedAt: new Date() }).where(sql`${schema.outboxEvents.id} = ${r.id}`);
            } catch (err) {
              await tx.update(schema.outboxEvents).set({ attempts: sql`${schema.outboxEvents.attempts} + 1`, lastError: String(err).slice(0, 500) }).where(sql`${schema.outboxEvents.id} = ${r.id}`);
              rt.logger.warn({ err, eventId: r.id }, 'outbox publish failed');
            }
          }
          return rows.rows.length;
        });
      } while (published === BATCH && !stopped);
    } catch (err) {
      rt.logger.error({ err }, 'outbox relay tick failed');
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  rt.onShutdown('outbox-relay', async () => { stopped = true; if (timer) clearTimeout(timer); });
}
