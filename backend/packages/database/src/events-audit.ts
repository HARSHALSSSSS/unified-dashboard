import { eq } from 'drizzle-orm';
import { getContext } from '@oms/logging';
import { newId } from '@oms/shared';
import type { Tx } from './client';
import * as schema from './schema';

export interface AuditEntry {
  /** tenant the action happened in (null = platform-level) */
  vendorId: string | null;
  actorType: 'user' | 'api_key' | 'system' | 'webhook';
  actorId?: string | null;
  onBehalfOfVendorId?: string | null;
  /** dotted verb, e.g. product.update, auth.login_failed */
  action: string;
  /** where it came from; defaults from the actor type (user/api_key -> api, webhook -> webhook, system -> job) */
  source?: 'api' | 'webhook' | 'job' | 'system' | 'marketplace';
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  /** redacted snapshots: NEVER put passwords, tokens or credentials here */
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Append an audit record in the caller's transaction (so it commits/rolls back with the change it describes). */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    vendorId: e.vendorId,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    onBehalfOfVendorId: e.onBehalfOfVendorId ?? null,
    action: e.action,
    source: e.source ?? (e.actorType === 'webhook' ? 'webhook' : e.actorType === 'system' ? 'job' : 'api'),
    resourceType: e.resourceType ?? null,
    resourceId: e.resourceId ?? null,
    requestId: e.requestId ?? getContext().requestId ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    before: (e.before ?? null) as never,
    after: (e.after ?? null) as never,
    metadata: e.metadata ?? {},
  });
}

export interface OutboxEvent {
  /** e.g. "product.created" (must be declared in the owning module manifest `publishes`) */
  type: string;
  vendorId: string | null;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

/** Transactional outbox: the event exists iff the surrounding transaction commits. Relayed by apps/worker. */
export async function writeOutboxEvent(tx: Tx, e: OutboxEvent): Promise<string> {
  const id = newId();
  await tx.insert(schema.outboxEvents).values({
    id,
    vendorId: e.vendorId,
    type: e.type,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    payload: e.payload as never,
    correlationId: e.correlationId ?? getContext().correlationId ?? id,
  });
  return id;
}

/** Whether a user's e-mail address has been verified (used to gate invitations and marketplace connections). */
export async function isEmailVerified(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx.select({ at: schema.users.emailVerifiedAt }).from(schema.users).where(eq(schema.users.id, userId));
  return Boolean(row?.at);
}
