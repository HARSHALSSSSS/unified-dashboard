import fp from 'fastify-plugin';
import { PERMISSIONS } from '@oms/auth';

const SYSTEM_PATHS = new Set(['/health', '/health/live', '/health/ready']);
const KNOWN = new Set<string>(PERMISSIONS);

/**
 * Compile-time-of-boot guard: the process REFUSES TO START if any route is undocumented or has no declared
 * access policy. This is how "no undocumented APIs" and "deny by default" are enforced mechanically, for
 * every module and every future stage.
 *
 * A route must declare:
 *   schema.summary, schema.tags[], a 2xx entry in schema.response   -> appears in Swagger
 *   config.access = 'public' | 'authenticated' | { permission }      -> enforced by the access hook
 * Only `config.access = 'internal'` + `schema.hide = true` (metrics, docs) may skip documentation.
 */
export const routePolicyPlugin = fp(async (app) => {
  app.addHook('onRoute', (route) => {
    if (route.method === 'HEAD' || route.method === 'OPTIONS') return;
    const where = `${String(route.method)} ${route.url}`;
    const schema = (route.schema ?? {}) as { summary?: string; tags?: string[]; response?: Record<string, unknown>; hide?: boolean };
    const access = route.config?.access;

    // Swagger UI's own static routes (registered by @fastify/swagger-ui, hidden from the spec).
    if (!access && schema.hide && route.url.startsWith('/docs')) return;

    if (!access) throw new Error(`[route-policy] ${where}: missing config.access (deny-by-default)`);

    if (access === 'internal') {
      if (!schema.hide) throw new Error(`[route-policy] ${where}: internal routes must set schema.hide = true`);
      return;
    }
    if (!SYSTEM_PATHS.has(route.url) && !route.url.startsWith('/api/v1/')) {
      throw new Error(`[route-policy] ${where}: public API routes must live under /api/v1/`);
    }
    if (!schema.summary) throw new Error(`[route-policy] ${where}: missing schema.summary (undocumented API)`);
    if (!schema.tags?.length) throw new Error(`[route-policy] ${where}: missing schema.tags (undocumented API)`);
    if (!schema.response || !Object.keys(schema.response).some((c) => c.startsWith('2'))) {
      throw new Error(`[route-policy] ${where}: missing 2xx response schema (undocumented API)`);
    }
    // Every authenticated state-changing endpoint honours an Idempotency-Key header (a retried request never repeats its effect).
    // Public endpoints (login, refresh...) are excluded on purpose: their responses carry tokens and must never be cached.
    if (typeof access === 'object' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(route.method)) && route.config && route.config.idempotent === undefined) route.config.idempotent = 'optional';
    if (typeof access === 'object' && !KNOWN.has(access.permission)) {
      throw new Error(`[route-policy] ${where}: unknown permission "${access.permission}" (add it to @oms/auth PERMISSIONS)`);
    }
  });
}, { name: 'oms-route-policy' });
