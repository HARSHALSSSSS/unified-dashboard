import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError, ErrorCodes, isAppError, type ErrorCode } from '@oms/shared';
import type { ErrorTracker } from '@oms/observability';
import { CONSTRAINT_FIELDS, PG, isConnectivityError, pgError } from '@oms/database';

/** schema / constraint names help developers; outside development and test they only help an attacker map the database */
const SHOW_INTERNALS = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging';

interface Normalized { status: number; code: ErrorCode; message: string; details?: Record<string, unknown>; unexpected: boolean }

function normalize(err: unknown): Normalized {
  if (isAppError(err)) {
    return {
      status: err.status,
      code: err.code,
      message: err.expose ? err.message : ErrorCodes[err.code].message,
      details: err.expose ? err.details : undefined,
      unexpected: err.status >= 500 && err.code === 'INTERNAL',
    };
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: ErrorCodes.VALIDATION_FAILED.message,
      details: {
        location: (err as { validationContext?: string }).validationContext,
        issues: err.validation.map((v) => ({
          path: (v.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.'),
          message: v.message ?? 'invalid',
        })),
      },
      unexpected: false,
    };
  }
  if (isResponseSerializationError(err)) {
    // A handler returned data that violates its own response schema: a server bug, never a client error.
    return { status: 500, code: 'INTERNAL', message: ErrorCodes.INTERNAL.message, unexpected: true };
  }
  const pg = pgError(err);
  if (pg?.code === PG.UNIQUE_VIOLATION) {
    const field = pg.constraint ? CONSTRAINT_FIELDS[pg.constraint] : undefined;
    return { status: 409, code: 'CONFLICT', message: field ? `${field} already exists` : 'A record with the same unique value already exists', details: { ...(field ? { field } : {}), ...(pg.constraint && SHOW_INTERNALS ? { constraint: pg.constraint } : {}) }, unexpected: false };
  }
  if (pg?.code === PG.FK_VIOLATION) {
    return { status: 409, code: 'CONFLICT', message: 'The record references (or is referenced by) another record that does not exist or is still in use', details: pg.constraint && SHOW_INTERNALS ? { constraint: pg.constraint } : undefined, unexpected: false };
  }
  if (pg?.code === PG.CHECK_VIOLATION) {
    return { status: 400, code: 'VALIDATION_FAILED', message: 'A value violates a data constraint', details: pg.constraint && SHOW_INTERNALS ? { constraint: pg.constraint } : undefined, unexpected: false };
  }
  if (pg?.code === PG.RLS_VIOLATION) return { status: 403, code: 'FORBIDDEN', message: ErrorCodes.FORBIDDEN.message, unexpected: false };
  if (isConnectivityError(err)) return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Please retry shortly.', unexpected: false };
  const fe = err as FastifyError;
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status === 429) return { status, code: 'RATE_LIMITED', message: ErrorCodes.RATE_LIMITED.message, unexpected: false };
  if (status >= 400 && status < 500) {
    return { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message: fe.message, unexpected: false };
  }
  return { status: 500, code: 'INTERNAL', message: ErrorCodes.INTERNAL.message, unexpected: true };
}

/**
 * What may reach the logs / error tracker. Drizzle's query errors carry the SQL *and the bound values* (buyer addresses, password
 * hashes, token hashes, ciphertext) in `message` / `params`, and Postgres errors carry row values in `detail`: log the shape of the
 * failure, never the data.
 */
export function scrubError(err: unknown): Record<string, unknown> {
  const e = err as { name?: string; message?: string; stack?: string; code?: string; constraint?: string; table?: string; query?: string; cause?: unknown; statusCode?: number } | null;
  if (!e || typeof e !== 'object') return { message: String(err) };
  const cause = e.cause as { code?: string; constraint?: string; table?: string } | undefined;
  const sqlFailure = typeof e.query === 'string' || (typeof e.message === 'string' && e.message.startsWith('Failed query:'));
  return {
    name: e.name, code: e.code ?? cause?.code, constraint: e.constraint ?? cause?.constraint, table: e.table ?? cause?.table, statusCode: e.statusCode,
    message: sqlFailure ? (e.message ?? '').split('\nparams:')[0] : e.message,
    stack: e.stack ? e.stack.split('\n').filter((l) => !l.startsWith('params:')).slice(0, 12).join('\n') : undefined,
  };
}

/** One error shape for everything: { success:false, error:{code,message,details}, requestId } */
export const errorPlugin = fp<{ tracker: ErrorTracker }>(async (app, opts) => {
  app.setErrorHandler((err, req, reply) => {
    const n = normalize(err);
    if (n.unexpected) {
      req.log.error({ err: scrubError(err) }, 'unhandled error');
      opts.tracker.captureException(scrubError(err), { requestId: req.id, route: req.routeOptions?.url, vendorId: req.ctx?.scope?.kind === 'vendor' ? req.ctx.scope.vendorId : undefined });
    } else if (n.status >= 500) {
      req.log.error({ err: scrubError(err) }, 'server error');
    } else {
      req.log.info({ code: n.code, status: n.status }, 'request rejected');
    }
    if (err instanceof AppError && err.code === 'RATE_LIMITED' && err.details?.retryAfterSeconds) {
      reply.header('retry-after', String(err.details.retryAfterSeconds));
    }
    return reply.status(n.status).send({
      success: false,
      error: { code: n.code, message: n.message, ...(n.details ? { details: n.details } : {}) },
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} not found` },
      requestId: req.id,
    }),
  );
}, { name: 'oms-errors' });
