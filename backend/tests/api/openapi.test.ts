import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { buildTestApp, PROD_SAFE_ENV, type TestApp } from '@oms/testing';
import { routePolicyPlugin } from '../../apps/api/src/plugins/route-policy';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(() => t.close());

describe('OpenAPI / Swagger', () => {
  it('serves the spec at /docs/openapi and the UI at /docs', async () => {
    const spec = await t.app.inject('/docs/openapi');
    expect(spec.statusCode).toBe(200);
    const doc = spec.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('OMS Platform API');
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });

    const ui = await t.app.inject('/docs');
    expect([200, 302]).toContain(ui.statusCode);
    expect((await t.app.inject('/docs/openapi.yaml')).statusCode).toBe(200);
  });

  it('documents every route, with standard error responses and security injected', async () => {
    const doc = (await t.app.inject('/docs/openapi')).json();
    expect(doc.paths['/api/v1/me']).toBeDefined();
    const me = doc.paths['/api/v1/me'].get;
    expect(me.tags).toContain('Profile');
    expect(me.summary).toBeTruthy();
    expect(me.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(me.responses)).toEqual(expect.arrayContaining(['200', '401', '403', '429', '500']));
    // public routes are not marked as requiring auth
    expect(doc.paths['/health/live'].get.security).toBeUndefined();
  });

  it('does not expose internal/operational endpoints', async () => {
    const doc = (await t.app.inject('/docs/openapi')).json();
    expect(doc.paths['/metrics']).toBeUndefined();
    expect(doc.paths['/docs/openapi']).toBeUndefined();
  });

  it('every documented operation has summary, tags and a 2xx response (no undocumented APIs)', async () => {
    const doc = (await t.app.inject('/docs/openapi')).json() as { paths: Record<string, Record<string, { summary?: string; tags?: string[]; responses: Record<string, unknown> }>> };
    for (const [path, ops] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(ops)) {
      expect(op.summary, `${method} ${path}`).toBeTruthy();
      expect(op.tags?.length, `${method} ${path}`).toBeGreaterThan(0);
      expect(Object.keys(op.responses).some((c) => c.startsWith('2')), `${method} ${path}`).toBe(true);
    }
  });

  it('is disabled in production by default', async () => {
    const prod = await buildTestApp({ config: { ...PROD_SAFE_ENV, SWAGGER_ENABLED: 'false' } });
    expect((await prod.app.inject('/docs/openapi')).statusCode).toBe(404);
    await prod.close();
  });
});

describe('route policy (boot-time enforcement)', () => {
  const attempt = async (register: (app: ReturnType<typeof Fastify>) => void) => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(routePolicyPlugin);
    await app.register(async (a) => register(a as never), { prefix: '/api/v1' });
    return app.ready();
  };
  const ok = { schema: { tags: ['X'], summary: 's', response: { 200: z.object({}) } } };

  it('refuses a route without config.access', async () => {
    await expect(attempt((a) => a.get('/x', ok, async () => ({})))).rejects.toThrow(/missing config.access/);
  });
  it('refuses an undocumented route (no summary/tags/response)', async () => {
    await expect(attempt((a) => a.get('/x', { config: { access: 'public' }, schema: { tags: ['X'] } }, async () => ({})))).rejects.toThrow(/missing schema.summary/);
    await expect(attempt((a) => a.get('/x', { config: { access: 'public' }, schema: { summary: 's' } }, async () => ({})))).rejects.toThrow(/missing schema.tags/);
    await expect(attempt((a) => a.get('/x', { config: { access: 'public' }, schema: { summary: 's', tags: ['X'] } }, async () => ({})))).rejects.toThrow(/2xx response/);
  });
  it('refuses unknown permissions (typos cannot silently open or close a route)', async () => {
    await expect(attempt((a) => a.get('/x', { ...ok, config: { access: { permission: 'products:raed' } } }, async () => ({})))).rejects.toThrow(/unknown permission/);
  });
  it('refuses public routes outside /api/v1', async () => {
    const app = Fastify();
    await app.register(routePolicyPlugin);
    expect(() => app.get('/rogue', { ...ok, config: { access: 'public' } }, async () => ({}))).toThrow(/must live under \/api\/v1/);
  });
  it('accepts a fully declared route', async () => {
    await expect(attempt((a) => a.get('/x', { ...ok, config: { access: 'public' } }, async () => ({})))).resolves.toBeDefined();
  });
});
