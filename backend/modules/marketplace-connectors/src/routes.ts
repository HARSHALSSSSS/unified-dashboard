import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertEmailVerified, audit, ok, requireVendor, vendorTx } from '@oms/module-kit';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { enabledCapabilities, requireCapability, type MarketplaceConnector } from '@oms/marketplace-core';
import { AppError } from '@oms/shared';
import { AccountSchema, getAccount, getAccountRow } from '@oms/mod-marketplace-accounts';
import { ConnectorHost, signState, verifyState } from './host';

const CapabilityMatrixSchema = z.record(z.string(), z.unknown()).meta({ id: 'CapabilityMatrix', description: 'Nested capability flags: auth, account, catalog, listings, inventory, pricing, orders, returns, shipping, limits' });

const ConnectorInfoSchema = z
  .object({
    code: z.string(),
    displayName: z.string(),
    implementation: z.enum(['planned', 'beta', 'ga']).describe('planned = declared but not callable yet'),
    authType: z.string(),
    redirectFlow: z.boolean(),
    refreshableTokens: z.boolean(),
    enabledCapabilities: z.array(z.string()).describe('Flat list, e.g. orders.fetch, inventory.push'),
    capabilities: CapabilityMatrixSchema,
  })
  .meta({ id: 'ConnectorInfo' });

const toInfo = (c: MarketplaceConnector) => ({
  code: c.code,
  displayName: c.displayName,
  implementation: c.implementation,
  authType: c.capabilities.auth.type,
  redirectFlow: Boolean(c.capabilities.auth.redirectFlow),
  refreshableTokens: c.capabilities.auth.refreshable,
  enabledCapabilities: enabledCapabilities(c),
  capabilities: c.capabilities as unknown as Record<string, unknown>,
});

const AuthorizeBody = z
  .object({
    code: z.string().min(1).max(2000).optional().describe('Authorization code returned by the marketplace (redirect flow)'),
    state: z.string().min(10).max(1000).optional().describe('The `state` from GET .../authorization-url (required with `code`)'),
    redirectUri: z.url().optional(),
    externalAccountId: z.string().min(1).max(100).optional().describe('Seller id returned with the authorization code, for marketplaces that send it separately (e.g. Amazon selling_partner_id)'),
    credentials: z.record(z.string(), z.unknown()).optional().describe('Direct credentials for marketplaces that use API keys (sent once, stored encrypted, never returned)'),
  })
  .refine((b) => (b.code !== undefined) !== (b.credentials !== undefined), { message: 'Provide either `code` (+ `state`) or `credentials`' })
  .refine((b) => b.code === undefined || b.state !== undefined, { message: '`state` is required with `code`', path: ['state'] });

const HealthSchema = z
  .object({ ok: z.boolean(), connectionStatus: z.string(), message: z.string().nullable(), checkedAt: IsoDate, tokenExpiresAt: IsoDate.nullable() })
  .meta({ id: 'ConnectionHealth' });

const RemoteProductSchema = z
  .object({
    externalListingId: z.string(), externalSku: z.string(), title: z.string(), brand: z.string().nullable(), priceMinor: z.number().nullable(), currency: z.string().nullable(),
    quantity: z.number().nullable(), imageUrls: z.array(z.string()), attributes: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'RemoteProduct' });

export const connectorRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const host = new ConnectorHost(c);
  const TAGS = ['Connectors'];
  const Params = IdParamSchema;
  const secret = c.config.JWT_ACCESS_SECRET;

  // ------------------------------------------------------------------ catalogue + capability matrix
  r.get('/marketplaces', {
    config: { access: { permission: 'connectors:read' } },
    schema: {
      tags: TAGS,
      summary: 'Marketplace connectors and their capability matrix',
      description: 'Marketplaces are NOT uniform: check `enabledCapabilities` before offering a feature. `planned` connectors are declared but not callable yet; `mock` is the sandbox.',
      response: { 200: successEnvelope(z.array(ConnectorInfoSchema)) },
    },
  }, async (req) => ok(req, c.connectors.list().map(toInfo)));

  r.get('/marketplaces/:code', {
    config: { access: { permission: 'connectors:read' } },
    schema: { tags: TAGS, summary: 'One connector and its capabilities', params: z.object({ code: z.string().min(2).max(40) }), response: { 200: successEnvelope(ConnectorInfoSchema) } },
  }, async (req) => ok(req, toInfo(c.connectors.get(req.params.code))));

  r.get('/marketplace-accounts/:id/capabilities', {
    config: { access: { permission: 'connectors:read' } },
    schema: { tags: TAGS, summary: 'Capability matrix of the account\'s marketplace', params: Params, response: { 200: successEnvelope(ConnectorInfoSchema) } },
  }, async (req) => {
    const acc = await vendorTx(req, (tx, vendorId) => getAccountRow(tx, vendorId, req.params.id));
    return ok(req, toInfo(c.connectors.get(acc.marketplace)));
  });

  // ------------------------------------------------------------------ authorization lifecycle
  r.get('/marketplace-accounts/:id/authorization-url', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Start the seller authorization (redirect flow)',
      description: 'Returns the marketplace URL to send the seller to, plus a signed, 10-minute `state` to pass back with the returned code (CSRF protection).',
      params: Params,
      querystring: z.object({ redirectUri: z.url() }),
      response: { 200: successEnvelope(z.object({ authorizationUrl: z.string(), state: z.string(), expiresInSeconds: z.number().int() })) },
    },
  }, async (req) => {
    const { acc, connector } = await vendorTx(req, async (tx, vendorId) => {
      const a = await getAccountRow(tx, vendorId, req.params.id);
      return { acc: a, connector: host.connectorFor(a) };
    });
    if (!connector.buildAuthorizationUrl) throw new AppError('CAPABILITY_UNSUPPORTED', `${connector.displayName} has no redirect authorization flow; send credentials to /authorize instead`, { details: { capability: 'auth.redirectFlow' } });
    const state = signState(secret, acc.vendorId, acc.id);
    return ok(req, { authorizationUrl: connector.buildAuthorizationUrl({ state, redirectUri: req.query.redirectUri }), state, expiresInSeconds: 600 });
  });

  const authorizeHandler = (action: 'authorize' | 'reconnect') => async (req: import('fastify').FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof AuthorizeBody> }>) => {
    const body = req.body;
    const vendorId = await vendorTx(req, async (tx, vid) => {
      await assertEmailVerified(req, tx);
      await getAccountRow(tx, vid, req.params.id);
      return vid;
    });
    if (body.code !== undefined && !verifyState(secret, body.state!, vendorId, req.params.id)) {
      throw new AppError('BAD_REQUEST', 'Invalid or expired authorization state; restart the connection', { details: { field: 'state' } });
    }
    const account = await host.authorize(vendorId, req.params.id, body);
    return ok(req, await vendorTx(req, async (tx, vid) => {
      await audit(tx, req, { action: `marketplace_account.${action}`, resourceType: 'marketplace_account', resourceId: req.params.id, after: { marketplace: account.marketplace, mode: account.mode } });
      return getAccount(tx, vid, req.params.id);
    }));
  };

  r.post('/marketplace-accounts/:id/authorize', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Connect the account (exchange a code, or submit credentials)',
      description: 'Validates the credentials with the marketplace BEFORE storing them, then stores them encrypted (AES-256-GCM). The response contains token metadata only. Sandbox: code `sandbox-code[:sellerId[:ttlSeconds]]` or credentials `{ sellerId, apiKey: "sandbox_..." }`. Requires a verified e-mail address.',
      params: Params,
      body: AuthorizeBody,
      response: { 200: successEnvelope(AccountSchema) },
    },
  }, authorizeHandler('authorize') as never);

  r.post('/marketplace-accounts/:id/reconnect', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Reconnect an account whose authorization expired or was revoked',
      description: 'Same inputs as /authorize; replaces the stored credentials and counts as a rotation.',
      params: Params,
      body: AuthorizeBody,
      response: { 200: successEnvelope(AccountSchema) },
    },
  }, authorizeHandler('reconnect') as never);

  r.post('/marketplace-accounts/:id/refresh', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: { tags: TAGS, summary: 'Rotate (refresh) the access token now', description: 'Normally automatic (ahead of expiry and on auth failures); this forces it. Increments `authorization.rotationCount`.', params: Params, response: { 200: successEnvelope(AccountSchema) } },
  }, async (req) => {
    const vendorId = requireVendor(req);
    await host.refresh(vendorId, req.params.id);
    return ok(req, await vendorTx(req, (tx, vid) => getAccount(tx, vid, req.params.id)));
  });

  r.post('/marketplace-accounts/:id/health-check', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Check the connection now',
      description: 'Calls the marketplace with the stored credentials (refreshing them if needed) and updates connection status, last success and last failure. Marketplace problems are reported in the body (`ok: false`), not as HTTP errors.',
      params: Params,
      response: { 200: successEnvelope(HealthSchema) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    return ok(req, await host.healthCheck(vendorId, req.params.id));
  });

  const TestSchema = z
    .object({
      ok: z.boolean(), marketplace: z.string(), mode: z.enum(['live', 'sandbox']), checkedAt: IsoDate,
      steps: z.array(z.object({ name: z.string(), ok: z.boolean(), skipped: z.boolean(), durationMs: z.number().int(), message: z.string().nullable() })),
    })
    .meta({ id: 'ConnectionTest' });

  r.post('/marketplace-accounts/:id/test', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Test the connection end to end (read-only)',
      description: 'Runs harmless read-only calls against the marketplace with the stored credentials: credentials, seller profile, catalogue read, order read. Each step reports success, latency and a message; steps the marketplace does not support are skipped. Nothing is changed on the marketplace.',
      params: Params,
      response: { 200: successEnvelope(TestSchema) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const acc = await vendorTx(req, (tx, vid) => getAccountRow(tx, vid, req.params.id));
    const steps: Array<{ name: string; ok: boolean; skipped: boolean; durationMs: number; message: string | null }> = [];
    const step = async (name: string, supported: (c: MarketplaceConnector) => boolean, fn: (c: MarketplaceConnector, ctx: import('@oms/marketplace-core').ConnectorContext) => Promise<string | null>) => {
      const started = Date.now();
      try {
        const message = await host.run(vendorId, acc.id, async (connector, ctx) => (supported(connector) ? { run: true as const, message: await fn(connector, ctx) } : { run: false as const, message: null }), { requestId: req.id });
        steps.push({ name, ok: true, skipped: !message.run, durationMs: Date.now() - started, message: message.message });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        steps.push({ name, ok: false, skipped: false, durationMs: Date.now() - started, message: e.message });
      }
    };
    await step('credentials', () => true, async (c, ctx) => { const r2 = await c.verifyConnection(ctx); if (!r2.ok) throw new AppError('UPSTREAM_ERROR', r2.message ?? 'The marketplace did not accept the connection'); return r2.message ?? 'Connected'; });
    await step('profile', (c) => c.capabilities.account.fetchProfile && Boolean(c.getAccount), async (c, ctx) => { const a = await c.getAccount!(ctx); return `Seller ${a.externalAccountId} (${a.displayName})`; });
    await step('catalog', (c) => c.capabilities.catalog.import && Boolean(c.importProducts), async (c, ctx) => { const p = await c.importProducts!(ctx, { limit: 1 }); return `Catalogue readable (${p.items.length > 0 ? 'products found' : 'empty'})`; });
    await step('orders', (c) => c.capabilities.orders.fetch && Boolean(c.fetchOrders), async (c, ctx) => { const o = await c.fetchOrders!(ctx, { since: new Date(Date.now() - 3600_000) }); return `Orders readable (${o.items.length} in the last hour)`; });
    return ok(req, { ok: steps.every((x) => x.ok), marketplace: acc.marketplace, mode: acc.mode as 'live' | 'sandbox', checkedAt: new Date().toISOString(), steps });
  });

  r.post('/marketplace-accounts/:id/disconnect', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: { tags: TAGS, summary: 'Disconnect the account', description: 'Destroys the stored credentials (irreversible) and marks the account `revoked`. Reconnect later with /reconnect.', params: Params, response: { 200: successEnvelope(AccountSchema) } },
  }, async (req) => {
    const vendorId = requireVendor(req);
    await host.disconnect(vendorId, req.params.id);
    return ok(req, await vendorTx(req, async (tx, vid) => {
      await audit(tx, req, { action: 'marketplace_account.disconnect', resourceType: 'marketplace_account', resourceId: req.params.id });
      return getAccount(tx, vid, req.params.id);
    }));
  });

  // ------------------------------------------------------------------ capability-gated reads
  r.get('/marketplace-accounts/:id/remote-account', {
    config: { access: { permission: 'marketplace_accounts:read' } },
    schema: {
      tags: TAGS,
      summary: 'Fetch the seller profile from the marketplace',
      description: 'Capability `account.fetchProfile`.',
      params: Params,
      response: { 200: successEnvelope(z.object({ externalAccountId: z.string(), displayName: z.string(), region: z.string().nullable(), status: z.string().nullable(), scopes: z.array(z.string()) })) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const acc = await host.run(vendorId, req.params.id, async (connector, ctx) => {
      requireCapability(connector, 'account.fetchProfile');
      return connector.getAccount!(ctx);
    }, { requestId: req.id });
    return ok(req, { externalAccountId: acc.externalAccountId, displayName: acc.displayName, region: acc.region ?? null, status: acc.status ?? null, scopes: acc.scopes ?? [] });
  });

  r.get('/marketplace-accounts/:id/remote-products', {
    config: { access: { permission: 'marketplace_accounts:read' } },
    schema: {
      tags: TAGS,
      summary: 'Preview products that already exist on the marketplace (import products)',
      description: 'Capability `catalog.import`. Read-only, paged with `cursor`. Use it to match marketplace SKUs with your catalogue before creating listings.',
      params: Params,
      querystring: z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }),
      response: { 200: successEnvelope(z.object({ items: z.array(RemoteProductSchema), nextCursor: z.string().nullable() })) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const page = await host.run(vendorId, req.params.id, async (connector, ctx) => {
      requireCapability(connector, 'catalog.import');
      return connector.importProducts!(ctx, { cursor: req.query.cursor, limit: req.query.limit });
    }, { requestId: req.id });
    return ok(req, {
      items: page.items.map((p) => ({ externalListingId: p.externalListingId, externalSku: p.externalSku, title: p.title, brand: p.brand ?? null, priceMinor: p.priceMinor ?? null, currency: p.currency ?? null, quantity: p.quantity ?? null, imageUrls: p.imageUrls ?? [], attributes: p.attributes ?? {} })),
      nextCursor: page.nextCursor,
    });
  });
};
