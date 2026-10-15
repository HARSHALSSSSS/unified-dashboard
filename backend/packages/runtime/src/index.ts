import { loadConfig, type AppConfig } from '@oms/config';
import { createLogger, type Logger } from '@oms/logging';
import { createMetrics, HealthRegistry, logErrorTracker, startTracing, type ErrorTracker, type Metrics } from '@oms/observability';
import { createDatabase, type Database } from '@oms/database';
import { createRedis, QueueRegistry } from '@oms/messaging';
import { createStorage } from '@oms/storage';
import { LogMailer } from '@oms/module-kit';
import { createConnectorRegistry } from '@oms/connectors';
import type { Container } from '@oms/module-kit';
import type { Redis } from 'ioredis';

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  health: HealthRegistry;
  errorTracker: ErrorTracker;
  /** BullMQ-grade connection (blocking commands, offline queue). Never use for request-path work. */
  redis: Redis;
  /** Request-path connection: fails fast when Redis is down (no offline queue) so HTTP never hangs on it. */
  redisFast: Redis;
  container: Container;
  /** Idempotent, ordered shutdown: stop accepting work -> flush queues -> close pools -> flush tracing. */
  onShutdown(name: string, fn: () => Promise<void>): void;
  shutdown(reason: string): Promise<void>;
}

/**
 * Composition root shared by every process (api, worker, scheduler, webhook-worker).
 * Each app differs only in WHAT it runs on top of the same container, which is what makes extracting
 * a module into its own service later a deployment change, not a rewrite.
 */
export async function createRuntime(service: string): Promise<Runtime> {
  const config = loadConfig();
  const tracing = await startTracing({
    enabled: config.OTEL_ENABLED,
    serviceName: `${config.APP_NAME}-${service}`,
    serviceVersion: config.APP_VERSION,
    environment: config.NODE_ENV,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const logger = createLogger({ level: config.LOG_LEVEL, service, version: config.APP_VERSION, pretty: config.LOG_PRETTY });
  const metrics = createMetrics(service);
  const health = new HealthRegistry();
  const database = createDatabase(config, `${config.APP_NAME}-${service}`);
  const redis = createRedis(config.REDIS_URL);
  const redisFast = createRedis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 250, connectTimeout: 1000 });
  // Reconnect storms must not flood the logs: at most one line per connection every 30s.
  for (const [name, conn] of [['bullmq', redis], ['fast', redisFast]] as const) {
    let last = 0;
    conn.on('error', (err) => { if (Date.now() - last > 30_000) { last = Date.now(); logger.warn({ err: err.message, connection: name }, 'redis error (throttled)'); } });
  }
  const queues = new QueueRegistry(redis, config.REDIS_KEY_PREFIX);
  const storage = createStorage(config);

  health.register('postgres', () => database.ping());
  health.register('redis', async () => void (await redisFast.ping()));
  if (config.STORAGE_ENDPOINT) health.register('object-storage', () => storage.ping(), { critical: false });

  const hooks: Array<{ name: string; fn: () => Promise<void> }> = [];
  let shuttingDown: Promise<void> | undefined;

  const runtime: Runtime = {
    config, logger, metrics, health, redis, redisFast,
    errorTracker: logErrorTracker(logger),
    container: { config, logger, database: database satisfies Database, queues, storage, connectors: createConnectorRegistry({
      mock: config.mockMarketplaceEnabled,
      amazon: config.AMAZON_IN_LWA_CLIENT_ID && config.AMAZON_IN_LWA_CLIENT_SECRET ? { clientId: config.AMAZON_IN_LWA_CLIENT_ID, clientSecret: config.AMAZON_IN_LWA_CLIENT_SECRET } : undefined,
      flipkart: config.FLIPKART_APP_ID && config.FLIPKART_APP_SECRET ? { appId: config.FLIPKART_APP_ID, appSecret: config.FLIPKART_APP_SECRET } : undefined,
    }), mailer: new LogMailer(logger, !config.isProd) },
    onShutdown: (name, fn) => void hooks.push({ name, fn }),
    shutdown: (reason) =>
      (shuttingDown ??= (async () => {
        logger.info({ reason }, 'shutting down');
        for (const h of [...hooks].reverse()) {
          try { await h.fn(); } catch (err) { logger.error({ err, hook: h.name }, 'shutdown hook failed'); }
        }
        await queues.close().catch(() => undefined);
        await database.close().catch(() => undefined);
        redis.disconnect();
        redisFast.disconnect();
        await tracing.shutdown().catch(() => undefined);
        logger.info('shutdown complete');
      })()),
  };

  const stop = (sig: string) => void runtime.shutdown(sig).then(() => process.exit(0));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (err) => { logger.error({ err }, 'unhandledRejection'); runtime.errorTracker.captureException(err); });
  process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaughtException'); runtime.errorTracker.captureException(err); void runtime.shutdown('uncaughtException').then(() => process.exit(1)); });

  return runtime;
}

export { startOpsServer } from './ops';
export { startProcessors } from './processors';
export { startOutboxRelay } from './outbox';
