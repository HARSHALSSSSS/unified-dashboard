import { createRuntime } from '@oms/runtime';
import { allModules } from '@oms/modules-registry';
import { buildApp } from './app';
import { DbAccessDirectory } from './access-directory';
import { DbIdempotencyStore } from './idempotency-db';

const rt = await createRuntime('api');
const { config, logger } = rt;

const app = await buildApp({
  container: rt.container,
  logger,
  metrics: rt.metrics,
  health: rt.health,
  errorTracker: rt.errorTracker,
  access: new DbAccessDirectory(rt.container.database),
  idempotency: new DbIdempotencyStore(rt.container.database),
  modules: allModules,
  redis: rt.redisFast,
});

rt.onShutdown('http', () => app.close());

await app.listen({ host: config.HOST, port: config.PORT });
logger.info({ port: config.PORT, env: config.NODE_ENV, docs: config.swaggerEnabled ? `${config.PUBLIC_BASE_URL}/docs` : 'disabled' }, 'api started');
