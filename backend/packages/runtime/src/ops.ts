import { createServer, type Server } from 'node:http';
import { safeEqual } from '@oms/auth';
import type { Runtime } from './index';

/**
 * Tiny HTTP server for non-HTTP processes (worker, scheduler, webhook-worker) exposing the same probes
 * as the API: /health/live, /health/ready, /metrics. Kubernetes/ECS probe these.
 */
export function startOpsServer(rt: Runtime, port: number): Server {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    try {
      if (url === '/health/live') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));
      } else if (url === '/health/ready') {
        const { ok, checks } = await rt.health.run();
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ready' : 'degraded', ...(rt.config.isProd ? {} : { checks }) }));
      } else if (url === '/metrics' && rt.config.METRICS_ENABLED) {
        if (rt.config.METRICS_TOKEN && !safeEqual(req.headers.authorization ?? '', `Bearer ${rt.config.METRICS_TOKEN}`)) { res.writeHead(401).end(); return; }
        res.writeHead(200, { 'content-type': rt.metrics.registry.contentType }).end(await rt.metrics.registry.metrics());
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      rt.logger.error({ err }, 'ops server error');
      res.writeHead(500).end();
    }
  });
  server.listen(port, '0.0.0.0');
  rt.onShutdown('ops-server', () => new Promise((resolve) => server.close(() => resolve())));
  return server;
}
