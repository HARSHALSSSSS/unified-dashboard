import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { AppError } from '@oms/shared';

export type IdempotencyBegin =
  | { state: 'new' }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

export interface IdempotencyKeyRef { vendorId: string | null; scope: string; key: string }

export interface IdempotencyStore {
  begin(ref: IdempotencyKeyRef & { requestHash: string; ttlSeconds: number }): Promise<IdempotencyBegin>;
  complete(ref: IdempotencyKeyRef & { status: number; body: unknown }): Promise<void>;
  release(ref: IdempotencyKeyRef): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, { hash: string; status?: number; body?: unknown; exp: number }>();
  private k = (r: IdempotencyKeyRef) => `${r.vendorId ?? '-'}|${r.scope}|${r.key}`;

  async begin(r: IdempotencyKeyRef & { requestHash: string; ttlSeconds: number }): Promise<IdempotencyBegin> {
    const existing = this.rows.get(this.k(r));
    if (existing && existing.exp > Date.now()) {
      if (existing.hash !== r.requestHash) return { state: 'mismatch' };
      return existing.status === undefined ? { state: 'in_progress' } : { state: 'replay', status: existing.status, body: existing.body };
    }
    this.rows.set(this.k(r), { hash: r.requestHash, exp: Date.now() + r.ttlSeconds * 1000 });
    return { state: 'new' };
  }
  async complete(r: IdempotencyKeyRef & { status: number; body: unknown }): Promise<void> {
    const row = this.rows.get(this.k(r));
    if (row) { row.status = r.status; row.body = r.body; }
  }
  async release(r: IdempotencyKeyRef): Promise<void> {
    this.rows.delete(this.k(r));
  }
}

declare module 'fastify' {
  interface FastifyRequest { idempotency?: IdempotencyKeyRef }
}

const TTL_SECONDS = 24 * 3600;

/**
 * `Idempotency-Key` support for routes declaring `config: { idempotent: true }`.
 *  - key is mandatory on those routes (400 otherwise)
 *  - same key + same request  -> original response replayed (header `Idempotency-Replayed: true`)
 *  - same key + other request -> 422 IDEMPOTENCY_KEY_REUSED
 *  - same key still running   -> 409 IDEMPOTENCY_IN_PROGRESS
 *  - 5xx responses are NOT stored (the client may safely retry); 2xx/4xx are.
 * Keys are scoped by (vendor, METHOD route-template), so two tenants can never collide.
 */
export const idempotencyPlugin = fp<{ store: IdempotencyStore }>(async (app, { store }) => {
  app.addHook('preHandler', async (req, reply) => {
    const mode = req.routeOptions.config?.idempotent;
    if (req.is404 || !mode) return;
    const key = req.headers['idempotency-key'];
    if (mode === 'optional' && key === undefined) return; // supported, not required: a client that sends the header gets replay protection
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new AppError('BAD_REQUEST', 'Idempotency-Key header (8-128 chars) is required for this operation');
    }
    const scope = req.ctx.scope;
    const ref: IdempotencyKeyRef = {
      vendorId: scope?.kind === 'vendor' ? scope.vendorId : null,
      scope: `${req.method} ${req.routeOptions.url}`,
      key,
    };
    const requestHash = createHash('sha256').update(JSON.stringify({ a: req.ctx.principal?.actorId ?? null, b: req.body ?? null, q: req.query ?? null, p: req.params ?? null })).digest('hex');
    const result = await store.begin({ ...ref, requestHash, ttlSeconds: TTL_SECONDS });
    switch (result.state) {
      case 'new':
        req.idempotency = ref;
        return;
      case 'replay':
        reply.header('idempotency-replayed', 'true').code(result.status).send(result.body);
        return reply;
      case 'in_progress':
        throw new AppError('IDEMPOTENCY_IN_PROGRESS');
      case 'mismatch':
        throw new AppError('IDEMPOTENCY_KEY_REUSED');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const ref = req.idempotency;
    if (!ref) return payload;
    req.idempotency = undefined;
    try {
      if (reply.statusCode >= 500) await store.release(ref);
      else await store.complete({ ...ref, status: reply.statusCode, body: typeof payload === 'string' ? JSON.parse(payload) : null });
    } catch (e) {
      req.log.error({ err: e }, 'failed to finalise idempotency record');
    }
    return payload;
  });
}, { name: 'oms-idempotency' });
