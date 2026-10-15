import fp from 'fastify-plugin';
import type { Metrics } from '@oms/observability';

/** HTTP RED metrics. Labels use the route TEMPLATE ("/api/v1/products/:id"), never the raw URL (cardinality). */
export const metricsPlugin = fp<{ metrics: Metrics }>(async (app, { metrics }) => {
  app.addHook('onRequest', async () => {
    metrics.httpRequestsInFlight.inc();
  });
  app.addHook('onResponse', async (req, reply) => {
    metrics.httpRequestsInFlight.dec();
    metrics.httpRequestDuration
      .labels(req.method, req.is404 ? 'unmatched' : (req.routeOptions.url ?? 'unmatched'), String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });
}, { name: 'oms-metrics' });
