import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { audit, created, emit, ok, requireVendor, vendorTx } from '@oms/module-kit';
import { OPS, RULE_TYPES, RULE_TYPE_SPECS, evaluate, type Facts } from './engine';
import * as svc from './service';

const ConditionSchema = z.object({ field: z.string().min(1).max(60), op: z.enum(OPS), value: z.unknown().optional() });
const ConditionsSchema = z.object({ combinator: z.enum(['all', 'any']).default('all'), conditions: z.array(ConditionSchema).max(20).default([]) });
const ActionSchema = z.object({ type: z.string().min(1).max(60), params: z.record(z.string(), z.unknown()).default({}) });

export const RuleSchema = z
  .object({
    id: z.string(), type: z.enum(RULE_TYPES), name: z.string(), description: z.string().nullable(), status: z.enum(['draft', 'active', 'disabled']), priority: z.number().int(),
    exclusive: z.boolean().describe('Stop evaluating lower-priority rules of this type once this one matched'), conditions: ConditionsSchema, action: ActionSchema,
    startsAt: IsoDate.nullable(), endsAt: IsoDate.nullable(), createdBy: z.string().nullable(), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
  })
  .meta({ id: 'BusinessRule' });

const CreateBody = z.object({
  type: z.enum(RULE_TYPES), name: z.string().trim().min(2).max(120), description: z.string().max(500).nullish(), status: z.enum(['draft', 'active', 'disabled']).default('draft'),
  priority: z.number().int().min(0).max(10_000).default(100), exclusive: z.boolean().default(false), conditions: ConditionsSchema, action: ActionSchema,
  startsAt: z.coerce.date().nullish(), endsAt: z.coerce.date().nullish(),
});
const UpdateBody = CreateBody.omit({ type: true }).partial().extend({ version: z.number().int().optional() });

export const ruleRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Business Rules'];

  r.get('/rules/types', {
    config: { access: { permission: 'rules:read' } },
    schema: {
      tags: TAGS,
      summary: 'Rule types: the facts, operators and actions each type supports',
      description: 'The rule system is controlled: a rule may only use these fields and these actions. Use this to build a rule editor.',
      response: { 200: successEnvelope(z.array(z.object({ type: z.enum(RULE_TYPES), title: z.string(), description: z.string(), fields: z.record(z.string(), z.string()), operators: z.array(z.string()), actions: z.array(z.object({ type: z.string(), description: z.string() })) }).meta({ id: 'RuleTypeSpec' }))) },
    },
  }, async (req) => ok(req, RULE_TYPES.map((t) => ({ type: t, title: RULE_TYPE_SPECS[t].title, description: RULE_TYPE_SPECS[t].description, fields: RULE_TYPE_SPECS[t].fields, operators: [...OPS], actions: Object.entries(RULE_TYPE_SPECS[t].actions).map(([type, a]) => ({ type, description: a.description })) }))));

  r.post('/rules', {
    config: { access: { permission: 'rules:write' } },
    schema: { tags: TAGS, summary: 'Create a rule', description: 'Validated against the rule type (unknown fields, wrong operators and invalid action parameters are rejected). Created as `draft` unless you set `status`.', body: CreateBody, response: { 201: successEnvelope(RuleSchema) } },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const row = await svc.createRule(tx, vendorId, req.ctx.principal?.actorId ?? null, req.body as never);
      await audit(tx, req, { action: 'rule.create', resourceType: 'rule', resourceId: row.id, after: { type: row.type, name: row.name, status: row.status, action: row.action } });
      await emit(tx, req, { type: 'rule.created', aggregateType: 'rule', aggregateId: row.id, payload: { ruleType: row.type } });
      return svc.toRuleDto(row);
    });
    return created(req, reply, dto as never, `/api/v1/rules/${dto.id}`);
  });

  r.get('/rules', {
    config: { access: { permission: 'rules:read' } },
    schema: { tags: TAGS, summary: 'List rules', querystring: z.object({ 'filter[type]': z.enum(RULE_TYPES).optional(), 'filter[status]': z.enum(['draft', 'active', 'disabled']).optional() }), response: { 200: successEnvelope(z.array(RuleSchema)) } },
  }, async (req) => ok(req, (await vendorTx(req, (tx, vendorId) => svc.listRules(tx, vendorId, { type: req.query['filter[type]'], status: req.query['filter[status]'] }))).map(svc.toRuleDto) as never));

  r.get('/rules/:id', {
    config: { access: { permission: 'rules:read' } },
    schema: { tags: TAGS, summary: 'Get a rule', params: IdParamSchema, response: { 200: successEnvelope(RuleSchema) } },
  }, async (req) => ok(req, svc.toRuleDto(await vendorTx(req, (tx, vendorId) => svc.getRule(tx, vendorId, req.params.id))) as never));

  r.patch('/rules/:id', {
    config: { access: { permission: 'rules:write' } },
    schema: { tags: TAGS, summary: 'Update a rule (partial)', params: IdParamSchema, body: UpdateBody, response: { 200: successEnvelope(RuleSchema) } },
  }, async (req) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const { before, after } = await svc.updateRule(tx, vendorId, req.params.id, req.body as never);
      await audit(tx, req, { action: 'rule.update', resourceType: 'rule', resourceId: after.id, before: { status: before.status, priority: before.priority, conditions: before.conditions, action: before.action }, after: { status: after.status, priority: after.priority, conditions: after.conditions, action: after.action } });
      await emit(tx, req, { type: 'rule.updated', aggregateType: 'rule', aggregateId: after.id, payload: { ruleType: after.type } });
      return svc.toRuleDto(after);
    });
    return ok(req, dto as never);
  });

  const toggle = (path: 'activate' | 'disable', status: 'active' | 'disabled') => {
    r.post(`/rules/:id/${path}`, {
      config: { access: { permission: 'rules:write' } },
      schema: { tags: TAGS, summary: `${path === 'activate' ? 'Activate' : 'Disable'} a rule`, params: IdParamSchema, response: { 200: successEnvelope(RuleSchema) } },
    }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
      const { before, after } = await svc.updateRule(tx, vendorId, req.params.id, { status });
      await audit(tx, req, { action: `rule.${path}`, resourceType: 'rule', resourceId: after.id, before: { status: before.status }, after: { status: after.status } });
      await emit(tx, req, { type: 'rule.updated', aggregateType: 'rule', aggregateId: after.id, payload: { ruleType: after.type, status } });
      return svc.toRuleDto(after);
    }) as never));
  };
  toggle('activate', 'active');
  toggle('disable', 'disabled');

  r.delete('/rules/:id', {
    config: { access: { permission: 'rules:write' } },
    schema: { tags: TAGS, summary: 'Delete a rule', params: IdParamSchema, response: { 200: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const row = await svc.deleteRule(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'rule.delete', resourceType: 'rule', resourceId: row.id, before: { type: row.type, name: row.name, action: row.action } });
      await emit(tx, req, { type: 'rule.deleted', aggregateType: 'rule', aggregateId: row.id, payload: { ruleType: row.type } });
    });
    return ok(req, { id: req.params.id, deleted: true as const });
  });

  r.post('/rules/evaluate', {
    config: { access: { permission: 'rules:read' } },
    schema: {
      tags: TAGS,
      summary: 'Dry-run: which rules apply to these facts?',
      description: 'Returns the live rules of the type that match, in the order they would apply, and the action each would take. Changes nothing.',
      body: z.object({ type: z.enum(RULE_TYPES), facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])) }),
      response: { 200: successEnvelope(z.array(z.object({ ruleId: z.string(), name: z.string(), priority: z.number().int(), exclusive: z.boolean(), action: ActionSchema }))) },
    },
  }, async (req) => {
    const vendorId = requireVendor(req);
    const matched = await vendorTx(req, (tx) => svc.liveRules(tx, vendorId, req.body.type));
    return ok(req, evaluate(matched, req.body.facts as Facts).map((m) => ({ ruleId: m.rule.id, name: m.rule.name, priority: m.rule.priority, exclusive: m.rule.exclusive, action: m.action as never })));
  });
};
