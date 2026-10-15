import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';
import type { Logger } from '@oms/logging';

// ---------------------------------------------------------------------------------------------
// Metrics (Prometheus). One registry per process; label cardinality is kept low on purpose:
// never label by vendorId/userId/orderId. Use route *templates*, not raw URLs.
// ---------------------------------------------------------------------------------------------
export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  httpRequestsInFlight: Gauge;
  jobsProcessed: Counter<'queue' | 'status'>;
  jobDuration: Histogram<'queue'>;
  marketplaceCalls: Counter<'marketplace' | 'operation' | 'outcome'>;
  dbPoolSize: Gauge<'state'>;
}

export function createMetrics(service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    httpRequestsInFlight: new Gauge({ name: 'http_requests_in_flight', help: 'In-flight HTTP requests', registers: [registry] }),
    jobsProcessed: new Counter({ name: 'jobs_processed_total', help: 'Background jobs processed', labelNames: ['queue', 'status'], registers: [registry] }),
    jobDuration: new Histogram({
      name: 'job_duration_seconds', help: 'Background job duration', labelNames: ['queue'],
      buckets: [0.05, 0.25, 1, 5, 15, 60, 300], registers: [registry],
    }),
    marketplaceCalls: new Counter({
      name: 'marketplace_calls_total', help: 'Outbound marketplace API calls',
      labelNames: ['marketplace', 'operation', 'outcome'], registers: [registry],
    }),
    dbPoolSize: new Gauge({ name: 'db_pool_connections', help: 'pg pool connections', labelNames: ['state'], registers: [registry] }),
  };
}

// ---------------------------------------------------------------------------------------------
// Health. /health/live = process is up. /health/ready = dependencies reachable (DB, Redis).
// ---------------------------------------------------------------------------------------------
export type CheckResult = { status: 'up' | 'down'; latencyMs: number; error?: string };
export type HealthCheck = () => Promise<void>;

export class HealthRegistry {
  private readonly checks = new Map<string, { fn: HealthCheck; critical: boolean }>();

  register(name: string, fn: HealthCheck, opts: { critical?: boolean } = {}): void {
    this.checks.set(name, { fn, critical: opts.critical ?? true });
  }

  async run(timeoutMs = 2000): Promise<{ ok: boolean; checks: Record<string, CheckResult> }> {
    const entries = await Promise.all(
      [...this.checks.entries()].map(async ([name, { fn, critical }]) => {
        const started = performance.now();
        try {
          await Promise.race([
            fn(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs).unref()),
          ]);
          return [name, { critical, result: { status: 'up', latencyMs: Math.round(performance.now() - started) } as CheckResult }] as const;
        } catch (e) {
          return [name, { critical, result: { status: 'down', latencyMs: Math.round(performance.now() - started), error: (e as Error).message } as CheckResult }] as const;
        }
      }),
    );
    return {
      ok: entries.every(([, v]) => v.result.status === 'up' || !v.critical),
      checks: Object.fromEntries(entries.map(([n, v]) => [n, v.result])),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Error tracking: thin port so Sentry (or similar) can be plugged in without touching call sites.
// ---------------------------------------------------------------------------------------------
export interface ErrorTracker {
  captureException(err: unknown, context?: Record<string, unknown>): void;
}

export const logErrorTracker = (logger: Logger): ErrorTracker => ({
  captureException: (err, context) => logger.error({ err, ...context }, 'unhandled exception captured'),
});

// ---------------------------------------------------------------------------------------------
// Tracing (OpenTelemetry). Must be started BEFORE other imports in the entrypoint so
// http/pg instrumentations can patch modules. No-op unless OTEL_ENABLED=true.
// ---------------------------------------------------------------------------------------------
export interface TracingConfig { enabled: boolean; serviceName: string; serviceVersion?: string; environment: string; otlpEndpoint?: string }

export async function startTracing(cfg: TracingConfig): Promise<{ shutdown: () => Promise<void> }> {
  if (!cfg.enabled) return { shutdown: async () => undefined };
  const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { PgInstrumentation }, { resourceFromAttributes }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/resources'),
  ]);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': cfg.serviceName,
      'service.version': cfg.serviceVersion ?? '0.0.0',
      'deployment.environment.name': cfg.environment,
    }),
    traceExporter: new OTLPTraceExporter(cfg.otlpEndpoint ? { url: `${cfg.otlpEndpoint.replace(/\/$/, '')}/v1/traces` } : {}),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

export { trace, context as otelContext, SpanStatusCode } from '@opentelemetry/api';
export { Gauge } from 'prom-client';
