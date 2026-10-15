import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildTestApp, type TestApp } from '@oms/testing';
import { ErrorBodySchema, PaginationQuerySchema, paginatedEnvelope, successEnvelope } from '@oms/contracts';
import { created, ok, paginated, requireScope, defineModule, type ModuleDefinition } from '@oms/module-kit';

/** A throwaway module that exercises every platform convention (stands in for a real domain module). */
const widgetRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const Widget = z.object({ id: z.string(), name: z.string(), vendorId: z.string() }).meta({ id: 'Widget' });

  r.get('/widgets', {
    config: { access: { permission: 'products:read' } },
    schema: { tags: ['Widgets'], summary: 'List widgets', querystring: PaginationQuerySchema, response: { 200: paginatedEnvelope(Widget) } },
  }, async (req) => {
    const scope = requireScope(req);
    const vendorId = scope.kind === 'vendor' ? scope.vendorId : 'platform';
    return paginated(req, [{ id: '1', name: 'w', vendorId }], { limit: req.query.limit, nextCursor: null });
  });

  r.post('/widgets', {
    config: { access: { permission: 'products:write' }, idempotent: true },
    schema: { tags: ['Widgets'], summary: 'Create widget', body: z.object({ name: z.string().min(2) }), response: { 201: successEnvelope(Widget) } },
  }, async (req, reply) => {
    const scope = requireScope(req);
    return created(req, reply, { id: String(Math.random()), name: req.body.name, vendorId: scope.kind === 'vendor' ? scope.vendorId : '' });
  });

  r.get('/boom', {
    config: { access: 'authenticated' },
    schema: { tags: ['Widgets'], summary: 'Always fails', response: { 200: successEnvelope(z.object({})) } },
  }, async () => { throw new Error('secret internal detail'); });

  r.get('/bad-response', {
    config: { access: 'authenticated' },
    schema: { tags: ['Widgets'], summary: 'Violates its own schema', response: { 200: successEnvelope(z.object({ n: z.number() })) } },
  }, async (req) => ok(req, { n: 'not-a-number' } as never));
};

const widgets: ModuleDefinition = {
  manifest: defineModule({ name: 'widgets', title: 'Widgets', responsibility: 'test', owns: [], dependsOn: [], api: ['/api/v1/widgets'], publishes: [], consumes: [], extraction: 'keep' }),
  routes: widgetRoutes,
};

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp({ modules: [widgets], healthChecks: { postgres: async () => undefined, redis: async () => undefined } });
});
afterAll(() => t.close());

const auth = async (o: Parameters<TestApp['tokenFor']>[0] = {}) => ({ authorization: `Bearer ${await t.tokenFor(o)}` });

describe('health', () => {
  it('GET /health', async () => {
    const res = await t.app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', environment: 'test' });
  });
  it('GET /health/live never touches dependencies', async () => {
    const res = await t.app.inject('/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
  it('GET /health/ready reports dependency status', async () => {
    const res = await t.app.inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { postgres: { status: 'up' }, redis: { status: 'up' } } });
  });
  it('GET /health/ready returns 503 when a critical dependency is down', async () => {
    const down = await buildTestApp({ healthChecks: { postgres: async () => { throw new Error('connection refused'); } } });
    const res = await down.app.inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', checks: { postgres: { status: 'down', error: 'connection refused' } } });
    await down.close();
  });
});

describe('request/correlation ids', () => {
  it('generates and returns ids; echoes a sane inbound correlation id', async () => {
    const res = await t.app.inject({ url: '/health', headers: { 'x-correlation-id': 'order-flow-123456' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-correlation-id']).toBe('order-flow-123456');
  });
  it('ignores malformed inbound ids (log-injection safe)', async () => {
    const res = await t.app.inject({ url: '/health', headers: { 'x-request-id': 'bad id\nwith newline' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error format', () => {
  it('404 uses the standard envelope', async () => {
    const res = await t.app.inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(ErrorBodySchema.parse(res.json())).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });
  it('validation errors list the offending fields', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/widgets', headers: { ...(await auth()), 'idempotency-key': 'key-validation-1' }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.issues[0].path).toBe('name');
  });
  it('malformed JSON is a 400, not a 500', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/widgets', headers: { ...(await auth()), 'content-type': 'application/json', 'idempotency-key': 'key-malformed-1' }, payload: '{bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });
  it('unexpected errors never leak internals', async () => {
    const res = await t.app.inject({ url: '/api/v1/boom', headers: await auth() });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
    expect(res.json().error.code).toBe('INTERNAL');
  });
  it('response schema violations are server errors that do not leak data', async () => {
    const res = await t.app.inject({ url: '/api/v1/bad-response', headers: await auth() });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
  });
});

describe('authentication & authorisation', () => {
  it('rejects missing and invalid tokens with 401', async () => {
    expect((await t.app.inject('/api/v1/me')).statusCode).toBe(401);
    const bad = await t.app.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer abc.def.ghi' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('TOKEN_INVALID');
  });
  it('GET /api/v1/me returns the resolved principal', async () => {
    const res = await t.app.inject({ url: '/api/v1/me', headers: await auth({ roles: ['vendor_viewer'] }) });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data).toMatchObject({ userType: 'vendor', vendorId: t.vendorId, roles: ['vendor_viewer'] });
    expect(data.permissions).toContain('products:read');
    expect(data.permissions).not.toContain('products:write');
  });
  it('enforces RBAC per route (403 with the missing permission)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/widgets', headers: { ...(await auth({ roles: ['vendor_viewer'] })), 'idempotency-key': 'key-rbac-0001' }, payload: { name: 'ok-name' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.requiredPermission).toBe('products:write');
  });
  it('a suspended vendor is locked out immediately', async () => {
    const suspendedId = '99999999-9999-7999-8999-999999999999';
    const s = await buildTestApp({ modules: [widgets], vendors: { [suspendedId]: 'suspended' } });
    const token = await s.tokenFor({ vendorId: suspendedId });
    const res = await s.app.inject({ url: '/api/v1/widgets', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_SUSPENDED');
    await s.close();
  });
});

describe('tenant context', () => {
  it('tenant comes from the token, never from client input', async () => {
    const res = await t.app.inject({ url: '/api/v1/widgets?vendorId=someone-else', headers: { ...(await auth()), 'x-vendor-id': 'someone-else' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].vendorId).toBe(t.vendorId);
  });
  it('vendor users cannot impersonate another vendor', async () => {
    const other = '88888888-8888-7888-8888-888888888888';
    const res = await t.app.inject({ url: '/api/v1/widgets', headers: { ...(await auth()), 'x-act-as-vendor': other } });
    expect(res.statusCode).toBe(403);
  });
  it('platform admins are cross-tenant, and can act as a vendor explicitly', async () => {
    const cross = await t.app.inject({ url: '/api/v1/widgets', headers: await auth({ userType: 'platform', roles: ['platform_admin'] }) });
    expect(cross.json().data[0].vendorId).toBe('platform');
    const as = await t.app.inject({ url: '/api/v1/widgets', headers: { ...(await auth({ userType: 'platform', roles: ['platform_admin'] })), 'x-act-as-vendor': t.vendorId } });
    expect(as.json().data[0].vendorId).toBe(t.vendorId);
  });
  it('platform support (no impersonate on write paths is still gated by permission)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/widgets', headers: { ...(await auth({ userType: 'platform', roles: ['platform_support'] })), 'idempotency-key': 'key-support-01' }, payload: { name: 'nope' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('pagination & validation of query params', () => {
  it('applies defaults and caps limit', async () => {
    const ok1 = await t.app.inject({ url: '/api/v1/widgets', headers: await auth() });
    expect(ok1.json().meta).toEqual({ limit: 25, nextCursor: null, hasMore: false });
    const bad = await t.app.inject({ url: '/api/v1/widgets?limit=1000', headers: await auth() });
    expect(bad.statusCode).toBe(400);
  });
});

const SAME_USER = '00000000-0000-7000-8000-00000000cafe';
describe('idempotency', () => {
  const post = async (key: string | undefined, name = 'widget-one') =>
    t.app.inject({ method: 'POST', url: '/api/v1/widgets', headers: { ...(await auth({ userId: SAME_USER })), ...(key ? { 'idempotency-key': key } : {}) }, payload: { name } });

  it('requires the header on idempotent routes', async () => {
    expect((await post(undefined)).statusCode).toBe(400);
  });
  it('replays the original response for the same key + payload', async () => {
    const first = await post('replay-key-0001');
    const second = await post('replay-key-0001');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json().data.id).toBe(first.json().data.id);
  });
  it('is bound to the caller: another user with the same key and body never replays someone else\'s response', async () => {
    await post('shared-key-0001');
    const other = await t.app.inject({ method: 'POST', url: '/api/v1/widgets', headers: { ...(await auth({ userId: '00000000-0000-7000-8000-00000000beef' })), 'idempotency-key': 'shared-key-0001' }, payload: { name: 'widget-one' } });
    expect(other.statusCode).toBe(422);
    expect(other.headers['idempotency-replayed']).toBeUndefined();
  });
  it('rejects the same key with a different payload', async () => {
    await post('reuse-key-00001', 'aaa');
    const res = await post('reuse-key-00001', 'bbb');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('security headers & cors', () => {
  it('sets hardening headers', async () => {
    const res = await t.app.inject('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
  it('only allows configured origins', async () => {
    const good = await t.app.inject({ url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const bad = await t.app.inject({ url: '/health', headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('returns 429 in the standard envelope with Retry-After', async () => {
    const rl = await buildTestApp({ config: { RATE_LIMIT_MAX: '3' } });
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) { last = await rl.app.inject('/api/v1/me'); codes.push(last.statusCode); }
    expect(codes).toContain(429);
    expect(last!.json().error.code).toBe('RATE_LIMITED');
    expect(last!.headers['retry-after']).toBeDefined();
    await rl.close();
  });
});

describe('metrics', () => {
  it('exposes prometheus metrics labelled by route template', async () => {
    await t.app.inject('/health/live');
    const res = await t.app.inject('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http_request_duration_seconds_bucket');
    expect(res.body).toContain('route="/health/live"');
  });
});
