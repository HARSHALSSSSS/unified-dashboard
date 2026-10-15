import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { TokenConfig } from '@oms/auth';
import type { ErrorTracker, HealthRegistry, Metrics } from '@oms/observability';
import type { Container, ModuleDefinition } from '@oms/module-kit';
import type { Logger } from '@oms/logging';
import { contextPlugin, genReqId } from './plugins/context';
import { errorPlugin } from './plugins/errors';
import { routePolicyPlugin } from './plugins/route-policy';
import { securityPlugin } from './plugins/security';
import { metricsPlugin } from './plugins/metrics';
import { openapiPlugin } from './plugins/openapi';
import { accessPlugin } from './plugins/access';
import { idempotencyPlugin, type IdempotencyStore } from './plugins/idempotency';
import { systemRoutes } from './routes/system';
import { meRoutes } from './routes/me';
import type { AccessDirectory } from './access-directory';

export interface AppDeps {
  container: Container;
  logger: Logger;
  metrics: Metrics;
  health: HealthRegistry;
  errorTracker: ErrorTracker;
  access: AccessDirectory;
  idempotency: IdempotencyStore;
  modules: ModuleDefinition[];
  redis?: Redis;
}

/**
 * Composition of the HTTP layer. Plugin ORDER matters (hooks run in registration order):
 *   context -> errors -> route-policy -> security -> metrics -> openapi -> access -> idempotency -> routes
 * `buildApp` has no side effects besides construction, so tests and the OpenAPI exporter can call it freely.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { container, modules } = deps;
  const { config } = container;

  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId,
    logController: new LogController({ requestIdLogLabel: 'requestId', disableRequestLogging: config.isTest }),
    // a number means "believe exactly that many proxy hops" (proxy-addr semantics: hop index < n); never the whole X-Forwarded-For chain
    trustProxy: typeof config.TRUST_PROXY === 'number' ? ((_addr: string, hop: number) => hop < (config.TRUST_PROXY as number)) : config.TRUST_PROXY,
    bodyLimit: 1_048_576,
    forceCloseConnections: 'idle',
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('container', container);

  await app.register(contextPlugin);
  await app.register(errorPlugin, { tracker: deps.errorTracker });
  await app.register(routePolicyPlugin);
  await app.register(securityPlugin, { config, redis: deps.redis });
  await app.register(metricsPlugin, { metrics: deps.metrics });
  await app.register(openapiPlugin, { config, modules: modules.map((m) => m.manifest) });

  const tokens: TokenConfig = {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    secret: config.JWT_ACCESS_SECRET,
    accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS,
  };
  await app.register(accessPlugin, { tokens, directory: deps.access });
  await app.register(idempotencyPlugin, { store: deps.idempotency });

  await app.register(systemRoutes, {
    health: deps.health,
    metrics: deps.metrics,
    metricsEnabled: config.METRICS_ENABLED,
    metricsToken: config.METRICS_TOKEN,
    service: config.APP_NAME,
    version: config.APP_VERSION,
    environment: config.NODE_ENV,
  });

  // /api/v1 surface: platform routes + one plugin per domain module
  await app.register(
    async (v1) => {
      await v1.register(meRoutes);
      for (const m of modules) if (m.routes) await v1.register(m.routes);
    },
    { prefix: '/api/v1' },
  );

  // Fastify's generic logger type differs from the pino instance we inject; the public type is the plain interface.
  return app as unknown as FastifyInstance;
}
