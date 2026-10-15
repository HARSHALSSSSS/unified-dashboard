import fp from 'fastify-plugin';
import { enrichContext, runWithContext } from '@oms/logging';
import { newId } from '@oms/shared';

const ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Accept a caller-supplied id only if it looks sane (prevents log injection / unbounded values). */
export const sanitizeId = (v: unknown): string | undefined => (typeof v === 'string' && ID_PATTERN.test(v) ? v : undefined);

/**
 * Request id  : unique per HTTP request (returned as X-Request-Id and in every response body).
 * Correlation : constant across a whole business flow (HTTP -> outbox event -> queue job -> worker), taken from
 *               X-Correlation-Id when a caller/upstream supplies it, otherwise equals the request id.
 */
export const contextPlugin = fp(async (app) => {
  app.decorateRequest('ctx', undefined as never);

  app.addHook('onRequest', (req, reply, done) => {
    const correlationId = sanitizeId(req.headers['x-correlation-id']) ?? req.id;
    req.ctx = {
      requestId: req.id,
      correlationId,
      principal: null,
      scope: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
    reply.header('x-request-id', req.id);
    reply.header('x-correlation-id', correlationId);
    // Everything that runs for this request (including async continuations) sees these in its logs.
    runWithContext({ requestId: req.id, correlationId }, () => {
      enrichContext({ requestId: req.id, correlationId });
      done();
    });
  });
}, { name: 'oms-context' });

export const genReqId = (req: { headers: Record<string, unknown> }): string => sanitizeId(req.headers['x-request-id']) ?? newId();
