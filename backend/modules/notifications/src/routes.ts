import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { AppError } from '@oms/shared';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { ok, vendorTx } from '@oms/module-kit';
import { TYPE_CATALOG } from './catalog';
import { getMine, getPreferences, listMine, markRead, registerDevice, setPreference, unreadCount, unregisterDevice } from './service';

const NotificationSchema = z.object({
  id: z.string(), type: z.string(), severity: z.enum(schema.NOTIFICATION_SEVERITIES), title: z.string(), body: z.string().nullable(), entityType: z.string().nullable(), entityId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()), read: z.boolean(), readAt: IsoDate.nullable(), createdAt: IsoDate,
}).meta({ id: 'Notification' });
const Channels = z.object({ inApp: z.boolean(), email: z.boolean(), push: z.boolean() });

/** Notifications: the signed-in user's in-app inbox, per-type channel preferences and push devices. */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Notifications'];
  const me = (req: FastifyRequest): string => {
    const p = req.ctx.principal;
    if (!p || p.actorType !== 'user') throw new AppError('FORBIDDEN', 'Notifications belong to a signed-in user');
    return p.actorId;
  };

  r.get('/notifications/types', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Notification types', description: 'What can notify you (order alerts, low stock, failed syncs, listing rejections, returns, disconnected marketplaces, operational exceptions) and the default channels.', response: { 200: successEnvelope(z.array(z.object({ type: z.string(), label: z.string(), event: z.string(), severity: z.enum(schema.NOTIFICATION_SEVERITIES), defaultChannels: z.array(z.enum(schema.NOTIFICATION_CHANNELS)) }))) } },
  }, async (req) => ok(req, TYPE_CATALOG.map((t) => ({ ...t, defaultChannels: [...t.defaultChannels] }))));

  r.get('/notifications', {
    config: { access: { permission: 'notifications:read' } },
    schema: {
      tags: TAGS, summary: 'My notifications', description: 'Newest first. Page with `before` (the `nextBefore` of the previous page).',
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().optional(), 'filter[unread]': z.coerce.boolean().optional(), 'filter[type]': z.string().optional(), 'filter[severity]': z.enum(schema.NOTIFICATION_SEVERITIES).optional() }),
      response: { 200: successEnvelope(z.object({ items: z.array(NotificationSchema), nextBefore: z.string().nullable() })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listMine(tx, vendorId, me(req), { limit: req.query.limit, before: req.query.before, unread: req.query['filter[unread]'], type: req.query['filter[type]'], severity: req.query['filter[severity]'] }))));

  r.get('/notifications/unread-count', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Unread badge', response: { 200: successEnvelope(z.object({ total: z.number().int(), bySeverity: z.record(z.string(), z.number().int()) })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => unreadCount(tx, vendorId, me(req)))));

  r.post('/notifications/read', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Mark notifications read', description: 'Give `ids`, or `all: true`.', body: z.object({ ids: z.array(z.uuid()).max(200).optional(), all: z.boolean().optional() }).refine((b) => Boolean(b.all) !== Boolean(b.ids?.length), 'Provide ids or all'), response: { 200: successEnvelope(z.object({ marked: z.number().int() })) } },
  }, async (req) => ok(req, { marked: await vendorTx(req, (tx, vendorId) => markRead(tx, vendorId, me(req), req.body.all ? 'all' : req.body.ids!)) }));

  r.get('/notifications/preferences', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'My channel preferences per notification type', response: { 200: successEnvelope(z.array(z.object({ type: z.string(), label: z.string(), severity: z.enum(schema.NOTIFICATION_SEVERITIES), channels: Channels, isDefault: z.boolean() }))) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getPreferences(tx, vendorId, me(req)))));

  r.put('/notifications/preferences/:type', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Set my channels for one notification type', params: z.object({ type: z.string().min(2).max(80) }), body: z.object({ inApp: z.boolean().optional(), email: z.boolean().optional(), push: z.boolean().optional() }), response: { 200: successEnvelope(z.object({ type: z.string(), label: z.string(), severity: z.enum(schema.NOTIFICATION_SEVERITIES), channels: Channels, isDefault: z.boolean() })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => setPreference(tx, vendorId, me(req), req.params.type, req.body))));

  r.post('/notifications/devices', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Register a push device', description: 'Push-ready: devices register here; a push provider (FCM / Expo) plugs into delivery. Until one is configured, push deliveries are recorded as skipped.', body: z.object({ token: z.string().min(8).max(500), platform: z.enum(['ios', 'android', 'web', 'expo']) }), response: { 200: successEnvelope(z.object({ id: z.string(), platform: z.string(), lastSeenAt: IsoDate })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => registerDevice(tx, vendorId, me(req), req.body))));

  r.delete('/notifications/devices', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Unregister a push device', body: z.object({ token: z.string().min(8).max(500) }), response: { 200: successEnvelope(z.object({ removed: z.literal(true) })) } },
  }, async (req) => { await vendorTx(req, (tx, vendorId) => unregisterDevice(tx, vendorId, me(req), req.body.token)); return ok(req, { removed: true as const }); });

  r.get('/notifications/:id', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Get one notification with its delivery status per channel', params: IdParamSchema, response: { 200: successEnvelope(NotificationSchema.extend({ deliveries: z.array(z.object({ channel: z.enum(schema.NOTIFICATION_CHANNELS), status: z.enum(schema.DELIVERY_STATUSES), attempts: z.number().int(), error: z.string().nullable(), sentAt: IsoDate.nullable() })) })) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getMine(tx, vendorId, me(req), req.params.id))));

  r.post('/notifications/:id/read', {
    config: { access: { permission: 'notifications:read' } },
    schema: { tags: TAGS, summary: 'Mark one notification read', params: IdParamSchema, response: { 200: successEnvelope(NotificationSchema) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await markRead(tx, vendorId, me(req), [req.params.id]); return getMine(tx, vendorId, me(req), req.params.id); })));
};

