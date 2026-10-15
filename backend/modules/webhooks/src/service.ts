import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, keyset, schema, sql, withSystem, withVendor, type Tx } from '@oms/database';
import { AppError, Errors, newId } from '@oms/shared';
import { applyStatusReport, getListingRow } from '@oms/mod-listings';
import { importOrderForAccount, ingestOrderById } from '@oms/mod-orders';
import { readWebhookSecret, saveWebhookSecret } from '@oms/mod-marketplace-accounts';
import { backoffMs, classifyFailure } from '@oms/mod-sync';
import { effects, systemOpCtx, type Container, type OpCtx } from '@oms/module-kit';

const W = schema.webhookEvents;
const A = schema.marketplaceAccounts;
export type EventRow = typeof W.$inferSelect;

export const PROCESS_JOB = 'webhooks.process';

// ------------------------------------------------------------------------------------------------
// receipt: verify -> persist (idempotent) -> ack. Processing is asynchronous.
// ------------------------------------------------------------------------------------------------
export interface Received { received: true; duplicate: boolean; ignored: boolean; eventId: string | null }

const REJECT_CAP_PER_HOUR = 200;

export async function receiveWebhook(c: Container, input: { marketplace: string; accountId: string; headers: Record<string, string | undefined>; rawBody: Buffer; body: unknown }): Promise<Received> {
  const db = c.database.db;
  const account = await withSystem(db, async (tx) => (await tx.select().from(A).where(and(eq(A.id, input.accountId), eq(A.marketplace, input.marketplace))))[0]);
  // An unknown / revoked endpoint must look EXACTLY like a known one with a bad signature (same status, same body, similar work),
  // otherwise the URL is an oracle for "does this account exist".
  const connector = account ? c.connectors.get(account.marketplace) : null;
  if (!account || account.status === 'revoked' || !connector?.verifyWebhook || !connector.parseWebhook) {
    connector?.verifyWebhook?.({ headers: input.headers, rawBody: input.rawBody, secret: 'dummy-secret-for-equal-work' });
    throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature');
  }

  const secret = readWebhookSecret(c, account);
  const verified = secret !== null && connector.verifyWebhook({ headers: input.headers, rawBody: input.rawBody, secret });
  if (!verified) {
    await recordRejection(c, account, secret === null ? 'no_secret_configured' : 'bad_signature');
    throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature');
  }

  const parsed = connector.parseWebhook({ headers: input.headers, body: input.body });
  const vendorId = account.vendorId;
  if (!parsed) {
    // authentic but not something we act on (an event type we do not handle): keep a record, de-duplicated by content
    const key = `ignored-${createHash('sha256').update(input.rawBody).digest('hex').slice(0, 40)}`;
    const row = await withVendor(db, vendorId, async (tx) => (await upsertEvent(tx, vendorId, account.id, account.marketplace, { eventType: 'unknown', key, externalId: null, payload: { raw: input.body }, status: 'ignored' }))[0]!);
    return { received: true, duplicate: row.deliveries > 1, ignored: true, eventId: row.id };
  }

  const row = await withVendor(db, vendorId, async (tx) => {
    const r = (await upsertEvent(tx, vendorId, account.id, account.marketplace, { eventType: parsed.eventType, key: parsed.idempotencyKey, externalId: parsed.externalId, payload: { raw: input.body }, status: 'received' }))[0]!;
    if (r.deliveries === 1) await effects(tx, systemOpCtx(c, vendorId, 'webhook-receiver', 'webhook')).event({ type: 'webhook.received', aggregateType: 'webhook_event', aggregateId: r.id, payload: { marketplace: account.marketplace, eventType: parsed.eventType } });
    return r;
  });
  const duplicate = row.deliveries > 1;
  if (!duplicate) {
    // best effort: if the queue is down the event is already durable and the sweeper will pick it up
    await enqueueProcessing(c, vendorId, row.id, 0).catch((err) => c.logger.warn({ err: (err as Error).message, eventId: row.id }, 'could not enqueue webhook processing; sweeper will retry'));
  }
  return { received: true, duplicate, ignored: false, eventId: row.id };
}

async function upsertEvent(tx: Tx, vendorId: string, accountId: string, marketplace: string, e: { eventType: string; key: string; externalId: string | null; payload: unknown; status: 'received' | 'ignored' }) {
  return tx
    .insert(W)
    .values({ vendorId, marketplaceAccountId: accountId, marketplace, eventType: e.eventType, idempotencyKey: e.key, externalId: e.externalId, status: e.status, payload: e.payload as never, processedAt: e.status === 'ignored' ? new Date() : null })
    // a re-delivery only bumps the counter: the original row (and its processing state) is never touched
    .onConflictDoUpdate({ target: [W.marketplaceAccountId, W.idempotencyKey], set: { deliveries: sql`${W.deliveries} + 1` } })
    .returning();
}

/** bad signatures are logged as rows WITHOUT payload (unauthenticated bytes are never stored), capped per account per hour */
async function recordRejection(c: Container, account: typeof A.$inferSelect, reason: string): Promise<void> {
  await withVendor(c.database.db, account.vendorId, async (tx) => {
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(W).where(and(eq(W.marketplaceAccountId, account.id), eq(W.status, 'rejected'), gte(W.receivedAt, new Date(Date.now() - 3600_000))));
    if (n >= REJECT_CAP_PER_HOUR) return;
    await tx.insert(W).values({ vendorId: account.vendorId, marketplaceAccountId: account.id, marketplace: account.marketplace, eventType: 'unknown', idempotencyKey: `rejected-${newId()}`, status: 'rejected', lastError: reason, processedAt: new Date() });
    await effects(tx, systemOpCtx(c, account.vendorId, 'webhook-receiver', 'webhook')).event({ type: 'webhook.rejected', aggregateType: 'marketplace_account', aggregateId: account.id, payload: { reason } });
  });
}

export async function enqueueProcessing(c: Container, vendorId: string, eventId: string, attempt: number, delayMs = 0): Promise<void> {
  await c.queues.enqueue('webhooksInbound', PROCESS_JOB, { vendorId, correlationId: eventId, idempotencyKey: `${eventId}-a${attempt}`, data: { eventId } }, delayMs ? { delay: delayMs } : {});
}

// ------------------------------------------------------------------------------------------------
// processing (worker)
// ------------------------------------------------------------------------------------------------
export async function processWebhookEvent(c: Container, vendorId: string, eventId: string): Promise<void> {
  const db = c.database.db;
  const ev = await withVendor(db, vendorId, async (tx) =>
    (await tx.update(W).set({ status: 'processing', attempts: sql`${W.attempts} + 1`, nextRetryAt: null }).where(and(eq(W.id, eventId), eq(W.vendorId, vendorId), inArray(W.status, ['received', 'failed']))).returning())[0],
  );
  if (!ev) return; // already processed / being processed: a duplicate delivery of the queue message is harmless

  const ctx = systemOpCtx(c, vendorId, 'webhook-processor', 'webhook');
  try {
    const outcome = await handleEvent(c, ctx, ev);
    await withVendor(db, vendorId, (tx) => tx.update(W).set({ status: outcome === 'ignored' ? 'ignored' : 'processed', processedAt: new Date(), lastError: null }).where(eq(W.id, ev.id)));
  } catch (e) {
    const f = classifyFailure(e);
    const max = c.config.WEBHOOK_MAX_ATTEMPTS;
    const willRetry = f.retryable && ev.attempts < max;
    const delay = backoffMs(c, ev.attempts, f.retryAfterMs);
    await withVendor(db, vendorId, async (tx) => {
      await tx.update(W).set({ status: willRetry ? 'failed' : 'dead_lettered', lastError: `${f.code}: ${f.message}`.slice(0, 500), nextRetryAt: willRetry ? new Date(Date.now() + delay) : null, ...(willRetry ? {} : { processedAt: new Date() }) }).where(eq(W.id, ev.id));
      if (!willRetry) await effects(tx, ctx).event({ type: 'webhook.dead_lettered', aggregateType: 'webhook_event', aggregateId: ev.id, payload: { eventType: ev.eventType, error: f.code, attempts: ev.attempts } });
    });
    if (willRetry) await enqueueProcessing(c, vendorId, ev.id, ev.attempts, delay);
    else c.logger.warn({ eventId: ev.id, code: f.code }, 'webhook event dead-lettered');
  }
}

async function handleEvent(c: Container, ctx: OpCtx, ev: EventRow): Promise<'done' | 'ignored'> {
  const { vendorId } = ctx;
  const account = await withVendor(c.database.db, vendorId, async (tx) => (await tx.select().from(A).where(and(eq(A.id, ev.marketplaceAccountId), eq(A.vendorId, vendorId))))[0]);
  if (!account) return 'ignored';
  const connector = c.connectors.get(account.marketplace);
  const body = (ev.payload as { raw?: unknown } | null)?.raw;
  const parsed = connector.parseWebhook?.({ headers: {}, body });
  if (!parsed) return 'ignored';

  switch (parsed.eventType) {
    case 'order.created':
    case 'order.updated':
    case 'order.cancelled': {
      if (parsed.order) { await importOrderForAccount(ctx, account, parsed.order); return 'done'; }
      if (!parsed.externalOrderId) return 'ignored';
      // the notification carries only the id: ask the marketplace for the order (the import is idempotent)
      const res = await ingestOrderById(ctx, account.id, parsed.externalOrderId);
      if (!res) throw new AppError('NOT_FOUND', `The marketplace has no order ${parsed.externalOrderId} (yet)`, { details: { resource: 'order', retryable: true } });
      return 'done';
    }
    case 'listing.status_changed': {
      if (!parsed.listing) return 'ignored';
      const report = parsed.listing;
      return withVendor(c.database.db, vendorId, async (tx) => {
        const L = schema.marketplaceListings;
        const [row] = await tx.select({ id: L.id }).from(L).where(and(eq(L.vendorId, vendorId), eq(L.marketplaceAccountId, account.id), eq(L.externalSku, report.externalSku)));
        if (!row) return 'ignored' as const; // a listing we do not track
        await applyStatusReport(tx, ctx, await getListingRow(tx, vendorId, row.id), report, 'webhook');
        return 'done' as const;
      });
    }
    default:
      return 'ignored';
  }
}

// ------------------------------------------------------------------------------------------------
// operator actions + reads
// ------------------------------------------------------------------------------------------------
export const toEventDto = (e: EventRow, withPayload = false) => ({
  id: e.id, marketplaceAccountId: e.marketplaceAccountId, marketplace: e.marketplace, eventType: e.eventType, status: e.status as (typeof schema.WEBHOOK_STATUSES)[number], externalId: e.externalId,
  attempts: e.attempts, deliveries: e.deliveries, lastError: e.lastError, receivedAt: e.receivedAt.toISOString(), processedAt: e.processedAt ? e.processedAt.toISOString() : null, nextRetryAt: e.nextRetryAt ? e.nextRetryAt.toISOString() : null,
  ...(withPayload ? { payload: e.payload ?? null } : {}),
});

export async function getEvent(tx: Tx, vendorId: string, id: string): Promise<EventRow> {
  const [e] = await tx.select().from(W).where(and(eq(W.id, id), eq(W.vendorId, vendorId)));
  if (!e) throw Errors.notFound('Webhook event', id);
  return e;
}

export async function listEvents(tx: Tx, vendorId: string, f: { limit: number; cursor?: string; accountId?: string; status?: string; eventType?: string }) {
  const ks = keyset<EventRow>({ sorts: { receivedAt: { column: W.receivedAt, kind: 'timestamp' } }, idColumn: W.id, defaultSort: { field: 'receivedAt', direction: 'desc' }, cursor: f.cursor, limit: f.limit });
  const rows = await tx.select().from(W).where(and(eq(W.vendorId, vendorId), f.accountId ? eq(W.marketplaceAccountId, f.accountId) : undefined, f.status ? eq(W.status, f.status) : undefined, f.eventType ? eq(W.eventType, f.eventType) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.receivedAt, id: r.id }));
}

/** failed / dead-lettered / ignored event -> processed again from scratch */
export async function retryEvent(c: Container, vendorId: string, id: string): Promise<EventRow> {
  const next = await withVendor(c.database.db, vendorId, async (tx) => {
    const e = await getEvent(tx, vendorId, id);
    if (!['failed', 'dead_lettered', 'ignored'].includes(e.status) || !e.payload) throw new AppError('INVALID_STATE', `A ${e.status} webhook event cannot be retried`, { details: { status: e.status } });
    return (await tx.update(W).set({ status: 'received', attempts: 0, lastError: null, nextRetryAt: null, processedAt: null }).where(eq(W.id, id)).returning())[0]!;
  });
  await enqueueProcessing(c, vendorId, next.id, 1000 + Date.now() % 100000);
  return next;
}

// ------------------------------------------------------------------------------------------------
// secret + configuration
// ------------------------------------------------------------------------------------------------
export function webhookUrl(c: Container, marketplace: string, accountId: string): string {
  return `${c.config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/webhooks/${marketplace}/${accountId}`;
}

export async function rotateSecret(c: Container, vendorId: string, accountId: string) {
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const at = await withVendor(c.database.db, vendorId, (tx) => saveWebhookSecret(tx, c, vendorId, accountId, secret));
  return { secret, rotatedAt: at };
}

export const retentionSql = (days: number) => sql`${W.receivedAt} < now() - make_interval(days => ${days}) AND ${W.status} IN ('processed','ignored','rejected')`;

