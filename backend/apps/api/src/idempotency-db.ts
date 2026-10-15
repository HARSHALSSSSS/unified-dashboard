import { and, eq, sql } from 'drizzle-orm';
import { schema, withScope, type Database } from '@oms/database';
import type { TenantScope } from '@oms/shared';
import type { IdempotencyBegin, IdempotencyKeyRef, IdempotencyStore } from './plugins/idempotency';

const STALE_LOCK_SECONDS = 60;

/** Postgres-backed idempotency store (table `idempotency_keys`, unique on vendor+scope+key). */
export class DbIdempotencyStore implements IdempotencyStore {
  constructor(private readonly database: Database) {}

  private scopeOf = (r: IdempotencyKeyRef): TenantScope => (r.vendorId ? { kind: 'vendor', vendorId: r.vendorId } : { kind: 'system' });

  async begin(r: IdempotencyKeyRef & { requestHash: string; ttlSeconds: number }): Promise<IdempotencyBegin> {
    return withScope(this.database.db, this.scopeOf(r), async (tx) => {
      const t = schema.idempotencyKeys;
      const inserted = await tx
        .insert(t)
        .values({ vendorId: r.vendorId, key: r.key, scope: r.scope, requestHash: r.requestHash, lockedAt: new Date(), expiresAt: new Date(Date.now() + r.ttlSeconds * 1000) })
        .onConflictDoNothing()
        .returning({ id: t.id });
      if (inserted.length) return { state: 'new' } as const;

      const [row] = await tx
        .select()
        .from(t)
        .where(and(r.vendorId ? eq(t.vendorId, r.vendorId) : sql`${t.vendorId} IS NULL`, eq(t.scope, r.scope), eq(t.key, r.key)))
        .for('update');
      if (!row) return { state: 'in_progress' } as const; // raced with a purge; caller can retry
      if (row.expiresAt < new Date()) {
        await tx.update(t).set({ requestHash: r.requestHash, responseStatus: null, responseBody: null, lockedAt: new Date(), expiresAt: new Date(Date.now() + r.ttlSeconds * 1000) }).where(eq(t.id, row.id));
        return { state: 'new' } as const;
      }
      if (row.requestHash !== r.requestHash) return { state: 'mismatch' } as const;
      if (row.responseStatus === null) {
        // A crashed worker must not block the key forever: take over stale locks.
        if (row.lockedAt && Date.now() - row.lockedAt.getTime() > STALE_LOCK_SECONDS * 1000) {
          await tx.update(t).set({ lockedAt: new Date() }).where(eq(t.id, row.id));
          return { state: 'new' } as const;
        }
        return { state: 'in_progress' } as const;
      }
      return { state: 'replay', status: row.responseStatus, body: row.responseBody } as const;
    });
  }

  async complete(r: IdempotencyKeyRef & { status: number; body: unknown }): Promise<void> {
    await withScope(this.database.db, this.scopeOf(r), (tx) =>
      tx
        .update(schema.idempotencyKeys)
        .set({ responseStatus: r.status, responseBody: r.body as never, lockedAt: null })
        .where(and(r.vendorId ? eq(schema.idempotencyKeys.vendorId, r.vendorId) : sql`${schema.idempotencyKeys.vendorId} IS NULL`, eq(schema.idempotencyKeys.scope, r.scope), eq(schema.idempotencyKeys.key, r.key))),
    );
  }

  async release(r: IdempotencyKeyRef): Promise<void> {
    await withScope(this.database.db, this.scopeOf(r), (tx) =>
      tx
        .delete(schema.idempotencyKeys)
        .where(and(r.vendorId ? eq(schema.idempotencyKeys.vendorId, r.vendorId) : sql`${schema.idempotencyKeys.vendorId} IS NULL`, eq(schema.idempotencyKeys.scope, r.scope), eq(schema.idempotencyKeys.key, r.key))),
    );
  }
}
