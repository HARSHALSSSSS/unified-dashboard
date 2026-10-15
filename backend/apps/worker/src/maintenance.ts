import { and, lt, or, isNotNull } from 'drizzle-orm';
import { schema, withSystem } from '@oms/database';
import type { JobHandler } from '@oms/module-kit';

/** Platform housekeeping owned by the worker app (not business logic). Scheduled by apps/scheduler. */
export const maintenanceHandlers: JobHandler[] = [
  {
    queue: 'maintenance',
    name: 'purge-idempotency-keys',
    async handle(_env, c) {
      const rows = await withSystem(c.database.db, (tx) =>
        tx.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.expiresAt, new Date())).returning({ id: schema.idempotencyKeys.id }),
      );
      c.logger.info({ purged: rows.length }, 'purged expired idempotency keys');
    },
  },
  {
    queue: 'maintenance',
    name: 'purge-refresh-tokens',
    async handle(_env, c) {
      // keep revoked/expired tokens 7 days for forensic review of reuse-detection events
      const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const t = schema.refreshTokens;
      const rows = await withSystem(c.database.db, (tx) =>
        tx.delete(t).where(or(lt(t.expiresAt, cutoff), and(isNotNull(t.revokedAt), lt(t.revokedAt, cutoff)))).returning({ id: t.id }),
      );
      c.logger.info({ purged: rows.length }, 'purged expired refresh tokens');
    },
  },
  {
    queue: 'maintenance',
    name: 'purge-published-outbox',
    async handle(_env, c) {
      const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const t = schema.outboxEvents;
      const rows = await withSystem(c.database.db, (tx) =>
        tx.delete(t).where(and(isNotNull(t.publishedAt), lt(t.publishedAt, cutoff))).returning({ id: t.id }),
      );
      c.logger.info({ purged: rows.length }, 'purged published outbox events');
    },
  },
];
