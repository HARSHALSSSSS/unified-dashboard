import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { timingSafeEqual } from 'node:crypto';
import { HealthLiveSchema, HealthReadySchema, HealthSchema, ErrorBodySchema } from '@oms/contracts';
import type { HealthRegistry, Metrics } from '@oms/observability';

/**
 * /health        service identity (cheap, always 200 while the process runs)
 * /health/live   LIVENESS  - "is the process healthy enough not to be restarted?" No dependency checks, ever:
 *                a Redis outage must not make the orchestrator kill every API pod.
 * /health/ready  READINESS - "should the load balancer send traffic?" Checks critical dependencies; 503 when not ready.
 * /metrics       Prometheus scrape (optionally protected by METRICS_TOKEN)
 */
export const systemRoutes: FastifyPluginAsync<{ health: HealthRegistry; metrics: Metrics; metricsEnabled: boolean; metricsToken?: string; service: string; version: string; environment: string }> = async (app, opts) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/health', {
    config: { access: 'public' },
    schema: { tags: ['System'], summary: 'Service info', response: { 200: HealthSchema } },
  }, async () => ({ status: 'ok' as const, service: opts.service, version: opts.version, environment: opts.environment }));

  r.get('/health/live', {
    config: { access: 'public' },
    schema: { tags: ['System'], summary: 'Liveness probe', response: { 200: HealthLiveSchema } },
  }, async () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }));

  r.get('/health/ready', {
    config: { access: 'public' },
    schema: { tags: ['System'], summary: 'Readiness probe', response: { 200: HealthReadySchema, 503: HealthReadySchema, 500: ErrorBodySchema } },
  }, async (_req, reply) => {
    const { ok, checks } = await opts.health.run();
    // dependency names / latencies are for operators (logs, metrics), not for the internet
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks: opts.environment === 'production' ? {} : checks });
  });

  if (opts.metricsEnabled) {
    r.get('/metrics', { config: { access: 'internal' }, schema: { hide: true } }, async (req, reply) => {
      if (opts.metricsToken) {
        const got = Buffer.from(req.headers.authorization ?? '');
        const want = Buffer.from(`Bearer ${opts.metricsToken}`);
        if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send('unauthorized');
      }
      return reply.type(opts.metrics.registry.contentType).send(await opts.metrics.registry.metrics());
    });
  }
};
