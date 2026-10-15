import type { FastifyRequest } from 'fastify';
import { writeAudit, writeOutboxEvent, type Tx } from '@oms/database';
import type { Container } from './index';

/**
 * Who is acting and where, for use-cases that run OUTSIDE a single request transaction (they call marketplaces between
 * short transactions - a database transaction must never span a network call) and from background jobs.
 */
export interface OpCtx {
  c: Container;
  vendorId: string;
  actor: { type: 'user' | 'api_key' | 'system' | 'webhook'; id: string | null };
  requestId?: string;
  correlationId?: string;
  ip?: string;
  userAgent?: string;
  onBehalfOfVendorId?: string | null;
}

export const opCtxFromRequest = (req: FastifyRequest, vendorId: string): OpCtx => ({
  c: req.server.container, vendorId, actor: { type: req.ctx.principal?.actorType ?? 'system', id: req.ctx.principal?.actorId ?? null },
  requestId: req.id, correlationId: req.ctx.correlationId, ip: req.ip, userAgent: req.headers['user-agent'], onBehalfOfVendorId: req.ctx.principal?.actingAsVendorId ?? null,
});

export const systemOpCtx = (c: Container, vendorId: string, who: string, actor: OpCtx['actor']['type'] = 'system'): OpCtx => ({ c, vendorId, actor: { type: actor, id: who } });

export interface Effects {
  event(e: { type: string; aggregateType: string; aggregateId: string; payload?: Record<string, unknown> }): Promise<void>;
  audit(e: { action: string; resourceType: string; resourceId: string; before?: unknown; after?: unknown; metadata?: Record<string, unknown> }): Promise<void>;
}

/** outbox event + audit record in the caller's transaction (they commit or roll back together with the change) */
export function effects(tx: Tx, ctx: OpCtx): Effects {
  return {
    event: async (e) => void (await writeOutboxEvent(tx, { type: e.type, vendorId: ctx.vendorId, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload ?? {}, correlationId: ctx.correlationId })),
    audit: (e) => writeAudit(tx, {
      vendorId: ctx.vendorId, actorType: ctx.actor.type, actorId: ctx.actor.id, onBehalfOfVendorId: ctx.onBehalfOfVendorId ?? null, requestId: ctx.requestId ?? ctx.correlationId, ip: ctx.ip, userAgent: ctx.userAgent, ...e,
    }),
  };
}
