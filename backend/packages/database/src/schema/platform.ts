import { sql } from 'drizzle-orm';
import { bigserial, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, pk, tenantId, timestamps, tz } from './_helpers';
import { vendors } from './identity';
import { marketplaceAccounts } from './marketplace';

export const SYNC_TYPES = ['orders', 'inventory', 'prices', 'listings', 'listing_publish', 'listing_status', 'catalog_import', 'order_status', 'returns', 'tracking', 'full'] as const;
/** retrying = failed an attempt, waiting for the next one; dead_lettered = out of attempts, needs an operator (manual retry) */
export const SYNC_STATUSES = ['queued', 'running', 'retrying', 'succeeded', 'partially_failed', 'failed', 'dead_lettered', 'cancelled'] as const;
export const SYNC_TRIGGERS = ['schedule', 'manual', 'webhook', 'event', 'system', 'retry'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const ACTOR_TYPES = ['user', 'api_key', 'system', 'webhook'] as const;

/** A single synchronisation run for one marketplace account. idempotency_key makes enqueues safe to repeat. */
export const syncJobs = pgTable('sync_jobs', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  marketplaceAccountId: uuid('marketplace_account_id'),
  type: text('type').notNull(),
  status: text('status').notNull().default('queued'),
  trigger: text('trigger').notNull().default('schedule'),
  idempotencyKey: text('idempotency_key').notNull(),
  scheduledAt: tz('scheduled_at').notNull().defaultNow(),
  startedAt: tz('started_at'),
  finishedAt: tz('finished_at'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  nextRetryAt: tz('next_retry_at'),
  deadLetteredAt: tz('dead_lettered_at'),
  /** what to run: parameters for the job type (listing ids, order id, cursor...) */
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  /** resumable position: marketplace cursor / watermark */
  cursor: jsonb('cursor').$type<Record<string, unknown>>(),
  /** { total, done, failed } while running */
  progress: jsonb('progress').$type<{ total: number; done: number; failed: number }>().notNull().default({ total: 0, done: 0, failed: 0 }),
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
  error: jsonb('error').$type<{ code: string; message: string }>(),
  /** per-item failures of the last attempt (bounded) */
  failureDetails: jsonb('failure_details').$type<Array<{ ref: string; code?: string; message: string }>>().notNull().default([]),
  requestedBy: uuid('requested_by'),
  queueJobId: text('queue_job_id'),
  ...timestamps(),
}, (t) => [
  unique('sync_jobs_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('sync_jobs_vendor_idem_uq').on(t.vendorId, t.idempotencyKey),
  index('sync_jobs_vendor_account_idx').on(t.vendorId, t.marketplaceAccountId, t.createdAt.desc()),
  index('sync_jobs_status_idx').on(t.status, t.scheduledAt).where(sql`${t.status} IN ('queued','running','retrying')`),
  index('sync_jobs_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.marketplaceAccountId], foreignColumns: [marketplaceAccounts.vendorId, marketplaceAccounts.id], name: 'sync_jobs_account_fk' }),
  check('sync_jobs_type_chk', inList('type', SYNC_TYPES)),
  check('sync_jobs_status_chk', inList('status', SYNC_STATUSES)),
  check('sync_jobs_trigger_chk', inList('trigger', SYNC_TRIGGERS)),
]);

/** High-volume, append-only. Candidate for time partitioning (see docs/database/DATABASE.md). */
export const syncLogs = pgTable('sync_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  syncJobId: uuid('sync_job_id').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('sync_logs_job_idx').on(t.vendorId, t.syncJobId, t.id),
  index('sync_logs_created_idx').on(t.createdAt),
  foreignKey({ columns: [t.vendorId, t.syncJobId], foreignColumns: [syncJobs.vendorId, syncJobs.id], name: 'sync_logs_job_fk' }).onDelete('cascade'),
  check('sync_logs_level_chk', inList('level', LOG_LEVELS)),
]);

/**
 * Append-only audit trail. vendor_id NULL => platform-level action. UPDATE/DELETE are blocked by a trigger
 * (see migration 0001_rls_and_guards). `before`/`after` hold redacted snapshots, never secrets.
 */
export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  /** when platform staff act inside a vendor */
  onBehalfOfVendorId: uuid('on_behalf_of_vendor_id'),
  action: text('action').notNull(), // e.g. product.update, auth.login_failed
  /** where the action came from: api | webhook | job | system | marketplace */
  source: text('source').notNull().default('api'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  requestId: text('request_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  before: jsonb('before'),
  after: jsonb('after'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('audit_logs_vendor_created_idx').on(t.vendorId, t.createdAt.desc(), t.id),
  index('audit_logs_resource_idx').on(t.vendorId, t.resourceType, t.resourceId),
  index('audit_logs_actor_idx').on(t.vendorId, t.actorId, t.createdAt.desc()),
  index('audit_logs_request_idx').on(t.requestId),
  check('audit_logs_actor_type_chk', inList('actor_type', ACTOR_TYPES)),
]);

/** HTTP idempotency (Idempotency-Key header). Rows are short-lived (TTL purge job). */
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: pk(),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  /** METHOD + route template */
  scope: text('scope').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  lockedAt: tz('locked_at'),
  expiresAt: tz('expires_at').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('idempotency_keys_uq').on(sql`coalesce(${t.vendorId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.scope, t.key),
  index('idempotency_keys_expires_idx').on(t.expiresAt),
]);

/** Transactional outbox: written in the same transaction as the state change, relayed to the event queue. */
export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  vendorId: uuid('vendor_id'),
  type: text('type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  correlationId: text('correlation_id').notNull(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
  publishedAt: tz('published_at'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
}, (t) => [
  index('outbox_events_unpublished_idx').on(t.occurredAt).where(sql`${t.publishedAt} IS NULL`),
  index('outbox_events_vendor_idx').on(t.vendorId, t.occurredAt),
]);

export { timestamps };
