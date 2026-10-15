import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@oms/config';
import type { Database } from '@oms/database';
import type { Logger } from '@oms/logging';
import type { QueueKey, QueueRegistry, JobEnvelope } from '@oms/messaging';
import type { ConnectorRegistry } from '@oms/marketplace-core';
import type { ObjectStorage } from '@oms/storage';
import { AppError, Errors, type RequestContext, type TenantScope } from '@oms/shared';
import { isEmailVerified, withScope, withSystem, writeAudit, writeOutboxEvent, type AuditEntry, type OutboxEvent, type Tx } from '@oms/database';

// ---------------------------------------------------------------------------------------------
// Module declaration
// ---------------------------------------------------------------------------------------------
export interface ModuleManifest {
  /** kebab-case, equals the folder name under /modules */
  name: string;
  title: string;
  responsibility: string;
  /** tables (or future tables) this module is the sole writer of */
  owns: readonly string[];
  /** modules this module may call synchronously through their public entry point */
  dependsOn: readonly string[];
  /** HTTP prefixes, informational + verified against registered routes */
  api: readonly string[];
  publishes: readonly string[];
  consumes: readonly string[];
  extraction: 'keep' | 'later' | 'early';
}

/** The event as delivered to a consumer (a DomainEvent from @oms/messaging). */
export interface DomainEventLike { id: string; type: string; vendorId: string | null; aggregateType: string; aggregateId: string; payload: unknown; occurredAt: string }

export interface EventConsumer {
  /** event type, e.g. "order.created" */
  event: string;
  /** stable consumer name: idempotency scope + queue consumer id */
  name: string;
  handle(event: DomainEventLike, container: Container): Promise<void>;
}

/** Background job handler. `queue` + `name` form the routing key; unknown jobs fail permanently (no retry storm). */
export interface JobHandler {
  queue: QueueKey;
  name: string;
  handle(envelope: JobEnvelope, container: Container, job: { id?: string; attemptsMade: number }): Promise<void>;
}

export interface ModuleDefinition {
  manifest: ModuleManifest;
  /** Fastify plugin mounted under /api/v1. Every route MUST declare schema (tags, summary, response) and config.access. */
  routes?: FastifyPluginAsync;
  /** Event handlers executed by the worker app. */
  consumers?: EventConsumer[];
  /** Queue job handlers executed by worker / webhook-worker. */
  jobs?: JobHandler[];
}

export const defineModule = (m: ModuleManifest): ModuleManifest => Object.freeze({ ...m });

// ---------------------------------------------------------------------------------------------
// Container: the process-wide dependencies modules may use. Constructed by each app's composition root.
// ---------------------------------------------------------------------------------------------
export interface Container {
  config: AppConfig;
  logger: Logger;
  database: Database;
  queues: QueueRegistry;
  storage: ObjectStorage;
  connectors: ConnectorRegistry;
  mailer: Mailer;
}

// ---------------------------------------------------------------------------------------------
// Route access policy (declared per route in `config.access`; enforced by the API's access hook)
//   'public'        no authentication
//   'authenticated' any valid token, no specific permission
//   { permission }  token + RBAC permission (+ tenant scope resolved)
//   'internal'      operational endpoints (metrics) exempt from documentation; hidden from OpenAPI
// ---------------------------------------------------------------------------------------------
export type RouteAccess = 'public' | 'authenticated' | 'internal' | { permission: string };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
    /** Require + honour the Idempotency-Key header on this route */
    /** true = Idempotency-Key required; 'optional' = honoured when sent (set automatically on every authenticated mutating route) */
    idempotent?: boolean | 'optional';
  }
  interface FastifyInstance {
    container: Container;
  }
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

/** Trusted tenant scope for the current request. Throws 403 when the caller has no tenant context. */
export function requireScope(req: FastifyRequest): TenantScope {
  const scope = req.ctx.scope;
  if (!scope) throw Errors.forbidden();
  return scope;
}

// ---------------------------------------------------------------------------------------------
// Response envelope helpers: handlers return `ok(req, data)` / `paginated(req, ...)`.
// ---------------------------------------------------------------------------------------------
export const ok = <T>(req: FastifyRequest, data: T) => ({ success: true as const, data, requestId: req.id });

export const paginated = <T>(req: FastifyRequest, items: T[], page: { limit: number; nextCursor: string | null }) => ({
  success: true as const,
  data: items,
  meta: { limit: page.limit, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
  requestId: req.id,
});

export const created = <T>(req: FastifyRequest, reply: FastifyReply, data: T, location?: string) => {
  reply.code(201);
  if (location) reply.header('Location', location);
  return ok(req, data);
};

// ---------------------------------------------------------------------------------------------
// Mailer port (verification, password reset, invitations). Providers: log (dev), memory (tests), SMTP/SES later.
// ---------------------------------------------------------------------------------------------
export type MailKind = 'verify_email' | 'reset_password' | 'invitation' | 'notification';
export interface MailMessage {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  /** structured data (e.g. the one-time token) for providers/templates and tests; never logged in production */
  data: { token: string; link: string; [k: string]: unknown }; // notification mails: token = notification id, link = the page to open
}
export interface Mailer { send(message: MailMessage): Promise<void> }

// ---------------------------------------------------------------------------------------------
// Request-scoped data access helpers. These are THE way routes touch tenant data.
// ---------------------------------------------------------------------------------------------
type FastifyReqLike = FastifyRequest;

/** Run `fn` in a transaction with the request's trusted tenant scope applied (RLS-enforced). */
export function scopedTx<T>(req: FastifyReqLike, fn: (tx: Tx, scope: TenantScope) => Promise<T>): Promise<T> {
  const scope = requireScope(req);
  return withScope(req.server.container.database.db, scope, (tx) => fn(tx, scope));
}

/** Like scopedTx but the caller MUST be inside one vendor (vendor user, or platform staff using X-Act-As-Vendor). */
export function vendorTx<T>(req: FastifyReqLike, fn: (tx: Tx, vendorId: string) => Promise<T>): Promise<T> {
  const vendorId = requireVendor(req);
  return withScope(req.server.container.database.db, { kind: 'vendor', vendorId }, (tx) => fn(tx, vendorId));
}

/** Internal/system scope (pre-authentication flows such as login, token refresh, invitation acceptance). */
export function systemTx<T>(req: FastifyReqLike, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSystem(req.server.container.database.db, fn);
}

export function requireVendor(req: FastifyReqLike): string {
  const scope = requireScope(req);
  if (scope.kind !== 'vendor') {
    throw new AppError('BAD_REQUEST', 'This operation needs a vendor context. Platform staff must send X-Act-As-Vendor.');
  }
  return scope.vendorId;
}

/** Audit entry pre-filled from the request (actor, tenant, request id, ip, user agent). */
export function audit(tx: Tx, req: FastifyReqLike, e: Pick<AuditEntry, 'action' | 'resourceType' | 'resourceId' | 'before' | 'after' | 'metadata'> & { vendorId?: string | null }): Promise<void> {
  const p = req.ctx.principal;
  const scope = req.ctx.scope;
  return writeAudit(tx, {
    ...e,
    vendorId: e.vendorId !== undefined ? e.vendorId : scope?.kind === 'vendor' ? scope.vendorId : null,
    actorType: p?.actorType ?? 'system',
    actorId: p?.actorId ?? null,
    onBehalfOfVendorId: p?.actingAsVendorId ?? null,
    requestId: req.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
}

/** Outbox event pre-filled with tenant + correlation id from the request. */
export function emit(tx: Tx, req: FastifyReqLike, e: Omit<OutboxEvent, 'vendorId' | 'correlationId'> & { vendorId?: string | null }): Promise<string> {
  const scope = req.ctx.scope;
  return writeOutboxEvent(tx, {
    ...e,
    vendorId: e.vendorId !== undefined ? e.vendorId : scope?.kind === 'vendor' ? scope.vendorId : null,
    correlationId: req.ctx.correlationId,
  });
}

/** Enforces the "verified e-mail required" policy for sensitive actions (invites, marketplace connections). */
export async function assertEmailVerified(req: FastifyReqLike, tx: Tx): Promise<void> {
  if (!req.server.container.config.EMAIL_VERIFICATION_REQUIRED) return;
  const p = req.ctx.principal;
  if (!p || p.userType === 'platform') return;
  if (!(await isEmailVerified(tx, p.actorId))) throw new AppError('EMAIL_NOT_VERIFIED');
}
export { LogMailer, MemoryMailer } from './mailers';

/**
 * Stricter per-route limiter (login, refresh, password reset...), counted separately from the global limiter.
 * (The rate-limit plugin runs only ONE handler-style limiter per request, so this uses the programmatic API.)
 */
export function strictRateLimit(app: import('fastify').FastifyInstance, max: number, timeWindow = '1 minute') {
  type Check = (req: FastifyRequest) => Promise<{ isAllowed: boolean; isExceeded?: boolean; ttlInSeconds?: number; max?: number }>;
  const check = (app as unknown as { createRateLimit: (o: object) => Check }).createRateLimit({
    max,
    timeWindow,
    keyGenerator: (req: FastifyRequest) => `strict:${req.ip}:${req.routeOptions.url}`,
  });
  return async (req: FastifyRequest): Promise<void> => {
    const res = await check(req);
    // isAllowed=true means allow-listed; otherwise the request was counted and may have exceeded the limit
    if (!res.isAllowed && res.isExceeded) throw new AppError('RATE_LIMITED', undefined, { details: { limit: res.max ?? max, retryAfterSeconds: res.ttlInSeconds ?? 60 } });
  };
}
export { opCtxFromRequest, systemOpCtx, effects, type OpCtx, type Effects as OpEffects } from './opctx';
