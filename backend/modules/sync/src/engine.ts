import { and, desc, eq, inArray, schema, sql, withVendor, writeAudit, writeOutboxEvent, type Tx } from '@oms/database';
import { getContext } from '@oms/logging';
import type { JobEnvelope, QueueKey } from '@oms/messaging';
import { AppError } from '@oms/shared';
import { ConnectorHost } from '@oms/mod-marketplace-connectors';
import type { Container } from '@oms/module-kit';

/**
 * Async sync engine.
 *
 *   API / event / schedule -> createSyncJob (durable row, idempotent) -> dispatch (queue) -> worker
 *   -> executeSyncJob(runner) -> connector host -> marketplace -> normalise -> DB -> sync_logs
 *
 * The job ROW is the source of truth (status, attempts, progress, failures); the queue message is only a wake-up.
 * Retries are owned here (status `retrying` + delayed re-dispatch with exponential backoff), not by BullMQ, so that
 * the history is visible and the dead-letter state is explicit. A runner must be idempotent and commit per item.
 */
const S = schema.syncJobs;

export type SyncJobRow = typeof S.$inferSelect;
export type SyncType = (typeof schema.SYNC_TYPES)[number];
export type SyncTrigger = (typeof schema.SYNC_TRIGGERS)[number];

/** Which queue runs which job type. Pushes share one rate-limited queue; reads share another. */
export const SYNC_QUEUE: Record<SyncType, QueueKey> = {
  orders: 'syncMarketplace', listing_status: 'syncMarketplace', catalog_import: 'syncMarketplace', listings: 'syncMarketplace', returns: 'syncMarketplace', tracking: 'syncMarketplace', full: 'syncMarketplace',
  order_status: 'marketplacePush', inventory: 'marketplacePush', prices: 'marketplacePush', listing_publish: 'marketplacePush',
};
export const syncJobName = (type: SyncType): string => `sync.${type}`;

export interface CreateJobInput {
  vendorId: string;
  accountId: string | null;
  type: SyncType;
  trigger?: SyncTrigger;
  /** same key = same job (duplicate protection). Include a time bucket for recurring work. */
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  requestedBy?: string | null;
  maxAttempts?: number;
  /** reuse a not-yet-started job of the same (account, type) instead of creating another (many triggers -> one run) */
  coalesce?: boolean;
}

/** Creates (or finds) the job row inside the caller's transaction. Dispatch AFTER the transaction commits. */
export async function createSyncJob(tx: Tx, c: Pick<Container, 'config'>, input: CreateJobInput): Promise<{ job: SyncJobRow; created: boolean }> {
  if (input.coalesce && input.accountId) {
    const [open] = await tx
      .select()
      .from(S)
      .where(and(eq(S.vendorId, input.vendorId), eq(S.marketplaceAccountId, input.accountId), eq(S.type, input.type), inArray(S.status, ['queued', 'retrying'])))
      .orderBy(S.createdAt)
      .limit(1);
    if (open) return { job: open, created: false };
  }
  const [row] = await tx
    .insert(S)
    .values({
      vendorId: input.vendorId, marketplaceAccountId: input.accountId, type: input.type, status: 'queued', trigger: input.trigger ?? 'system', idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {}, requestedBy: input.requestedBy ?? null, maxAttempts: input.maxAttempts ?? c.config.SYNC_MAX_ATTEMPTS,
    })
    .onConflictDoNothing({ target: [S.vendorId, S.idempotencyKey] })
    .returning();
  if (row) return { job: row, created: true };
  const [existing] = await tx.select().from(S).where(and(eq(S.vendorId, input.vendorId), eq(S.idempotencyKey, input.idempotencyKey)));
  return { job: existing!, created: false };
}

/** Puts the job on its queue. `idempotencyKey` (BullMQ jobId) is unique per (job, manual retry, attempt) and has no ':'. */
export async function dispatchSyncJob(c: Container, job: SyncJobRow, opts: { delayMs?: number } = {}): Promise<void> {
  const manual = (job.stats as Record<string, number>).manualRetries ?? 0;
  await c.queues.enqueue(
    SYNC_QUEUE[job.type as SyncType],
    syncJobName(job.type as SyncType),
    { vendorId: job.vendorId, correlationId: getContext().correlationId ?? job.id, idempotencyKey: `${job.id}-r${manual}-a${job.attempts}`, data: { jobId: job.id } },
    opts.delayMs ? { delay: opts.delayMs } : {},
  );
}

/** Convenience: create + dispatch in one call (own short transaction). Use createSyncJob inside a larger transaction instead. */
export async function enqueueSyncJob(c: Container, input: CreateJobInput): Promise<{ job: SyncJobRow; created: boolean }> {
  const res = await withVendor(c.database.db, input.vendorId, (tx) => createSyncJob(tx, c, input));
  if (res.created) await dispatchSyncJob(c, res.job);
  return res;
}

// ------------------------------------------------------------------------------------------------
// logs
// ------------------------------------------------------------------------------------------------
export type LogLevel = (typeof schema.LOG_LEVELS)[number];

export async function appendSyncLog(c: Pick<Container, 'database'>, vendorId: string, jobId: string, level: LogLevel, message: string, context: Record<string, unknown> = {}): Promise<void> {
  await withVendor(c.database.db, vendorId, (tx) => tx.insert(schema.syncLogs).values({ vendorId, syncJobId: jobId, level, message: message.slice(0, 1000), context }));
}

// ------------------------------------------------------------------------------------------------
// execution
// ------------------------------------------------------------------------------------------------
export interface SyncContext {
  c: Container;
  host: ConnectorHost;
  job: SyncJobRow;
  vendorId: string;
  accountId: string | null;
  payload: Record<string, unknown>;
  /** 1-based attempt number */
  attempt: number;
  isLastAttempt: boolean;
  log(level: LogLevel, message: string, context?: Record<string, unknown>): Promise<void>;
  /** absolute progress numbers */
  progress(p: Partial<{ total: number; done: number; failed: number }>): Promise<void>;
  /** records a per-item failure (job ends `partially_failed`, the batch is not aborted) */
  addFailure(f: { ref: string; code?: string; message: string }): void;
  /** persist a resumable position; a retried attempt starts from `job.cursor` */
  setCursor(cursor: Record<string, unknown> | null): Promise<void>;
}
export type SyncRunner = (ctx: SyncContext) => Promise<{ stats?: Record<string, number> } | void>;

export interface Classified { retryable: boolean; code: string; message: string; retryAfterMs?: number }

/** Decides whether a failure is worth another attempt. Auth/permission/validation problems are never retried blindly. */
export function classifyFailure(e: unknown): Classified {
  if (e instanceof AppError) {
    const kind = (e.details as { kind?: string } | undefined)?.kind;
    const retryAfterSec = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    const retryAfterMs = retryAfterSec ? retryAfterSec * 1000 : undefined;
    if (e.code === 'RATE_LIMITED') return { retryable: true, code: 'RATE_LIMITED', message: e.message, retryAfterMs };
    if (e.code === 'UPSTREAM_ERROR') {
      if (kind === 'auth') return { retryable: false, code: 'AUTH_FAILED', message: e.message };
      if (kind === 'permanent' || kind === 'unsupported') return { retryable: false, code: String((e.details as { code?: string }).code ?? 'REJECTED'), message: e.message };
      return { retryable: true, code: String((e.details as { code?: string } | undefined)?.code ?? 'UPSTREAM_ERROR'), message: e.message, retryAfterMs };
    }
    if (e.code === 'SERVICE_UNAVAILABLE') return { retryable: true, code: e.code, message: e.message };
    return { retryable: false, code: e.code, message: e.message };
  }
  return { retryable: true, code: 'INTERNAL', message: (e as Error)?.message?.slice(0, 500) ?? 'Unexpected error' };
}

/** Exponential backoff with jitter, bounded; a marketplace Retry-After raises the floor. */
export function backoffMs(c: Pick<Container, 'config'>, attempt: number, retryAfterMs = 0, random: () => number = Math.random): number {
  const base = c.config.SYNC_BACKOFF_BASE_MS;
  const raw = Math.min(c.config.SYNC_BACKOFF_MAX_MS, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(raw * (0.75 + random() * 0.25));
  return Math.min(c.config.SYNC_BACKOFF_MAX_MS, Math.max(jittered, retryAfterMs));
}

const MAX_FAILURES_KEPT = 50;

export async function executeSyncJob(c: Container, env: JobEnvelope, runner: SyncRunner): Promise<void> {
  const jobId = (env.data as { jobId?: string } | null)?.jobId;
  const vendorId = env.vendorId;
  if (!jobId || !vendorId) throw new AppError('BAD_REQUEST', 'sync job envelope needs vendorId and data.jobId');
  const db = c.database.db;

  // claim: only a queued/retrying job can start (a duplicate or late delivery finds it running/finished and stops)
  const job = await withVendor(db, vendorId, async (tx) => {
    const [row] = await tx
      .update(S)
      .set({ status: 'running', startedAt: new Date(), finishedAt: null, nextRetryAt: null, attempts: sql`${S.attempts} + 1` })
      .where(and(eq(S.id, jobId), eq(S.vendorId, vendorId), inArray(S.status, ['queued', 'retrying'])))
      .returning();
    return row ?? null;
  });
  if (!job) {
    c.logger.debug({ jobId }, 'sync job not claimable (already running or finished)');
    return;
  }

  const failures: Array<{ ref: string; code?: string; message: string }> = [];
  let failedCount = 0;
  const attempt = job.attempts;
  const ctx: SyncContext = {
    c, host: new ConnectorHost(c), job, vendorId, accountId: job.marketplaceAccountId, payload: (job.payload ?? {}) as Record<string, unknown>,
    attempt, isLastAttempt: attempt >= job.maxAttempts,
    log: (level, message, context) => appendSyncLog(c, vendorId, job.id, level, message, context),
    progress: async (p) => {
      await withVendor(db, vendorId, async (tx) => {
        const [cur] = await tx.select({ progress: S.progress }).from(S).where(eq(S.id, job.id));
        await tx.update(S).set({ progress: { total: p.total ?? cur?.progress.total ?? 0, done: p.done ?? cur?.progress.done ?? 0, failed: p.failed ?? cur?.progress.failed ?? 0 } }).where(eq(S.id, job.id));
      });
    },
    addFailure: (f) => { failedCount++; if (failures.length < MAX_FAILURES_KEPT) failures.push({ ref: f.ref, code: f.code, message: f.message.slice(0, 300) }); },
    setCursor: async (cursor) => { await withVendor(db, vendorId, (tx) => tx.update(S).set({ cursor }).where(eq(S.id, job.id))); },
  };
  await ctx.log('info', `attempt ${attempt}/${job.maxAttempts} started`, { type: job.type });

  try {
    const result = await runner(ctx);
    const status = failedCount > 0 ? 'partially_failed' : 'succeeded';
    await withVendor(db, vendorId, async (tx) => {
      await tx
        .update(S)
        .set({
          status, finishedAt: new Date(), error: null, nextRetryAt: null, failureDetails: failures,
          stats: sql`${S.stats} || ${JSON.stringify(result?.stats ?? {})}::jsonb`,
        })
        .where(eq(S.id, job.id));
      if (job.marketplaceAccountId) await tx.update(schema.marketplaceAccounts).set({ lastSyncedAt: new Date() }).where(eq(schema.marketplaceAccounts.id, job.marketplaceAccountId));
      await writeOutboxEvent(tx, { type: 'sync.completed', vendorId, aggregateType: 'sync_job', aggregateId: job.id, payload: { type: job.type, status, accountId: job.marketplaceAccountId, stats: result?.stats ?? {} } });
    });
    await ctx.log(failedCount > 0 ? 'warn' : 'info', failedCount > 0 ? `finished with ${failedCount} item failure(s)` : 'finished', { stats: result?.stats ?? {} });
  } catch (e) {
    const f = classifyFailure(e);
    const error = { code: f.code, message: f.message };
    if (f.retryable && attempt < job.maxAttempts) {
      const delay = backoffMs(c, attempt, f.retryAfterMs);
      const next = await withVendor(db, vendorId, async (tx) => {
        const [row] = await tx.update(S).set({ status: 'retrying', error, nextRetryAt: new Date(Date.now() + delay), failureDetails: failures }).where(eq(S.id, job.id)).returning();
        return row!;
      });
      await ctx.log('warn', `attempt ${attempt} failed: ${f.message}; retrying in ${Math.round(delay / 1000)}s`, { code: f.code, delayMs: delay });
      await dispatchSyncJob(c, next, { delayMs: delay });
      return;
    }
    const deadLetter = f.retryable; // retryable but out of attempts
    await withVendor(db, vendorId, async (tx) => {
      await tx
        .update(S)
        .set({ status: deadLetter ? 'dead_lettered' : 'failed', finishedAt: new Date(), error, nextRetryAt: null, deadLetteredAt: deadLetter ? new Date() : null, failureDetails: failures })
        .where(eq(S.id, job.id));
      await writeOutboxEvent(tx, { type: deadLetter ? 'sync.dead_lettered' : 'sync.failed', vendorId, aggregateType: 'sync_job', aggregateId: job.id, payload: { type: job.type, accountId: job.marketplaceAccountId, error, attempts: attempt } });
      await writeAudit(tx, { vendorId, actorType: 'system', actorId: 'sync-engine', action: deadLetter ? 'sync.job_dead_lettered' : 'sync.job_failed', resourceType: 'sync_job', resourceId: job.id, metadata: { type: job.type, error } });
    });
    await ctx.log('error', deadLetter ? `dead-lettered after ${attempt} attempts: ${f.message}` : `failed: ${f.message}`, { code: f.code });
    c.logger.warn({ jobId: job.id, type: job.type, code: f.code, deadLetter }, 'sync job did not succeed');
  }
}

// ------------------------------------------------------------------------------------------------
// operator actions
// ------------------------------------------------------------------------------------------------
export async function getSyncJobRow(tx: Tx, vendorId: string, id: string): Promise<SyncJobRow> {
  const [row] = await tx.select().from(S).where(and(eq(S.id, id), eq(S.vendorId, vendorId)));
  if (!row) throw new AppError('NOT_FOUND', 'Sync job not found', { details: { resource: 'sync_job', id } });
  return row;
}

/** failed / dead-lettered / partially failed / cancelled -> queued with a fresh attempt budget. History is kept. */
export async function resetForManualRetry(tx: Tx, vendorId: string, id: string, requestedBy: string | null): Promise<SyncJobRow> {
  const job = await getSyncJobRow(tx, vendorId, id);
  if (!['failed', 'dead_lettered', 'partially_failed', 'cancelled'].includes(job.status)) {
    throw new AppError('INVALID_STATE', `A ${job.status} job cannot be retried`, { details: { status: job.status } });
  }
  const manual = ((job.stats as Record<string, number>).manualRetries ?? 0) + 1;
  const [row] = await tx
    .update(S)
    .set({
      status: 'queued', attempts: 0, error: null, nextRetryAt: null, deadLetteredAt: null, finishedAt: null, trigger: 'retry', requestedBy,
      stats: sql`${S.stats} || ${JSON.stringify({ manualRetries: manual })}::jsonb`,
    })
    .where(eq(S.id, id))
    .returning();
  await tx.insert(schema.syncLogs).values({ vendorId, syncJobId: id, level: 'info', message: 'manual retry requested', context: { requestedBy, previousStatus: job.status } });
  return row!;
}

export async function cancelSyncJob(tx: Tx, vendorId: string, id: string): Promise<SyncJobRow> {
  const job = await getSyncJobRow(tx, vendorId, id);
  if (!['queued', 'retrying'].includes(job.status)) throw new AppError('INVALID_STATE', `A ${job.status} job cannot be cancelled`, { details: { status: job.status } });
  const [row] = await tx.update(S).set({ status: 'cancelled', finishedAt: new Date(), nextRetryAt: null }).where(eq(S.id, id)).returning();
  await tx.insert(schema.syncLogs).values({ vendorId, syncJobId: id, level: 'info', message: 'cancelled by an operator', context: {} });
  return row!;
}

export async function latestJobs(tx: Tx, vendorId: string, accountId: string, limit = 5): Promise<SyncJobRow[]> {
  return tx.select().from(S).where(and(eq(S.vendorId, vendorId), eq(S.marketplaceAccountId, accountId))).orderBy(desc(S.createdAt)).limit(limit);
}
