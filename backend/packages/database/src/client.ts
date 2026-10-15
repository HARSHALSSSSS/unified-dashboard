import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { TenantScope } from '@oms/shared';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the root db or a transaction. Repositories accept this. */
export type Executor = Db | Tx;

export interface DbConfig {
  DATABASE_URL: string;
  DATABASE_POOL_MAX: number;
  DATABASE_POOL_IDLE_MS: number;
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  DATABASE_SSL: boolean;
}

export interface Database {
  db: Db;
  pool: pg.Pool;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(cfg: DbConfig, applicationName = 'oms'): Database {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    idleTimeoutMillis: cfg.DATABASE_POOL_IDLE_MS,
    statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS + 5_000,
    // fail fast instead of queueing forever when every connection is busy
    connectionTimeoutMillis: 5_000,
    // a crashed handler must not keep row locks, and nothing waits forever for a lock
    options: '-c idle_in_transaction_session_timeout=60000 -c lock_timeout=10000',
    application_name: applicationName,
    ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  });
  pool.on('error', () => {
    /* idle client errors must not crash the process; the next checkout re-connects */
  });
  return {
    db: drizzle(pool, { schema }),
    pool,
    ping: async () => void (await pool.query('select 1')),
    close: () => pool.end(),
  };
}

/**
 * THE tenancy primitive. Runs `fn` in a transaction with the Postgres session variables that the
 * row-level-security policies read (`app.scope`, `app.vendor_id`). `set_config(..., true)` is transaction-local,
 * so a pooled connection can never leak one tenant's context into the next request.
 *
 * Application code must never touch `db` directly for tenant data - always go through this (or a service
 * that does). A forgotten WHERE clause then returns zero rows instead of another vendor's rows.
 */
export async function withScope<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const vendorId = scope.kind === 'vendor' ? scope.vendorId : '';
    await tx.execute(sql`select set_config('app.scope', ${scope.kind}, true), set_config('app.vendor_id', ${vendorId}, true)`);
    return fn(tx);
  });
}

export const withVendor = <T>(db: Db, vendorId: string, fn: (tx: Tx) => Promise<T>) => withScope(db, { kind: 'vendor', vendorId }, fn);
/** Internal-only: login lookups, workers, migrations/seeds. Never reachable from request input. */
export const withSystem = <T>(db: Db, fn: (tx: Tx) => Promise<T>) => withScope(db, { kind: 'system' }, fn);
