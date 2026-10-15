import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, created, emit, ok, paginated, vendorTx } from '@oms/module-kit';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, sortQuery, successEnvelope } from '@oms/contracts';
import * as svc from './service';

export const AccountSchema = z
  .object({
    id: z.string(),
    marketplace: z.string().describe('Marketplace code: amazon_in, flipkart, myntra, snapdeal, mock'),
    displayName: z.string(),
    externalAccountId: z.string().nullable().describe('Seller/merchant id assigned by the marketplace'),
    region: z.string(),
    mode: z.enum(['live', 'sandbox']),
    status: z.enum(['pending_authorization', 'active', 'paused', 'error', 'revoked']),
    connectionStatus: z.enum(['unknown', 'connected', 'degraded', 'disconnected', 'error']),
    authorization: z
      .object({
        status: z.enum(['active', 'expiring', 'expired', 'revoked', 'error']),
        authType: z.string(),
        scopes: z.array(z.string()),
        accessTokenExpiresAt: IsoDate.nullable(),
        lastRefreshedAt: IsoDate.nullable(),
        rotationCount: z.number().int().describe('How many times the tokens were rotated (refreshed)'),
        lastErrorCode: z.string().nullable(),
        lastErrorAt: IsoDate.nullable(),
      })
      .nullable()
      .describe('Token METADATA only. Credentials/tokens are never returned by any endpoint.'),
    config: z.record(z.string(), z.unknown()),
    lastSyncedAt: IsoDate.nullable(),
    lastSuccessAt: IsoDate.nullable(),
    lastFailureAt: IsoDate.nullable(),
    lastFailureMessage: z.string().nullable(),
    version: z.number().int(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'MarketplaceAccount' });

const CreateBody = z.object({
  marketplace: z.string().trim().min(2).max(40).meta({ example: 'mock', description: 'Code from GET /marketplaces' }),
  displayName: z.string().trim().min(2).max(120).meta({ example: 'Acme - Flipkart' }),
  externalAccountId: z.string().trim().min(1).max(100).nullish().describe('Seller id, if already known; otherwise it is filled in when you authorize'),
  region: z.string().trim().length(2).toUpperCase().default('IN'),
  mode: z.enum(['live', 'sandbox']).optional().describe('`mock` is always sandbox'),
  config: z.record(z.string(), z.unknown()).optional(),
});
const UpdateBody = z.object({ displayName: z.string().trim().min(2).max(120), config: z.record(z.string(), z.unknown()), status: z.enum(['active', 'paused']), version: z.number().int() }).partial();
const ListQuery = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
  'filter[marketplace]': z.string().max(40).optional(),
  'filter[status]': z.enum(['pending_authorization', 'active', 'paused', 'error', 'revoked']).optional(),
  sort: sortQuery(['createdAt', 'displayName'] as const),
});

export const accountRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const TAGS = ['Marketplace Accounts'];

  r.post('/marketplace-accounts', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: {
      tags: TAGS,
      summary: 'Create a marketplace account (connection placeholder)',
      description: 'A vendor can hold many accounts, across and within marketplaces. The account starts as `pending_authorization`; connect it with POST /marketplace-accounts/{id}/authorize. Use marketplace `mock` for the sandbox.',
      body: CreateBody,
      response: { 201: successEnvelope(AccountSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const a = await svc.createAccount(tx, c, vendorId, req.body);
      await audit(tx, req, { action: 'marketplace_account.create', resourceType: 'marketplace_account', resourceId: a.id, after: { marketplace: a.marketplace, displayName: a.displayName, mode: a.mode } });
      return a;
    });
    return created(req, reply, dto, `/api/v1/marketplace-accounts/${dto.id}`);
  });

  r.get('/marketplace-accounts', {
    config: { access: { permission: 'marketplace_accounts:read' } },
    schema: { tags: TAGS, summary: 'List my marketplace accounts', querystring: ListQuery, response: { 200: paginatedEnvelope(AccountSchema) } },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listAccounts(tx, vendorId, { limit: q.limit, cursor: q.cursor, q: q.q, marketplace: q['filter[marketplace]'], status: q['filter[status]'], sort: q.sort }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/marketplace-accounts/:id', {
    config: { access: { permission: 'marketplace_accounts:read' } },
    schema: { tags: TAGS, summary: 'Get a marketplace account (token metadata only, never secrets)', params: IdParamSchema, response: { 200: successEnvelope(AccountSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.getAccount(tx, vendorId, req.params.id))));

  r.patch('/marketplace-accounts/:id', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: { tags: TAGS, summary: 'Rename, configure, pause or resume an account', params: IdParamSchema, body: UpdateBody, response: { 200: successEnvelope(AccountSchema) } },
  }, async (req) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.updateAccount(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'marketplace_account.update', resourceType: 'marketplace_account', resourceId: req.params.id, before: { displayName: res.before.displayName, status: res.before.status }, after: { displayName: res.after.displayName, status: res.after.status } });
      if (req.body.status) await emit(tx, req, { type: 'marketplace_account.paused', aggregateType: 'marketplace_account', aggregateId: req.params.id, payload: { status: req.body.status } });
      return svc.getAccount(tx, vendorId, req.params.id);
    });
    return ok(req, dto);
  });

  r.delete('/marketplace-accounts/:id', {
    config: { access: { permission: 'marketplace_accounts:write' } },
    schema: { tags: TAGS, summary: 'Delete an account', description: 'Refused (409) while the account is connected: disconnect it first.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ message: z.string() })) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const a = await svc.deleteAccount(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'marketplace_account.delete', resourceType: 'marketplace_account', resourceId: a.id, before: { marketplace: a.marketplace, displayName: a.displayName } });
    });
    return ok(req, { message: 'Marketplace account deleted' });
  });
};
