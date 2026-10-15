import { and, desc, eq, schema, sql, writeAudit, writeOutboxEvent, withVendor, isFeatureEnabled, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { z } from 'zod';
import type { Container, DomainEventLike } from '@oms/module-kit';
import { systemOpCtx } from '@oms/module-kit';
import { AI_ACTIONS, createRecommendation } from '@oms/mod-ai';
import { Work, cancelFulfillment, startFulfillment } from '@oms/mod-fulfillment';
import { notifyVendor } from '@oms/mod-notifications';
import { matches, OPS, type ConditionSet, type Facts } from '@oms/mod-rules';
import { getSyncJobRow, resetForManualRetry } from '@oms/mod-sync';

const RULE = schema.automationRules;
const EX = schema.automationExecutions;
export type RuleRow = typeof RULE.$inferSelect;
export type ExecutionRow = typeof EX.$inferSelect;

// ------------------------------------------------------------------------------------------------
// triggers: the domain events a rule can listen to, with the facts each one offers
// ------------------------------------------------------------------------------------------------
export const TRIGGERS: Record<string, { description: string; facts: string[] }> = {
  'order.created': { description: 'A marketplace order arrived and stock was reserved', facts: ['orderNumber', 'marketplace', 'totalMinor', 'status'] },
  'order.needs_attention': { description: 'An order needs a person (unmapped SKU, short stock, short pick)', facts: ['reason', 'orderItemId', 'quantity'] },
  'order.cancellation_requested': { description: 'Someone asked to cancel an order', facts: ['orderNumber', 'initiator', 'reasonCode', 'orderStatus'] },
  'inventory.low_stock': { description: 'Available stock fell to / below the reorder level', facts: ['variantId', 'warehouseId', 'available', 'reorderLevel'] },
  'sync.failed': { description: 'A marketplace sync job failed (it will retry)', facts: ['type', 'accountId', 'error', 'attempts'] },
  'sync.dead_lettered': { description: 'A sync job gave up', facts: ['type', 'accountId', 'error', 'attempts'] },
  'listing.failed': { description: 'A marketplace rejected a listing', facts: ['sku', 'externalSku', 'reason', 'error'] },
  'return.received': { description: 'A return arrived at a warehouse', facts: ['number', 'orderId', 'units', 'source', 'warehouseId'] },
  'marketplace_account.disconnected': { description: 'A marketplace account was disconnected', facts: [] },
  'marketplace_account.authorization_expired': { description: 'A marketplace authorisation expired', facts: [] },
  'fulfillment.exception_raised': { description: 'A warehouse exception was raised', facts: ['number', 'kind', 'warehouseId'] },
  'shipment.ndr_raised': { description: 'A delivery attempt failed', facts: ['number', 'attemptNo', 'reason'] },
  'shipment.rto_started': { description: 'A shipment is returning to origin', facts: ['number'] },
};

/** payload -> facts the conditions can test: top-level scalars, one nested level as `a.b`, plus eventType */
export function factsOf(e: { type: string; payload: unknown; aggregateId?: string }): Facts {
  const out: Facts = { eventType: e.type, aggregateId: e.aggregateId };
  const walk = (o: unknown, prefix: string, depth: number) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[key] = v as string | number | boolean | null;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = v as string[];
      else if (depth < 1) walk(v, key, depth + 1);
    }
  };
  walk(e.payload, '', 0);
  return out;
}

/** `{{field}}` in a template is replaced by the fact (unknown facts become empty); output is length-bounded and single-line */
export const render = (tpl: string, facts: Facts): string => tpl.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, k: string) => String(facts[k] ?? '')).replace(/[\r\n]+/g, ' ').slice(0, 300);

// ------------------------------------------------------------------------------------------------
// actions: a closed whitelist; each validates its params, runs inside the module APIs, and says how to undo itself (when it can)
// ------------------------------------------------------------------------------------------------
interface RunCtx { c: Container; tx: Tx; vendorId: string; facts: Facts; event: { id: string; type: string; aggregateId: string }; work: Work; ruleId: string; /** side effects that must run AFTER this transaction commits (they open their own transactions) */ after: Array<() => Promise<unknown>> }
interface ActionDef { description: string; triggers: string[] | '*'; schema: z.ZodType<Record<string, unknown>>; run(x: RunCtx, params: Record<string, unknown>): Promise<{ result: Record<string, unknown>; rollback?: Record<string, unknown> }>; undo?(x: Pick<RunCtx, 'c' | 'tx' | 'vendorId'>, rollback: Record<string, unknown>, work: Work): Promise<void> }

const Sev = z.enum(['info', 'warning', 'critical']);
export const ACTIONS: Record<string, ActionDef> = {
  notify: {
    description: 'Tell the team (in-app, plus e-mail / push by severity). Templates may use {{fact}} placeholders.', triggers: '*',
    schema: z.object({ title: z.string().min(2).max(200), body: z.string().max(500).optional(), severity: Sev.default('info') }),
    async run(x, p) {
      const input = { type: 'automation.notice', severity: p.severity as 'info', title: render(String(p.title), x.facts), body: p.body ? render(String(p.body), x.facts) : null, dedupeKey: `automation:${x.ruleId}:${x.event.id}` };
      x.after.push(() => notifyVendor(x.c, x.vendorId, input)); // after commit: it has its own transactions
      return { result: { queued: true, title: input.title } };
    },
  },
  create_recommendation: {
    description: 'Create a recommendation for a person to review (optionally with a whitelisted action to approve).', triggers: '*',
    schema: z.object({ kind: z.string().min(2).max(40).default('automation'), title: z.string().min(2).max(200), summary: z.string().max(500).default(''), severity: Sev.default('info') }),
    async run(x, p) {
      const r = await createRecommendation(x.tx, x.vendorId, { kind: String(p.kind), severity: p.severity as 'info', title: render(String(p.title), x.facts), summary: render(String(p.summary ?? ''), x.facts) || 'Created by an automation rule', evidence: { ruleId: x.ruleId, eventId: x.event.id, eventType: x.event.type }, source: 'automation', dedupeKey: `auto:${x.ruleId}:${x.event.id}` });
      return { result: { recommendationId: r.recommendation?.id ?? null, created: r.created } };
    },
  },
  retry_sync_job: {
    description: 'Re-queue the failed sync job from the event (max 5 automatic retries per job).', triggers: ['sync.failed', 'sync.dead_lettered'],
    schema: z.object({ maxAutomaticRetries: z.number().int().min(1).max(5).default(3) }),
    async run(x, p) {
      const job = await getSyncJobRow(x.tx, x.vendorId, x.event.aggregateId);
      const done = Number((job.stats as Record<string, number>).manualRetries ?? 0);
      if (done >= Number(p.maxAutomaticRetries)) throw new AppError('CONFLICT', `Already retried ${done} time(s); a person has to look at this job`, { details: { rule: 'retry_budget' } });
      const j = await resetForManualRetry(x.tx, x.vendorId, job.id, 'automation');
      x.work.add(j); // dispatched after the transaction commits
      return { result: { jobId: j.id, retried: done + 1 } };
    },
  },
  start_fulfillment: {
    description: 'Route the new order to a warehouse and create its fulfillment (stock is already reserved). Reversible until picking starts.', triggers: ['order.created'],
    schema: z.object({ maxOrderValueMinor: z.number().int().min(0).optional() }),
    async run(x, p) {
      if (p.maxOrderValueMinor !== undefined && Number(x.facts.totalMinor ?? 0) > Number(p.maxOrderValueMinor)) throw new AppError('CONFLICT', 'Order value is above the automatic limit: a person must start it', { details: { rule: 'above_limit' } });
      const ctx = systemOpCtx(x.c, x.vendorId, 'automation');
      const res = await startFulfillment(x.tx, ctx, x.work, x.event.aggregateId, {});
      return { result: { fulfillmentIds: res.fulfillments.map((f) => f.id), warehouses: res.fulfillments.map((f) => f.warehouseId) }, rollback: { fulfillmentIds: res.fulfillments.map((f) => f.id) } };
    },
    async undo(x, rb, work) {
      const ctx = systemOpCtx(x.c, x.vendorId, 'automation');
      for (const id of (rb.fulfillmentIds as string[]) ?? []) await cancelFulfillment(x.tx, ctx, work, id, 'automation rolled back');
    },
  },
  set_reorder_level: {
    description: 'Set the reorder level of the variant / warehouse in the event (needs a level). Reversible.', triggers: ['inventory.low_stock'],
    schema: z.object({ level: z.number().int().min(0).max(1_000_000) }),
    async run(x, p) {
      const variantId = String(x.facts.variantId ?? '');
      const warehouseId = String(x.facts.warehouseId ?? '');
      if (!variantId || !warehouseId) throw new AppError('BAD_REQUEST', 'The event has no variant / warehouse');
      return AI_ACTIONS.set_reorder_level!.apply(x.tx, x.vendorId, { variantId, warehouseId, level: p.level }, { type: 'system', id: 'automation' });
    },
    async undo(x, rb) { await AI_ACTIONS.set_reorder_level!.undo(x.tx, x.vendorId, rb, { type: 'system', id: 'automation' }); },
  },
};

// ------------------------------------------------------------------------------------------------
// rules
// ------------------------------------------------------------------------------------------------
const FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,60}$/;
export function validateRule(input: { triggerEvent: string; conditions: ConditionSet; action: { type: string; params: Record<string, unknown> } }): Record<string, unknown> {
  if (!TRIGGERS[input.triggerEvent]) throw new AppError('BAD_REQUEST', 'Unknown trigger event', { details: { allowed: Object.keys(TRIGGERS) } });
  for (const c of input.conditions.conditions) {
    if (!FIELD.test(c.field)) throw new AppError('BAD_REQUEST', `Invalid condition field "${c.field}"`, { details: { rule: 'condition_field' } });
    if (!(OPS as readonly string[]).includes(c.op)) throw new AppError('BAD_REQUEST', `Unknown operator "${c.op}"`, { details: { allowed: OPS } });
  }
  const def = ACTIONS[input.action.type];
  if (!def) throw new AppError('BAD_REQUEST', 'Unknown action type', { details: { allowed: Object.keys(ACTIONS) } });
  if (def.triggers !== '*' && !def.triggers.includes(input.triggerEvent)) throw new AppError('BAD_REQUEST', `The action "${input.action.type}" cannot be used with the trigger "${input.triggerEvent}"`, { details: { actionTriggers: def.triggers } });
  const parsed = def.schema.safeParse(input.action.params);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Invalid action parameters', { details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  return parsed.data;
}

export const toRuleDto = (r: RuleRow) => ({ id: r.id, name: r.name, description: r.description, triggerEvent: r.triggerEvent, conditions: r.conditions, action: r.action, mode: r.mode as (typeof schema.AUTOMATION_MODES)[number], status: r.status as (typeof schema.AUTOMATION_RULE_STATUSES)[number], version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });
export const toExecutionDto = (e: ExecutionRow) => ({ id: e.id, ruleId: e.ruleId, eventId: e.eventId, eventType: e.eventType, status: e.status as (typeof schema.AUTOMATION_EXECUTION_STATUSES)[number], actionType: e.actionType, actionParams: e.actionParams, facts: e.facts, result: e.result, error: e.error, canRollback: e.status === 'executed' && Boolean(e.rollback), decidedBy: e.decidedBy, decidedAt: e.decidedAt ? e.decidedAt.toISOString() : null, executedAt: e.executedAt ? e.executedAt.toISOString() : null, createdAt: e.createdAt.toISOString() });

export async function getRule(tx: Tx, vendorId: string, id: string): Promise<RuleRow> {
  const [r] = await tx.select().from(RULE).where(and(eq(RULE.id, id), eq(RULE.vendorId, vendorId)));
  if (!r) throw Errors.notFound('Automation rule', id);
  return r;
}
export async function getExecution(tx: Tx, vendorId: string, id: string, lock = false): Promise<ExecutionRow> {
  const q = tx.select().from(EX).where(and(eq(EX.id, id), eq(EX.vendorId, vendorId)));
  const [e] = await (lock ? q.for('update') : q);
  if (!e) throw Errors.notFound('Execution', id);
  return e;
}
export async function listExecutions(tx: Tx, vendorId: string, q: { status?: string; ruleId?: string; limit: number }) {
  return (await tx.select().from(EX).where(and(eq(EX.vendorId, vendorId), q.status ? eq(EX.status, q.status) : undefined, q.ruleId ? eq(EX.ruleId, q.ruleId) : undefined)).orderBy(desc(EX.createdAt)).limit(q.limit)).map(toExecutionDto);
}

/** what WOULD happen for an event payload (nothing is changed) */
export function dryRun(rule: Pick<RuleRow, 'triggerEvent' | 'conditions' | 'action' | 'mode'>, payload: Record<string, unknown>) {
  const facts = factsOf({ type: rule.triggerEvent, payload });
  const matched = matches(rule.conditions as ConditionSet, facts);
  return { matched, facts, wouldDo: matched ? { action: rule.action.type, params: rule.action.params, needsApproval: rule.mode === 'approval' } : null };
}

// ------------------------------------------------------------------------------------------------
// running
// ------------------------------------------------------------------------------------------------
const MAX_PER_RULE_PER_HOUR = 120;

/** a domain event: every active rule that listens to it and matches runs (or waits for approval). At most once per (rule, event). */
export async function handleEvent(c: Container, e: DomainEventLike): Promise<number> {
  const vendorId = e.vendorId;
  if (!vendorId || !TRIGGERS[e.type]) return 0;
  const pendingRuns: string[] = [];
  await withVendor(c.database.db, vendorId, async (tx) => {
    if (!(await isFeatureEnabled(tx, 'automation.enabled', vendorId, true))) return;
    const rules = await tx.select().from(RULE).where(and(eq(RULE.vendorId, vendorId), eq(RULE.triggerEvent, e.type), eq(RULE.status, 'active')));
    if (rules.length === 0) return;
    const facts = factsOf({ type: e.type, payload: e.payload, aggregateId: e.aggregateId });
    for (const rule of rules) {
      if (!matches(rule.conditions as ConditionSet, facts)) continue;
      const [recent] = await tx.select({ n: sql<number>`count(*)::int` }).from(EX).where(and(eq(EX.ruleId, rule.id), sql`${EX.createdAt} > now() - interval '1 hour'`));
      const throttled = (recent?.n ?? 0) >= MAX_PER_RULE_PER_HOUR;
      const [row] = await tx.insert(EX).values({ vendorId, ruleId: rule.id, eventId: e.id, eventType: e.type, status: throttled ? 'skipped' : 'pending_approval', facts: facts as Record<string, unknown>, actionType: rule.action.type, actionParams: rule.action.params, error: throttled ? 'rate limit: too many executions of this rule in the last hour' : null }).onConflictDoNothing().returning();
      if (!row || throttled) continue;
      if (rule.mode === 'auto') pendingRuns.push(row.id);
      else await writeOutboxEvent(tx, { type: 'automation.approval_requested', vendorId, aggregateType: 'automation_execution', aggregateId: row.id, payload: { ruleId: rule.id, rule: rule.name, action: rule.action.type } });
    }
  });
  for (const id of pendingRuns) await executeExecution(c, vendorId, id, { type: 'system', id: 'automation' }).catch((err) => c.logger.warn({ executionId: id, err: (err as Error).message }, 'automation run failed'));
  return pendingRuns.length;
}

/** runs a pending execution (auto rules at once; approval rules when a person approves). Marketplace pushes dispatch after commit. */
export async function executeExecution(c: Container, vendorId: string, id: string, by: { type: 'user' | 'system'; id: string | null }) {
  const work = new Work();
  const after: Array<() => Promise<unknown>> = [];
  const out = await withVendor(c.database.db, vendorId, async (tx) => {
    const ex = await getExecution(tx, vendorId, id, true);
    if (ex.status !== 'pending_approval') throw new AppError('INVALID_STATE', `This execution is ${ex.status}`, { details: { status: ex.status } });
    const def = ACTIONS[ex.actionType];
    let status: ExecutionRow['status'] = 'executed';
    let result: Record<string, unknown> | null = null;
    let rollback: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      if (!def) throw new AppError('BAD_REQUEST', 'Unknown action type');
      const r = await tx.transaction((sp) => def.run({ c, tx: sp, vendorId, facts: ex.facts as Facts, event: { id: ex.eventId, type: ex.eventType, aggregateId: String((ex.facts as { aggregateId?: string }).aggregateId ?? '') }, work, ruleId: ex.ruleId, after }, def.schema.parse(ex.actionParams)));
      result = r.result; rollback = r.rollback ?? null;
    } catch (e) { status = 'failed'; error = (e instanceof Error ? e.message : 'failed').slice(0, 300); }
    const [row] = await tx.update(EX).set({ status, result, rollback, error, decidedBy: by.id, decidedAt: new Date(), executedAt: status === 'executed' ? new Date() : null }).where(eq(EX.id, id)).returning();
    await writeAudit(tx, { vendorId, actorType: by.type, actorId: by.id, action: status === 'executed' ? 'automation.executed' : 'automation.failed', resourceType: 'automation_execution', resourceId: id, after: { rule: ex.ruleId, action: ex.actionType, result, error } });
    await writeOutboxEvent(tx, { type: 'automation.rule_fired', vendorId, aggregateType: 'automation_execution', aggregateId: id, payload: { ruleId: ex.ruleId, action: ex.actionType, status } });
    return toExecutionDto(row!);
  });
  await work.flush(c);
  for (const f of after) await f().catch((err) => c.logger.warn({ err: (err as Error).message }, 'automation follow-up failed'));
  return out;
}

export async function rejectExecution(tx: Tx, vendorId: string, id: string, by: { id: string | null }, note?: string | null) {
  const ex = await getExecution(tx, vendorId, id, true);
  if (ex.status !== 'pending_approval') throw new AppError('INVALID_STATE', `This execution is ${ex.status}`, { details: { status: ex.status } });
  const [after] = await tx.update(EX).set({ status: 'rejected', decidedBy: by.id, decidedAt: new Date(), error: note ?? null }).where(eq(EX.id, id)).returning();
  await writeAudit(tx, { vendorId, actorType: 'user', actorId: by.id, action: 'automation.rejected', resourceType: 'automation_execution', resourceId: id, metadata: { note: note ?? null } });
  return toExecutionDto(after!);
}

export async function rollbackExecution(c: Container, vendorId: string, id: string, by: { id: string | null }) {
  const work = new Work();
  const out = await withVendor(c.database.db, vendorId, async (tx) => {
    const ex = await getExecution(tx, vendorId, id, true);
    const def = ACTIONS[ex.actionType];
    if (ex.status !== 'executed' || !ex.rollback || !def?.undo) throw new AppError('INVALID_STATE', 'Only an executed, reversible action can be rolled back', { details: { status: ex.status, reversible: Boolean(def?.undo) } });
    await def.undo({ c, tx, vendorId }, ex.rollback, work);
    const [after] = await tx.update(EX).set({ status: 'rolled_back' }).where(eq(EX.id, id)).returning();
    await writeAudit(tx, { vendorId, actorType: 'user', actorId: by.id, action: 'automation.rolled_back', resourceType: 'automation_execution', resourceId: id, after: { restored: ex.rollback } });
    return toExecutionDto(after!);
  });
  await work.flush(c);
  return out;
}
