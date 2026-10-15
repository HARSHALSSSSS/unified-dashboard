import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import { AppError } from '@oms/shared';
import type { AppConfig } from '@oms/config';

/**
 * Transport-level protections.
 *  - helmet: HSTS, nosniff, frameguard, no-referrer, COOP/CORP. CSP is relaxed only for /docs (Swagger UI inline assets).
 *  - cors: explicit allow-list from CORS_ORIGINS, credentials off (we use bearer tokens, not cookies).
 *  - rate limit: global per-IP baseline (Redis-backed when available so limits hold across instances);
 *    sensitive routes (login, refresh) add a stricter per-route limiter with app.rateLimit({ max: AUTH_RATE_LIMIT_MAX }).
 */
export const securityPlugin = fp<{ config: AppConfig; redis?: Redis }>(async (app, opts) => {
  const { config } = opts;

  await app.register(helmet, {
    contentSecurityPolicy: config.swaggerEnabled
      ? { directives: { 'default-src': ["'self'"], 'script-src': ["'self'", "'unsafe-inline'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'] } }
      : { directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
    hsts: config.isProd || config.NODE_ENV === 'staging' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-Correlation-Id', 'X-Act-As-Vendor'],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id', 'Retry-After', 'Idempotency-Replayed'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    // global:false + an explicit app-level hook below: route-level hooks run AFTER app-level onRequest hooks, so a
    // "global" limiter would only see requests that already passed authentication (unthrottled token guessing).
    global: false,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    redis: opts.redis,
    nameSpace: `${config.REDIS_KEY_PREFIX}:rl:`,
    skipOnError: true, // never take the API down because Redis is down
    allowList: (req) => req.url.startsWith('/health') || req.url === '/metrics',
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', undefined, { details: { limit: ctx.max, retryAfterSeconds: Math.ceil(ctx.ttl / 1000) } }),
  });
  app.addHook('onRequest', app.rateLimit());
}, { name: 'oms-security' });
