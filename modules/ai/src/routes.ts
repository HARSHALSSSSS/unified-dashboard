import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isFeatureEnabled, schema, type Tx } from '@oms/database';
import { AppError } from '@oms/shared';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { ok, requireVendor, strictRateLimit, vendorTx } from '@oms/module-kit';
import { businessHealth, dailyRevenueSeries, inventoryHealth, overview, DEFAULT_THRESHOLDS } from '@oms/mod-analytics';
import { answerQuestion } from './brain';
import { detectAnomalies } from './detect';
import { createAiProvider } from './provider';
import { decide, generateRecommendations, getRecommendation, getSettings, listRecommendations, rollback, saveSettings, toRecommendationDto } from './recommend';

const TAGS = ['AI'];
const Rec = z.object({
  id: z.string(), kind: z.string(), severity: z.enum(schema.RECOMMENDATION_SEVERITIES), title: z.string(), summary: z.string(), evidence: z.record(z.string(), z.unknown()), action: z.object({ type: z.string(), params: z.record(z.string(), z.unknown()) }).nullable(),
  status: z.enum(schema.RECOMMENDATION_STATUSES), source: z.string(), decidedBy: z.string().nullable(), decidedAt: IsoDate.nullable(), appliedAt: IsoDate.nullable(), result: z.record(z.string(), z.unknown()).nullable(), canRollback: z.boolean(), expiresAt: IsoDate.nullable(), createdAt: IsoDate,
}).meta({ id: 'Recommendation' });
const Settings = z.object({ enabled: z.boolean(), mode: z.enum(schema.AI_MODES), automatedActions: z.array(z.string()), isDefault: z.boolean(), modes: z.record(z.string(), z.string()), actionTypes: z.array(z.string()) }).meta({ id: 'AiSettings' });

/**
 * AI: questions, summaries and recommendations on top of the vendor's real data. The model (if any) only narrates; data comes from
 * analytics / inventory; actions come from a whitelist and follow OBSERVE -> RECOMMEND -> APPROVE -> AUTOMATE. Switchable per vendor by
 * the platform (`ai.enabled`) and by the vendor itself.
 */
export const aiRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const c = app.container;
  const provider = createAiProvider({ AI_PROVIDER: c.config.AI_PROVIDER, ANTHROPIC_API_KEY: c.config.ANTHROPIC_API_KEY, AI_MODEL: c.config.AI_MODEL, AI_TIMEOUT_MS: c.config.AI_TIMEOUT_MS });
  const askLimit = strictRateLimit(app, 30);
  const actor = (req: FastifyRequest) => ({ type: 'user' as const, id: req.ctx.principal?.actorId ?? null });
  /** AI is off when the platform flag is off for this vendor OR the vendor switched it off */
  const gate = async (tx: Tx, vendorId: string) => {
    if (!(await isFeatureEnabled(tx, 'ai.enabled', vendorId, true))) throw new AppError('FORBIDDEN', 'AI features are not enabled for this business', { details: { rule: 'feature_disabled', flag: 'ai.enabled' } });
    if (!(await getSettings(tx, vendorId)).enabled) throw new AppError('FORBIDDEN', 'AI is switched off in your AI settings', { details: { rule: 'ai_disabled' } });
  };

  r.get('/ai/settings', {
    config: { access: { permission: 'ai:use' } },
    schema: { tags: TAGS, summary: 'AI safety settings (observe / recommend / approve / automate)', response: { 200: successEnvelope(Settings) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getSettings(tx, vendorId))));

  r.put('/ai/settings', {
    config: { access: { permission: 'ai:use' } },
    schema: {
      tags: TAGS, summary: 'Change AI settings', description: 'Default mode is `recommend`: nothing is ever executed without a person. `automate` runs ONLY the action types you list in `automatedActions`. Every change is audited.',
      body: z.object({ enabled: z.boolean().optional(), mode: z.enum(schema.AI_MODES).optional(), automatedActions: z.array(z.string().max(60)).max(20).optional() }), response: { 200: successEnvelope(Settings) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => saveSettings(tx, vendorId, req.ctx.principal?.actorId ?? null, req.body))));

  r.post('/ai/ask', {
    config: { access: { permission: 'ai:use' } },
    schema: {
      tags: TAGS, summary: 'Ask a business question in plain language',
      description: 'Answered from your real inventory, order, sales, return and listing data. Example: "Which products are likely to run out this week?". The response lists the data used (`sources`) and the structured evidence (`data`). When no question type matches, the assistant says what it can answer instead of guessing.',
      body: z.object({ question: z.string().trim().min(3).max(500) }),
      response: { 200: successEnvelope(z.object({ question: z.string(), intent: z.string(), answer: z.string(), confidence: z.enum(['data', 'none']), sources: z.array(z.string()), data: z.unknown(), generatedBy: z.enum(['rules', 'llm']), provider: z.string().nullable() })) },
    },
  }, async (req) => {
    await askLimit(req);
    const out = await vendorTx(req, async (tx, vendorId) => { await gate(tx, vendorId); return answerQuestion(tx, vendorId, req.body.question); });
    let text = out.answer;
    let generatedBy: 'rules' | 'llm' = 'rules';
    if (provider && out.confidence === 'data') {
      try { text = await provider.narrate({ question: req.body.question, draft: out.answer, facts: out.data }); generatedBy = 'llm'; } catch (e) { req.log.warn({ err: (e as Error).message }, 'AI provider failed; answering from the data directly'); }
    }
    return ok(req, { question: req.body.question, intent: out.intent, answer: text, confidence: out.confidence, sources: out.sources, data: out.data, generatedBy, provider: generatedBy === 'llm' ? provider!.name : null });
  });

  r.get('/ai/summary', {
    config: { access: { permission: 'ai:use' } },
    schema: {
      tags: TAGS, summary: 'Business summary: the headlines, risks and what to look at',
      response: { 200: successEnvelope(z.object({ generatedAt: IsoDate, headline: z.string(), bullets: z.array(z.string()), health: z.object({ score: z.number().int(), grade: z.string() }), anomalies: z.array(z.record(z.string(), z.unknown())) })) },
    },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => {
    await gate(tx, vendorId);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const [o, inv, bh, series] = await Promise.all([overview(tx, vendorId, { from, to }), inventoryHealth(tx, vendorId, DEFAULT_THRESHOLDS, 5), businessHealth(tx, vendorId), dailyRevenueSeries(tx, vendorId, 40)]);
    const an = detectAnomalies(series);
    const rev = o.kpis.revenueMinor!;
    const bullets = [
      `${o.kpis.orders!.value} orders and INR ${(rev.value / 100).toFixed(2)} revenue in the last 30 days${rev.changePercent === null ? '' : ` (${rev.changePercent >= 0 ? '+' : ''}${rev.changePercent}% vs the previous 30 days)`}.`,
      ...(inv.counts.outOfStock + inv.counts.stockoutRisk > 0 ? [`${inv.counts.outOfStock} product(s) out of stock and ${inv.counts.stockoutRisk} projected to run out within a week.`] : []),
      ...bh.issues.slice(0, 3).map((i) => `${i.message}: ${i.count}.`),
      ...an.map((a) => `Unusual: ${a.message}.`),
    ];
    return { generatedAt: new Date().toISOString(), headline: `Business health ${bh.score}/100 (${bh.grade.replace('_', ' ')})`, bullets, health: { score: bh.score, grade: bh.grade }, anomalies: an as unknown as Array<Record<string, unknown>> };
  })));

  r.get('/ai/anomalies', {
    config: { access: { permission: 'ai:use' } },
    schema: { tags: TAGS, summary: 'Unusual days in revenue, orders, cancellations and returns', description: 'A day far outside the previous 14 days (z-score >= 2.5 and a meaningful absolute change). Needs 14+ days of history.', response: { 200: successEnvelope(z.array(z.object({ metric: z.string(), day: z.string(), direction: z.enum(['up', 'down']), value: z.number(), baselineMean: z.number(), baselineStd: z.number(), zScore: z.number(), message: z.string() }))) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await gate(tx, vendorId); return detectAnomalies(await dailyRevenueSeries(tx, vendorId, 40)); })));

  // ---------------------------------------------------------------- recommendations
  r.post('/ai/recommendations/generate', {
    config: { access: { permission: 'ai:use' } },
    schema: { tags: TAGS, summary: 'Analyse the data now and store recommendations', description: 'Reorder levels for products that are out of / about to run out of stock (only with real sales), anomalies, critical operational problems and catalogue gaps. Deduplicated while open. Does nothing in `observe` mode.', response: { 200: successEnvelope(z.object({ created: z.number().int(), applied: z.number().int(), skipped: z.string().nullable() })) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await gate(tx, vendorId); return generateRecommendations(tx, vendorId, actor(req)); })));

  r.get('/ai/recommendations', {
    config: { access: { permission: 'ai:use' } },
    schema: { tags: TAGS, summary: 'Recommendations', querystring: z.object({ 'filter[status]': z.enum(schema.RECOMMENDATION_STATUSES).optional(), 'filter[kind]': z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: successEnvelope(z.array(Rec)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listRecommendations(tx, vendorId, { status: req.query['filter[status]'], kind: req.query['filter[kind]'], limit: req.query.limit }))));

  r.get('/ai/recommendations/:id', {
    config: { access: { permission: 'ai:use' } },
    schema: { tags: TAGS, summary: 'One recommendation with its evidence', params: IdParamSchema, response: { 200: successEnvelope(Rec) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => toRecommendationDto(await getRecommendation(tx, vendorId, req.params.id)))));

  for (const decision of ['approve', 'reject'] as const) {
    r.post(`/ai/recommendations/:id/${decision}`, {
      config: { access: { permission: 'ai:use' } },
      schema: {
        tags: TAGS, summary: decision === 'approve' ? 'Approve a recommendation' : 'Reject a recommendation',
        description: decision === 'approve' ? 'In `approve` / `automate` mode approving EXECUTES its action (audited, reversible via /rollback). In `recommend` mode it only records the approval (`executed: false`).' : 'Closes the recommendation without any change.',
        params: IdParamSchema, body: z.object({ note: z.string().max(300).nullish() }).default({}), response: { 200: successEnvelope(z.object({ recommendation: Rec, executed: z.boolean() })) },
      },
    }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => { await gate(tx, vendorId); return decide(tx, vendorId, req.params.id, decision, actor(req), req.body.note); })));
  }

  r.post('/ai/recommendations/:id/rollback', {
    config: { access: { permission: 'ai:use' } },
    schema: { tags: TAGS, summary: 'Undo an applied recommendation', params: IdParamSchema, response: { 200: successEnvelope(Rec) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => rollback(tx, vendorId, req.params.id, actor(req)))));

  void requireVendor;
};
