import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isFeatureEnabled, schema, sql, type Tx } from '@oms/database';
import { AppError } from '@oms/shared';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { audit, created, ok, vendorTx } from '@oms/module-kit';
import { OPS } from '@oms/mod-rules';
import { ACTIONS, TRIGGERS, dryRun, executeExecution, getExecution, getRule, listExecutions, rejectExecution, rollbackExecution, toExecutionDto, toRuleDto, validateRule } from './engine';

const TAGS = ['Automation'];
const Conditions = z.object({ combinator: z.enum(['all', 'any']).default('all'), conditions: z.array(z.object({ field: z.string().min(1).max(61), op: z.enum(OPS), value: z.unknown().optional() })).max(20) });
const ConditionsOut = z.object({ combinator: z.enum(['all', 'any']), conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })) });
const Action = z.object({ type: z.string().min(2).max(40), params: z.record(z.string(), z.unknown()).default({}) });
const Rule = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), triggerEvent: z.string(), conditions: ConditionsOut, action: Action, mode: z.enum(schema.AUTOMATION_MODES), status: z.enum(schema.AUTOMATION_RULE_STATUSES), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate }).meta({ id: 'AutomationRule' });
const Execution = z.object({ id: z.string(), ruleId: z.string(), eventId: z.string(), eventType: z.string(), status: z.enum(schema.AUTOMATION_EXECUTION_STATUSES), actionType: z.string(), actionParams: z.record(z.string(), z.unknown()), facts: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()).nullable(), error: z.string().nullable(), canRollback: z.boolean(), decidedBy: z.string().nullable(), decidedAt: IsoDate.nullable(), executedAt: IsoDate.nullable(), createdAt: IsoDate }).meta({ id: 'AutomationExecution' });
const CreateBody = z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(500).nullish(), triggerEvent: z.string().min(3).max(80), conditions: Conditions.default({ combinator: 'all', conditions: [] }), action: Action, mode: z.enum(schema.AUTOMATION_MODES).default('approval'), status: z.enum(schema.AUTOMATION_RULE_STATUSES).default('draft') });

/**
 * Automation: vendor rules `trigger event -> conditions -> whitelisted action`. Default mode is `approval` (a person approves every run);
 * `auto` runs by itself. Every run is recorded, at most once per (rule, event), throttled, audited and (where the action allows) reversible.
 */
export const automationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const actor = (req: FastifyRequest) => ({ type: 'user' as const, id: req.ctx.principal?.actorId ?? null });
  const vendorOf = (req: FastifyRequest): string => { const s = req.ctx.scope; if (!s || s.kind !== 'vendor') throw new AppError('FORBIDDEN'); return s.vendorId; };
  const gate = async (tx: Tx, vendorId: string) => { if (!(await isFeatureEnabled(tx, 'automation.enabled', vendorId, true))) throw new AppError('FORBIDDEN', 'Automation is not enabled for this business', { details: { rule: 'feature_disabled', flag: 'automation.enabled' } }); };

  r.get('/automation/catalog', {
    config: { access: { permission: 'automation:read' } },
    schema: { tags: TAGS, summary: 'Triggers and actions available to rules', description: 'Everything a rule can listen to and do. Nothing else exists: no scripts.', response: { 200: successEnvelope(z.object({ triggers: z.array(z.object({ event: z.string(), description: z.string(), facts: z.array(z.string()) })), actions: z.array(z.object({ type: z.string(), description: z.string(), triggers: z.union([z.literal('*'), z.array(z.string())]), reversible: z.boolean() })), operators: z.array(z.string()) })) } },
  }, async (req) => ok(req, { triggers: Object.entries(TRIGGERS).map(([event, t]) => ({ event, ...t })), actions: Object.entries(ACTIONS).map(([type, a]) => ({ type, description: a.description, triggers: a.triggers, reversible: Boolean(a.undo) })), operators: [...OPS] }));

  r.post('/automation/rules', {
    config: { access: { permission: 'automation:write' } },
    schema: { tags: TAGS, summary: 'Create a rule', description: 'Validated: known trigger, condition fields / operators, an action that fits the trigger, and valid action parameters. Created as a draft unless `status` says otherwise.', body: CreateBody, response: { 201: successEnvelope(Rule) } },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      await gate(tx, vendorId);
      const params = validateRule(req.body);
      const [row] = await tx.insert(schema.automationRules).values({ vendorId, name: req.body.name, description: req.body.description ?? null, triggerEvent: req.body.triggerEvent, conditions: req.body.conditions as never, action: { type: req.body.action.type, params }, mode: req.body.mode, status: req.body.status, createdBy: req.ctx.principal?.actorId ?? null }).returning();
      await audit(tx, req, { action: 'automation.rule_created', resourceType: 'automation_rule', resourceId: row!.id, after: { name: row!.name, trigger: row!.triggerEvent, action: row!.action.type, mode: row!.mode, status: row!.status } });
      return toRuleDto(row!);
    });
    return created(req, reply, dto, `/api/v1/automation/rules/${dto.id}`);
  });

  r.get('/automation/rules', {
    config: { access: { permission: 'automation:read' } },
    schema: { tags: TAGS, summary: 'List rules', querystring: z.object({ 'filter[status]': z.enum(schema.AUTOMATION_RULE_STATUSES).optional(), 'filter[trigger]': z.string().max(80).optional() }), response: { 200: successEnvelope(z.array(Rule)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => tx.select().from(schema.automationRules).where(and(eq(schema.automationRules.vendorId, vendorId), req.query['filter[status]'] ? eq(schema.automationRules.status, req.query['filter[status]']) : undefined, req.query['filter[trigger]'] ? eq(schema.automationRules.triggerEvent, req.query['filter[trigger]']) : undefined)).orderBy(schema.automationRules.createdAt).limit(200))).map(toRuleDto)));

  r.get('/automation/rules/:id', {
    config: { access: { permission: 'automation:read' } },
    schema: { tags: TAGS, summary: 'Get a rule', params: IdParamSchema, response: { 200: successEnvelope(Rule) } },
  }, async (req) => ok(req, toRuleDto(await vendorTx(req, (tx, vendorId) => getRule(tx, vendorId, req.params.id)))));

  r.patch('/automation/rules/:id', {
    config: { access: { permission: 'automation:write' } },
    schema: { tags: TAGS, summary: 'Change a rule', params: IdParamSchema, body: CreateBody.partial().extend({ version: z.number().int().optional() }), response: { 200: successEnvelope(Rule) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    await gate(tx, vendorId);
    const cur = await getRule(tx, vendorId, req.params.id);
    if (req.body.version !== undefined && req.body.version !== cur.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: cur.version } });
    const next = { triggerEvent: req.body.triggerEvent ?? cur.triggerEvent, conditions: (req.body.conditions ?? cur.conditions) as never, action: req.body.action ?? cur.action };
    const params = validateRule(next);
    const [row] = await tx.update(schema.automationRules).set({ name: req.body.name ?? cur.name, description: req.body.description === undefined ? cur.description : req.body.description, triggerEvent: next.triggerEvent, conditions: next.conditions, action: { type: next.action.type, params }, mode: req.body.mode ?? cur.mode, status: req.body.status ?? cur.status, version: sql`${schema.automationRules.version} + 1` }).where(eq(schema.automationRules.id, cur.id)).returning();
    await audit(tx, req, { action: 'automation.rule_updated', resourceType: 'automation_rule', resourceId: cur.id, before: { mode: cur.mode, status: cur.status, action: cur.action.type }, after: { mode: row!.mode, status: row!.status, action: row!.action.type } });
    return toRuleDto(row!);
  })));

  for (const [path, status] of [['activate', 'active'], ['disable', 'disabled']] as const) {
    r.post(`/automation/rules/:id/${path}`, {
      config: { access: { permission: 'automation:write' } },
      schema: { tags: TAGS, summary: `${path === 'activate' ? 'Activate' : 'Disable'} a rule`, params: IdParamSchema, response: { 200: successEnvelope(Rule) } },
    }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
      if (status === 'active') await gate(tx, vendorId);
      const cur = await getRule(tx, vendorId, req.params.id);
      const [row] = await tx.update(schema.automationRules).set({ status, version: sql`${schema.automationRules.version} + 1` }).where(eq(schema.automationRules.id, cur.id)).returning();
      await audit(tx, req, { action: `automation.rule_${path}d`, resourceType: 'automation_rule', resourceId: cur.id, before: { status: cur.status }, after: { status } });
      return toRuleDto(row!);
    })));
  }

  r.delete('/automation/rules/:id', {
    config: { access: { permission: 'automation:write' } },
    schema: { tags: TAGS, summary: 'Delete a rule that never ran', description: 'A rule with history is disabled instead, so the audit trail of what it did stays intact.', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    const cur = await getRule(tx, vendorId, req.params.id);
    const [ran] = await tx.select({ id: schema.automationExecutions.id }).from(schema.automationExecutions).where(eq(schema.automationExecutions.ruleId, cur.id)).limit(1);
    if (ran) throw new AppError('CONFLICT', 'This rule has an execution history; disable it instead of deleting it', { details: { rule: 'has_history' } });
    await tx.delete(schema.automationRules).where(eq(schema.automationRules.id, cur.id));
    await audit(tx, req, { action: 'automation.rule_deleted', resourceType: 'automation_rule', resourceId: cur.id, before: { name: cur.name } });
    return { id: cur.id, deleted: true as const };
  })));

  r.post('/automation/rules/:id/test', {
    config: { access: { permission: 'automation:read' } },
    schema: { tags: TAGS, summary: 'Dry run: would this rule fire for this event payload?', description: 'Changes nothing. Shows the facts the conditions see and what the action would do.', params: IdParamSchema, body: z.object({ payload: z.record(z.string(), z.unknown()) }), response: { 200: successEnvelope(z.object({ matched: z.boolean(), facts: z.record(z.string(), z.unknown()), wouldDo: z.object({ action: z.string(), params: z.record(z.string(), z.unknown()), needsApproval: z.boolean() }).nullable() })) } },
  }, async (req) => ok(req, dryRun(await vendorTx(req, (tx, vendorId) => getRule(tx, vendorId, req.params.id)), req.body.payload)));

  // ---------------------------------------------------------------- executions: history, approval, rollback
  r.get('/automation/executions', {
    config: { access: { permission: 'automation:read' } },
    schema: { tags: TAGS, summary: 'Execution history', querystring: z.object({ 'filter[status]': z.enum(schema.AUTOMATION_EXECUTION_STATUSES).optional(), 'filter[ruleId]': z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: successEnvelope(z.array(Execution)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listExecutions(tx, vendorId, { status: req.query['filter[status]'], ruleId: req.query['filter[ruleId]'], limit: req.query.limit }))));

  r.get('/automation/executions/:id', {
    config: { access: { permission: 'automation:read' } },
    schema: { tags: TAGS, summary: 'One execution', params: IdParamSchema, response: { 200: successEnvelope(Execution) } },
  }, async (req) => ok(req, toExecutionDto(await vendorTx(req, (tx, vendorId) => getExecution(tx, vendorId, req.params.id)))));

  r.post('/automation/executions/:id/approve', {
    config: { access: { permission: 'automation:write' } },
    schema: { tags: TAGS, summary: 'Approve a waiting execution and run it', description: 'The action runs now, in its own transaction; its outcome (executed / failed) is in the response.', params: IdParamSchema, response: { 200: successEnvelope(Execution) } },
  }, async (req) => {
    const vendorId = vendorOf(req);
    await vendorTx(req, (tx) => gate(tx, vendorId));
    return ok(req, await executeExecution(c, vendorId, req.params.id, actor(req)));
  });

  r.post('/automation/executions/:id/reject', {
    config: { access: { permission: 'automation:write' } },
    schema: { tags: TAGS, summary: 'Reject a waiting execution', params: IdParamSchema, body: z.object({ note: z.string().max(300).nullish() }).default({}), response: { 200: successEnvelope(Execution) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => rejectExecution(tx, vendorId, req.params.id, actor(req), req.body.note))));

  r.post('/automation/executions/:id/rollback', {
    config: { access: { permission: 'automation:write' } },
    schema: { tags: TAGS, summary: 'Undo an executed, reversible action', params: IdParamSchema, response: { 200: successEnvelope(Execution) } },
  }, async (req) => ok(req, await rollbackExecution(c, vendorOf(req), req.params.id, actor(req))));
};
