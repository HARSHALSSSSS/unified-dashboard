import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { Errors } from '@oms/shared';
import { IdParamSchema, IsoDate, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { audit, ok, paginated, requireVendor, strictRateLimit, vendorTx } from '@oms/module-kit';
import { getAccountRow } from '@oms/mod-marketplace-accounts';
import { getEvent, listEvents, receiveWebhook, retryEvent, rotateSecret, toEventDto, webhookUrl } from './service';

const EventSchema = z.object({
  id: z.string(), marketplaceAccountId: z.string(), marketplace: z.string(), eventType: z.string(),
  status: z.enum(schema.WEBHOOK_STATUSES).describe('received -> processing -> processed | failed (will retry) | dead_lettered (retry it manually); ignored = authentic but not actionable; rejected = bad signature'),
  externalId: z.string().nullable(), attempts: z.number().int(), deliveries: z.number().int().describe('How many times the marketplace delivered this event (> 1 = duplicates were dropped)'),
  lastError: z.string().nullable(), receivedAt: IsoDate, processedAt: IsoDate.nullable(), nextRetryAt: IsoDate.nullable(),
}).meta({ id: 'WebhookEvent' });

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const TAGS = ['Webhooks'];

  // Signature verification needs the EXACT bytes the marketplace sent: keep the raw body next to the parsed JSON.
  // (Encapsulated to this plugin; every other route keeps Fastify's default JSON parser.)
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try { done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {}); }
    catch { const err = new Error('Request body is not valid JSON') as Error & { statusCode: number }; err.statusCode = 400; done(err, undefined); }
  });
  const limiter = strictRateLimit(app, 1200); // per client IP; a marketplace's notification bridge is a handful of IPs

  r.post('/webhooks/:marketplace/:accountId', {
    config: { access: 'public' },
    preHandler: limiter,
    schema: {
      tags: TAGS,
      summary: 'Receive a marketplace notification (called by the marketplace)',
      description: 'Public endpoint, authenticated by a per-account HMAC signature over the RAW body (see GET /marketplace-accounts/{id}/webhook-config for the header). Valid events are stored once (duplicate deliveries are acknowledged and dropped) and processed asynchronously with retries; the response only confirms receipt.',
      params: z.object({ marketplace: z.string().min(2).max(40), accountId: z.uuid() }),
      response: { 200: successEnvelope(z.object({ received: z.literal(true), duplicate: z.boolean(), ignored: z.boolean(), eventId: z.string().nullable() })) },
    },
  }, async (req) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    return ok(req, await receiveWebhook(c, { marketplace: req.params.marketplace, accountId: req.params.accountId, headers, rawBody: raw, body: req.body }));
  });

  r.get('/webhooks/events', {
    config: { access: { permission: 'webhooks:read' } },
    schema: {
      tags: TAGS,
      summary: 'Received webhook events',
      querystring: PaginationQuerySchema.extend({ 'filter[accountId]': z.uuid().optional(), 'filter[status]': z.enum(schema.WEBHOOK_STATUSES).optional(), 'filter[eventType]': z.string().max(60).optional() }),
      response: { 200: paginatedEnvelope(EventSchema) },
    },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => listEvents(tx, vendorId, { limit: q.limit, cursor: q.cursor, accountId: q['filter[accountId]'], status: q['filter[status]'], eventType: q['filter[eventType]'] }));
    return paginated(req, page.items.map((e) => toEventDto(e)), { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/webhooks/events/:id', {
    config: { access: { permission: 'webhooks:read' } },
    schema: { tags: TAGS, summary: 'One webhook event (with its payload)', params: IdParamSchema, response: { 200: successEnvelope(EventSchema.extend({ payload: z.unknown() })) } },
  }, async (req) => ok(req, toEventDto(await vendorTx(req, (tx, vendorId) => getEvent(tx, vendorId, req.params.id)), true) as never));

  r.post('/webhooks/events/:id/retry', {
    config: { access: { permission: 'webhooks:write' } },
    schema: { tags: TAGS, summary: 'Process a failed / dead-lettered event again', description: 'Asynchronous (202). Processing is idempotent: an order that was already imported is not duplicated.', params: IdParamSchema, response: { 202: successEnvelope(EventSchema) } },
  }, async (req, reply) => {
    const vendorId = requireVendor(req);
    const ev = await retryEvent(c, vendorId, req.params.id);
    await vendorTx(req, (tx) => audit(tx, req, { action: 'webhook.retry', resourceType: 'webhook_event', resourceId: ev.id }));
    reply.code(202);
    return ok(req, toEventDto(ev));
  });

  const ConfigSchema = z.object({
    callbackUrl: z.string(), supported: z.boolean().describe('Does this marketplace push notifications?'), configured: z.boolean().describe('Has a signing secret been generated?'), secretRotatedAt: IsoDate.nullable(),
    signature: z.object({ header: z.string(), algorithm: z.string(), description: z.string() }).nullable(),
  }).meta({ id: 'WebhookConfig' });

  r.get('/marketplace-accounts/:id/webhook-config', {
    config: { access: { permission: 'webhooks:read' } },
    schema: { tags: TAGS, summary: 'Webhook callback URL and signing scheme for an account', description: 'Register `callbackUrl` with the marketplace and sign deliveries with the secret from POST .../webhook-secret.', params: IdParamSchema, response: { 200: successEnvelope(ConfigSchema) } },
  }, async (req) => {
    const acc = await vendorTx(req, (tx, vendorId) => getAccountRow(tx, vendorId, req.params.id));
    const conn = c.connectors.get(acc.marketplace);
    return ok(req, {
      callbackUrl: webhookUrl(c, acc.marketplace, acc.id), supported: Boolean(conn.verifyWebhook && conn.parseWebhook), configured: acc.webhookSecretCiphertext !== null,
      secretRotatedAt: acc.webhookSecretRotatedAt ? acc.webhookSecretRotatedAt.toISOString() : null,
      signature: conn.webhook ? { header: conn.webhook.signatureHeader, algorithm: conn.webhook.algorithm, description: conn.webhook.description } : null,
    });
  });

  r.post('/marketplace-accounts/:id/webhook-secret', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Generate or rotate the webhook signing secret',
      description: 'The secret is returned ONCE and stored encrypted; it cannot be read back. Rotating invalidates the previous secret immediately: update the marketplace configuration first (or accept a short gap).',
      params: IdParamSchema,
      response: { 200: successEnvelope(ConfigSchema.extend({ secret: z.string().describe('Shown once. Store it in the marketplace configuration now.') })) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const acc = await vendorTx(req, (tx) => getAccountRow(tx, vendorId, req.params.id));
    const conn = c.connectors.get(acc.marketplace);
    if (!conn.verifyWebhook || !conn.parseWebhook) throw Errors.conflict(`${conn.displayName} does not push notifications; orders are polled`, { rule: 'webhooks_unsupported' });
    const { secret, rotatedAt } = await rotateSecret(c, vendorId, acc.id);
    await vendorTx(req, (tx) => audit(tx, req, { action: 'marketplace_account.webhook_secret_rotated', resourceType: 'marketplace_account', resourceId: acc.id }));
    return ok(req, {
      callbackUrl: webhookUrl(c, acc.marketplace, acc.id), supported: true, configured: true, secretRotatedAt: rotatedAt.toISOString(), secret,
      signature: conn.webhook ? { header: conn.webhook.signatureHeader, algorithm: conn.webhook.algorithm, description: conn.webhook.description } : null,
    });
  });
};
