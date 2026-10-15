import type { FastifyRequest } from 'fastify';
import { audit, emit } from '@oms/module-kit';
import { writeAudit, writeOutboxEvent, type Tx } from '@oms/database';

/**
 * Side effects of a catalog use-case (outbox event + audit record), injected so the SAME service code runs from
 * HTTP routes (actor = the request principal) and from background jobs (actor = system / job requester).
 * Both are written in the caller's transaction, so they commit or roll back together with the change.
 */
export interface Effects {
  event(e: { type: string; aggregateType: string; aggregateId: string; payload?: Record<string, unknown> }): Promise<void>;
  audit(e: { action: string; resourceType: string; resourceId: string; before?: unknown; after?: unknown; metadata?: Record<string, unknown> }): Promise<void>;
}

export function requestEffects(tx: Tx, req: FastifyRequest): Effects {
  return {
    event: async (e) => void (await emit(tx, req, { type: e.type, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload ?? {} })),
    audit: (e) => audit(tx, req, e),
  };
}

export function jobEffects(tx: Tx, ctx: { vendorId: string; correlationId: string; actorId?: string | null; jobId: string }): Effects {
  return {
    event: async (e) => void (await writeOutboxEvent(tx, { type: e.type, vendorId: ctx.vendorId, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload ?? {}, correlationId: ctx.correlationId })),
    audit: (e) => writeAudit(tx, { vendorId: ctx.vendorId, actorType: ctx.actorId ? 'user' : 'system', actorId: ctx.actorId ?? 'catalog-job', requestId: ctx.correlationId, ...e, metadata: { ...e.metadata, jobId: ctx.jobId } }),
  };
}
