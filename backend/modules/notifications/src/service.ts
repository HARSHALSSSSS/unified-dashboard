import { and, desc, eq, inArray, isNull, lt, schema, sql, withVendor, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { evaluateRules } from '@oms/mod-rules';
import { writeOutboxEvent } from '@oms/database';
import type { Container, DomainEventLike } from '@oms/module-kit';
import { DEFAULT_CHANNELS, SPECS, TYPE_CATALOG } from './catalog';

const N = schema.notifications;
const D = schema.notificationDeliveries;
const PREF = schema.notificationPreferences;
const DEV = schema.deviceTokens;
type Channel = (typeof schema.NOTIFICATION_CHANNELS)[number];
type Severity = (typeof schema.NOTIFICATION_SEVERITIES)[number];
export type NotificationRow = typeof N.$inferSelect;

export const toDto = (n: NotificationRow) => ({
  id: n.id, type: n.type, severity: n.severity as Severity, title: n.title, body: n.body, entityType: n.entityType, entityId: n.entityId, data: n.data, read: n.readAt !== null, readAt: n.readAt ? n.readAt.toISOString() : null, createdAt: n.createdAt.toISOString(),
});

/** Push is "ready": a provider (FCM / Expo) registers itself here; without one, push deliveries are recorded as skipped, not lost silently. */
export interface PushProvider { send(tokens: Array<{ token: string; platform: string }>, message: { title: string; body: string | null; data: Record<string, unknown> }): Promise<void> }
let pushProvider: PushProvider | null = null;
export const registerPushProvider = (p: PushProvider | null): void => { pushProvider = p; };

// ------------------------------------------------------------------------------------------------
// creating notifications from domain events
// ------------------------------------------------------------------------------------------------
interface Pending { notificationId: string; userId: string; channel: 'email' | 'push'; deliveryId: string }

/** One domain event -> one notification per active member of the vendor (respecting rules, preferences and de-duplication). */
export async function notifyEvent(c: Container, e: DomainEventLike): Promise<number> {
  const spec = SPECS[e.type];
  const vendorId = e.vendorId;
  if (!spec || !vendorId) return 0;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const pending: Pending[] = [];
  let created = 0;
  await withVendor(c.database.db, vendorId, async (tx) => {
    let severity = spec.severity;
    let forced: Channel[] | null = null;
    const title = spec.title(p);
    const matched = await evaluateRules(tx, vendorId, 'notification', { eventType: e.type, severity, marketplace: typeof p.marketplace === 'string' ? p.marketplace : null, title });
    for (const m of matched) {
      if (m.action.type === 'mute') return;
      if (m.action.type === 'escalate') severity = (m.action.params as { severity: Severity }).severity;
      if (m.action.type === 'channels' && !forced) forced = (m.action.params as { channels: Channel[] }).channels;
    }
    const users = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.vendorId, vendorId), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt)));
    if (users.length === 0) return;
    const prefs = await tx.select().from(PREF).where(and(eq(PREF.vendorId, vendorId), eq(PREF.type, spec.type)));
    const entity = spec.entity?.(e.aggregateId, p) ?? null;
    const dedupe = spec.dedupe?.(e.aggregateId, p) ?? null;
    for (const u of users) {
      const pref = prefs.find((x) => x.userId === u.id);
      const channels: Channel[] = forced ?? (pref ? ([pref.inApp && 'in_app', pref.email && 'email', pref.push && 'push'].filter(Boolean) as Channel[]) : DEFAULT_CHANNELS[severity]);
      if (channels.length === 0) continue;
      const [n] = await tx.insert(N).values({ vendorId, userId: u.id, type: spec.type, severity, title, body: spec.body?.(p) || null, entityType: entity?.type ?? null, entityId: entity?.id ?? null, data: { eventId: e.id, eventType: e.type }, dedupeKey: dedupe ?? `event:${e.id}` }).onConflictDoNothing().returning();
      if (!n) continue; // the same alert is still unread for this person
      created++;
      for (const ch of channels) {
        const [d] = await tx.insert(D).values({ vendorId, notificationId: n.id, channel: ch, status: ch === 'in_app' ? 'sent' : 'pending', sentAt: ch === 'in_app' ? new Date() : null }).returning();
        if (ch !== 'in_app') pending.push({ notificationId: n.id, userId: u.id, channel: ch, deliveryId: d!.id });
      }
      await writeOutboxEvent(tx, { type: 'notification.created', vendorId, aggregateType: 'notification', aggregateId: n.id, payload: { userId: u.id, type: spec.type, severity } });
    }
  });
  if (pending.length) await deliverPending(c, vendorId, pending);
  return created;
}

/** e-mail and push, AFTER the notification is stored (a provider hiccup never loses the in-app alert). */
async function deliverPending(c: Container, vendorId: string, pending: Pending[]): Promise<void> {
  for (const p of pending) {
    const row = await withVendor(c.database.db, vendorId, async (tx) => {
      const [n] = await tx.select().from(N).where(eq(N.id, p.notificationId));
      const [u] = await tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, p.userId));
      const tokens = p.channel === 'push' ? await tx.select({ token: DEV.token, platform: DEV.platform }).from(DEV).where(and(eq(DEV.vendorId, vendorId), eq(DEV.userId, p.userId))) : [];
      return { n, email: u?.email, tokens };
    });
    if (!row.n) continue;
    const set = (patch: Partial<typeof D.$inferInsert>) => withVendor(c.database.db, vendorId, (tx) => tx.update(D).set({ ...patch, attempts: sql`${D.attempts} + 1` }).where(eq(D.id, p.deliveryId)));
    try {
      if (p.channel === 'email') {
        if (!row.email) { await set({ status: 'skipped', error: 'no e-mail address' }); continue; }
        const link = `${c.config.APP_WEB_URL.replace(/\/$/, '')}/notifications/${row.n.id}`;
        await c.mailer.send({ kind: 'notification', to: row.email, subject: `[${row.n.severity}] ${row.n.title}`.replace(/[\r\n]+/g, ' ').slice(0, 200), text: `${row.n.title}\n${row.n.body ?? ''}\n\n${link}`, data: { token: row.n.id, link, type: row.n.type } });
        await set({ status: 'sent', sentAt: new Date(), error: null });
      } else if (row.tokens.length === 0) await set({ status: 'skipped', error: 'no registered device' });
      else if (!pushProvider) await set({ status: 'skipped', error: 'push provider not configured' });
      else { await pushProvider.send(row.tokens, { title: row.n.title, body: row.n.body, data: { notificationId: row.n.id, type: row.n.type } }); await set({ status: 'sent', sentAt: new Date(), error: null }); }
    } catch (err) {
      c.logger.warn({ notificationId: p.notificationId, channel: p.channel, err: (err as Error).message }, 'notification delivery failed');
      await set({ status: 'failed', error: (err as Error).message.slice(0, 300) });
    }
  }
}

// ------------------------------------------------------------------------------------------------
// the inbox
// ------------------------------------------------------------------------------------------------
export async function listMine(tx: Tx, vendorId: string, userId: string, q: { limit: number; before?: string; unread?: boolean; type?: string; severity?: string }) {
  const rows = await tx.select().from(N).where(and(eq(N.vendorId, vendorId), eq(N.userId, userId), q.unread ? isNull(N.readAt) : undefined, q.type ? eq(N.type, q.type) : undefined, q.severity ? eq(N.severity, q.severity) : undefined, q.before ? lt(N.createdAt, new Date(q.before)) : undefined)).orderBy(desc(N.createdAt), desc(N.id)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toDto), nextBefore: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null };
}
export async function unreadCount(tx: Tx, vendorId: string, userId: string): Promise<{ total: number; bySeverity: Record<string, number> }> {
  const rows = await tx.select({ s: N.severity, n: sql<number>`count(*)::int` }).from(N).where(and(eq(N.vendorId, vendorId), eq(N.userId, userId), isNull(N.readAt))).groupBy(N.severity);
  return { total: rows.reduce((a, r) => a + r.n, 0), bySeverity: Object.fromEntries(rows.map((r) => [r.s, r.n])) };
}
export async function markRead(tx: Tx, vendorId: string, userId: string, ids: string[] | 'all'): Promise<number> {
  const rows = await tx.update(N).set({ readAt: new Date() }).where(and(eq(N.vendorId, vendorId), eq(N.userId, userId), isNull(N.readAt), ids === 'all' ? undefined : inArray(N.id, ids))).returning({ id: N.id });
  return rows.length;
}
export async function getMine(tx: Tx, vendorId: string, userId: string, id: string) {
  const [n] = await tx.select().from(N).where(and(eq(N.id, id), eq(N.vendorId, vendorId), eq(N.userId, userId)));
  if (!n) throw Errors.notFound('Notification', id);
  const deliveries = await tx.select().from(D).where(and(eq(D.vendorId, vendorId), eq(D.notificationId, id)));
  return { ...toDto(n), deliveries: deliveries.map((d) => ({ channel: d.channel as Channel, status: d.status as (typeof schema.DELIVERY_STATUSES)[number], attempts: d.attempts, error: d.error, sentAt: d.sentAt ? d.sentAt.toISOString() : null })) };
}

// ------------------------------------------------------------------------------------------------
// preferences + devices
// ------------------------------------------------------------------------------------------------
export async function getPreferences(tx: Tx, vendorId: string, userId: string) {
  const prefs = await tx.select().from(PREF).where(and(eq(PREF.vendorId, vendorId), eq(PREF.userId, userId)));
  return TYPE_CATALOG.map((t) => {
    const p = prefs.find((x) => x.type === t.type);
    return { type: t.type, label: t.label, severity: t.severity, channels: { inApp: p ? p.inApp : t.defaultChannels.includes('in_app'), email: p ? p.email : t.defaultChannels.includes('email'), push: p ? p.push : t.defaultChannels.includes('push') }, isDefault: !p };
  });
}
export async function setPreference(tx: Tx, vendorId: string, userId: string, type: string, channels: { inApp?: boolean; email?: boolean; push?: boolean }) {
  const t = TYPE_CATALOG.find((x) => x.type === type);
  if (!t) throw new AppError('BAD_REQUEST', `Unknown notification type "${type}"`, { details: { types: TYPE_CATALOG.map((x) => x.type) } });
  const cur = (await getPreferences(tx, vendorId, userId)).find((x) => x.type === type)!.channels;
  const v = { inApp: channels.inApp ?? cur.inApp, email: channels.email ?? cur.email, push: channels.push ?? cur.push };
  await tx.insert(PREF).values({ vendorId, userId, type, ...v }).onConflictDoUpdate({ target: [PREF.vendorId, PREF.userId, PREF.type], set: v });
  return (await getPreferences(tx, vendorId, userId)).find((x) => x.type === type)!;
}
export async function registerDevice(tx: Tx, vendorId: string, userId: string, d: { token: string; platform: 'ios' | 'android' | 'web' | 'expo' }) {
  const [row] = await tx.insert(DEV).values({ vendorId, userId, token: d.token, platform: d.platform }).onConflictDoUpdate({ target: [DEV.vendorId, DEV.token], set: { vendorId, userId, platform: d.platform, lastSeenAt: new Date() } }).returning();
  return { id: row!.id, platform: row!.platform, lastSeenAt: row!.lastSeenAt.toISOString() };
}
export async function unregisterDevice(tx: Tx, vendorId: string, userId: string, token: string): Promise<void> {
  await tx.delete(DEV).where(and(eq(DEV.vendorId, vendorId), eq(DEV.userId, userId), eq(DEV.token, token)));
}

/**
 * A notification that does not come from a domain event (an automation rule says "tell the team"). Same rules as event alerts:
 * notification rules can mute / escalate it, de-duplicated while unread, channels by severity.
 */
export async function notifyVendor(c: Container, vendorId: string, input: { type?: string; severity?: Severity; title: string; body?: string | null; dedupeKey: string; entityType?: string | null; entityId?: string | null }): Promise<number> {
  const type = input.type ?? 'automation.notice';
  const pending: Pending[] = [];
  let created = 0;
  await withVendor(c.database.db, vendorId, async (tx) => {
    let severity: Severity = input.severity ?? 'info';
    const matched = await evaluateRules(tx, vendorId, 'notification', { eventType: type, severity, marketplace: null, title: input.title });
    for (const m of matched) {
      if (m.action.type === 'mute') return;
      if (m.action.type === 'escalate') severity = (m.action.params as { severity: Severity }).severity;
    }
    const users = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.vendorId, vendorId), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt)));
    for (const u of users) {
      const channels = DEFAULT_CHANNELS[severity];
      const [n] = await tx.insert(N).values({ vendorId, userId: u.id, type, severity, title: input.title.slice(0, 200), body: input.body ?? null, entityType: input.entityType ?? null, entityId: input.entityId ?? null, data: { source: 'automation' }, dedupeKey: input.dedupeKey }).onConflictDoNothing().returning();
      if (!n) continue;
      created++;
      for (const ch of channels) {
        const [d] = await tx.insert(D).values({ vendorId, notificationId: n.id, channel: ch, status: ch === 'in_app' ? 'sent' : 'pending', sentAt: ch === 'in_app' ? new Date() : null }).returning();
        if (ch !== 'in_app') pending.push({ notificationId: n.id, userId: u.id, channel: ch, deliveryId: d!.id });
      }
    }
  });
  if (pending.length) await deliverPending(c, vendorId, pending);
  return created;
}
