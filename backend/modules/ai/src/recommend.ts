import { and, desc, eq, schema, sql, writeAudit, writeOutboxEvent, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { z } from 'zod';
import { businessHealth, dailyRevenueSeries, DEFAULT_THRESHOLDS, inventoryHealth, productHealth } from '@oms/mod-analytics';
import { setReorderLevel } from '@oms/mod-inventory';
import { detectAnomalies } from './detect';

const R = schema.aiRecommendations;
const S = schema.aiSettings;
export type RecommendationRow = typeof R.$inferSelect;
type Mode = (typeof schema.AI_MODES)[number];
export interface Actor { type: 'user' | 'system'; id: string | null }

// ------------------------------------------------------------------------------------------------
// settings: OBSERVE -> RECOMMEND -> APPROVE -> AUTOMATE
// ------------------------------------------------------------------------------------------------
export const MODE_HELP: Record<Mode, string> = {
  observe: 'Insights and answers only. No recommendations are stored.',
  recommend: 'Recommendations are stored for people to read. Approving one records the decision; nothing is executed by the system.',
  approve: 'A human approving a recommendation executes its action (every execution needs that approval).',
  automate: 'Action types you list under automatedActions execute on their own; everything else still needs approval.',
};
export async function getSettings(tx: Tx, vendorId: string) {
  const [s] = await tx.select().from(S).where(eq(S.vendorId, vendorId));
  return { enabled: s?.enabled ?? true, mode: (s?.mode ?? 'recommend') as Mode, automatedActions: s?.automatedActions ?? [], isDefault: !s, modes: MODE_HELP, actionTypes: Object.keys(ACTIONS) };
}
export async function saveSettings(tx: Tx, vendorId: string, actorId: string | null, input: { enabled?: boolean; mode?: Mode; automatedActions?: string[] }) {
  const cur = await getSettings(tx, vendorId);
  const bad = (input.automatedActions ?? []).filter((a) => !(a in ACTIONS));
  if (bad.length) throw new AppError('BAD_REQUEST', 'Unknown action type', { details: { unknown: bad, allowed: Object.keys(ACTIONS) } });
  const v = { enabled: input.enabled ?? cur.enabled, mode: input.mode ?? cur.mode, automatedActions: input.automatedActions ?? cur.automatedActions };
  await tx.insert(S).values({ vendorId, ...v }).onConflictDoUpdate({ target: S.vendorId, set: v });
  await writeAudit(tx, { vendorId, actorType: 'user', actorId, action: 'ai.settings_changed', resourceType: 'ai_settings', resourceId: vendorId, before: { mode: cur.mode, automatedActions: cur.automatedActions, enabled: cur.enabled }, after: v });
  return getSettings(tx, vendorId);
}

// ------------------------------------------------------------------------------------------------
// the action whitelist: the ONLY things a recommendation can do, each validated and reversible
// ------------------------------------------------------------------------------------------------
interface ActionDef { schema: z.ZodType<Record<string, unknown>>; describe(p: Record<string, unknown>): string; apply(tx: Tx, vendorId: string, p: Record<string, unknown>, by: Actor): Promise<{ result: Record<string, unknown>; rollback: Record<string, unknown> }>; undo(tx: Tx, vendorId: string, rollback: Record<string, unknown>, by: Actor): Promise<void> }
const ReorderParams = z.object({ variantId: z.uuid(), warehouseId: z.uuid(), level: z.number().int().min(0).max(1_000_000) });

export const ACTIONS: Record<string, ActionDef> = {
  /** raise / lower the reorder level of one variant in one warehouse (drives low-stock alerts); reversible */
  set_reorder_level: {
    schema: ReorderParams,
    describe: (p) => `Set the reorder level to ${p.level}`,
    async apply(tx, vendorId, p) {
      const { variantId, warehouseId, level } = ReorderParams.parse(p);
      const [cur] = await tx.select({ l: schema.inventory.reorderLevel }).from(schema.inventory).where(and(eq(schema.inventory.vendorId, vendorId), eq(schema.inventory.variantId, variantId), eq(schema.inventory.warehouseId, warehouseId)));
      await setReorderLevel(tx, vendorId, variantId, warehouseId, level);
      return { result: { variantId, warehouseId, previousLevel: cur?.l ?? null, newLevel: level }, rollback: { variantId, warehouseId, level: cur?.l ?? null } };
    },
    async undo(tx, vendorId, rb) { await setReorderLevel(tx, vendorId, String(rb.variantId), String(rb.warehouseId), rb.level === null ? null : Number(rb.level)); },
  },
};

const toDto = (r: RecommendationRow) => ({
  id: r.id, kind: r.kind, severity: r.severity as (typeof schema.RECOMMENDATION_SEVERITIES)[number], title: r.title, summary: r.summary, evidence: r.evidence, action: r.action, status: r.status as (typeof schema.RECOMMENDATION_STATUSES)[number],
  source: r.source, decidedBy: r.decidedBy, decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null, appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null, result: r.result, canRollback: r.status === 'applied' && Boolean(r.rollback),
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
});
export { toDto as toRecommendationDto };

export async function getRecommendation(tx: Tx, vendorId: string, id: string, lock = false): Promise<RecommendationRow> {
  const q = tx.select().from(R).where(and(eq(R.id, id), eq(R.vendorId, vendorId)));
  const [r] = await (lock ? q.for('update') : q);
  if (!r) throw Errors.notFound('Recommendation', id);
  return r;
}

export async function listRecommendations(tx: Tx, vendorId: string, q: { status?: string; kind?: string; limit: number }) {
  await tx.update(R).set({ status: 'expired' }).where(and(eq(R.vendorId, vendorId), eq(R.status, 'open'), sql`${R.expiresAt} < now()`));
  return (await tx.select().from(R).where(and(eq(R.vendorId, vendorId), q.status ? eq(R.status, q.status) : undefined, q.kind ? eq(R.kind, q.kind) : undefined)).orderBy(desc(R.createdAt)).limit(q.limit)).map(toDto);
}

// ------------------------------------------------------------------------------------------------
// creating, applying, deciding
// ------------------------------------------------------------------------------------------------
export interface NewRecommendation { kind: string; severity?: 'info' | 'warning' | 'critical'; title: string; summary: string; evidence?: Record<string, unknown>; action?: { type: string; params: Record<string, unknown> } | null; source?: 'rules' | 'llm' | 'automation'; dedupeKey?: string | null; ttlDays?: number }

/** stores a recommendation (deduplicated while one is still open). In `automate` mode an allow-listed action executes immediately. */
export async function createRecommendation(tx: Tx, vendorId: string, input: NewRecommendation, _by: Actor = { type: 'system', id: null }): Promise<{ recommendation: ReturnType<typeof toDto> | null; created: boolean }> {
  if (input.action) {
    const def = ACTIONS[input.action.type];
    if (!def) throw new AppError('BAD_REQUEST', 'Unknown action type', { details: { type: input.action.type, allowed: Object.keys(ACTIONS) } });
    def.schema.parse(input.action.params);
  }
  const [row] = await tx.insert(R).values({
    vendorId, kind: input.kind, severity: input.severity ?? 'info', title: input.title, summary: input.summary, evidence: input.evidence ?? {}, action: input.action ?? null, source: input.source ?? 'rules',
    dedupeKey: input.dedupeKey ?? null, expiresAt: new Date(Date.now() + (input.ttlDays ?? 14) * 86_400_000),
  }).onConflictDoNothing().returning();
  if (!row) return { recommendation: null, created: false };
  await writeOutboxEvent(tx, { type: 'ai.recommendation_created', vendorId, aggregateType: 'ai_recommendation', aggregateId: row.id, payload: { kind: row.kind, severity: row.severity, hasAction: Boolean(row.action) } });
  const s = await getSettings(tx, vendorId);
  if (s.enabled && s.mode === 'automate' && input.action && s.automatedActions.includes(input.action.type)) {
    const applied = await applyRecommendation(tx, vendorId, row.id, { type: 'system', id: 'ai:automation' }, 'automatic');
    return { recommendation: applied, created: true };
  }
  return { recommendation: toDto(row), created: true };
}

async function applyRecommendation(tx: Tx, vendorId: string, id: string, by: Actor, how: 'approved' | 'automatic') {
  const r = await getRecommendation(tx, vendorId, id, true);
  if (!r.action) throw new AppError('CONFLICT', 'This recommendation is advice only: there is nothing to execute', { details: { rule: 'no_action' } });
  const def = ACTIONS[r.action.type];
  if (!def) throw new AppError('BAD_REQUEST', 'Unknown action type', { details: { type: r.action.type } });
  try {
    const out = await tx.transaction((sp) => def.apply(sp, vendorId, def.schema.parse(r.action!.params), by));
    const [after] = await tx.update(R).set({ status: 'applied', appliedAt: new Date(), result: out.result, rollback: out.rollback, decidedBy: r.decidedBy ?? by.id, decidedAt: r.decidedAt ?? new Date(), version: sql`${R.version} + 1` }).where(eq(R.id, id)).returning();
    await writeAudit(tx, { vendorId, actorType: by.type, actorId: by.id, action: 'ai.recommendation_applied', resourceType: 'ai_recommendation', resourceId: id, after: { action: r.action.type, how, result: out.result } });
    await writeOutboxEvent(tx, { type: 'ai.recommendation_applied', vendorId, aggregateType: 'ai_recommendation', aggregateId: id, payload: { action: r.action.type, how } });
    return toDto(after!);
  } catch (e) {
    const [after] = await tx.update(R).set({ status: 'failed', result: { error: e instanceof Error ? e.message.slice(0, 300) : 'failed' }, decidedBy: r.decidedBy ?? by.id, decidedAt: new Date() }).where(eq(R.id, id)).returning();
    await writeAudit(tx, { vendorId, actorType: by.type, actorId: by.id, action: 'ai.recommendation_failed', resourceType: 'ai_recommendation', resourceId: id, metadata: { error: e instanceof Error ? e.message.slice(0, 200) : 'failed' } });
    return toDto(after!);
  }
}

/** a human decision. approve: in `approve` / `automate` mode it EXECUTES the action; in `recommend` mode it only records the approval. */
export async function decide(tx: Tx, vendorId: string, id: string, decision: 'approve' | 'reject', by: Actor, note?: string | null) {
  const r = await getRecommendation(tx, vendorId, id, true);
  if (r.status !== 'open') throw new AppError('INVALID_STATE', `This recommendation is ${r.status}`, { details: { status: r.status } });
  const s = await getSettings(tx, vendorId);
  if (!s.enabled) throw new AppError('FORBIDDEN', 'AI is switched off for this business', { details: { rule: 'ai_disabled' } });
  if (decision === 'reject') {
    const [after] = await tx.update(R).set({ status: 'rejected', decidedBy: by.id, decidedAt: new Date(), result: { note: note ?? null }, version: sql`${R.version} + 1` }).where(eq(R.id, id)).returning();
    await writeAudit(tx, { vendorId, actorType: by.type, actorId: by.id, action: 'ai.recommendation_rejected', resourceType: 'ai_recommendation', resourceId: id, metadata: { note: note ?? null } });
    return { recommendation: toDto(after!), executed: false };
  }
  await tx.update(R).set({ status: 'approved', decidedBy: by.id, decidedAt: new Date() }).where(eq(R.id, id));
  await writeAudit(tx, { vendorId, actorType: by.type, actorId: by.id, action: 'ai.recommendation_approved', resourceType: 'ai_recommendation', resourceId: id, metadata: { note: note ?? null, mode: s.mode } });
  if (r.action && (s.mode === 'approve' || s.mode === 'automate')) return { recommendation: await applyRecommendation(tx, vendorId, id, by, 'approved'), executed: true };
  return { recommendation: toDto(await getRecommendation(tx, vendorId, id)), executed: false };
}

export async function rollback(tx: Tx, vendorId: string, id: string, by: Actor) {
  const r = await getRecommendation(tx, vendorId, id, true);
  if (r.status !== 'applied' || !r.rollback || !r.action) throw new AppError('INVALID_STATE', 'Only an applied, reversible recommendation can be rolled back', { details: { status: r.status } });
  await ACTIONS[r.action.type]!.undo(tx, vendorId, r.rollback, by);
  const [after] = await tx.update(R).set({ status: 'rolled_back', version: sql`${R.version} + 1` }).where(eq(R.id, id)).returning();
  await writeAudit(tx, { vendorId, actorType: by.type, actorId: by.id, action: 'ai.recommendation_rolled_back', resourceType: 'ai_recommendation', resourceId: id, after: { restored: r.rollback } });
  return toDto(after!);
}

// ------------------------------------------------------------------------------------------------
// generation from REAL data
// ------------------------------------------------------------------------------------------------
async function primaryWarehouse(tx: Tx, vendorId: string, variantId: string): Promise<string | null> {
  const [best] = await tx.select({ w: schema.inventory.warehouseId }).from(schema.inventory).where(and(eq(schema.inventory.vendorId, vendorId), eq(schema.inventory.variantId, variantId))).orderBy(desc(schema.inventory.quantityOnHand)).limit(1);
  if (best) return best.w;
  const [def] = await tx.select({ id: schema.warehouses.id }).from(schema.warehouses).where(and(eq(schema.warehouses.vendorId, vendorId), eq(schema.warehouses.status, 'active'))).orderBy(desc(schema.warehouses.isDefault), schema.warehouses.priority).limit(1);
  return def?.id ?? null;
}

/**
 * Looks at the vendor's real numbers and stores recommendations (deduplicated while open): reorder levels for products that are out of /
 * about to run out of stock, advice on anomalies, critical operational problems and incomplete products. Does nothing in `observe` mode.
 */
export async function generateRecommendations(tx: Tx, vendorId: string, by: Actor) {
  const s = await getSettings(tx, vendorId);
  if (!s.enabled || s.mode === 'observe') return { created: 0, skipped: s.enabled ? 'observe mode: insights only' : 'AI is switched off', applied: 0 };
  let created = 0;
  let applied = 0;
  const put = async (rec: NewRecommendation) => { const r = await createRecommendation(tx, vendorId, rec, by); if (r.created) created++; if (r.recommendation?.status === 'applied') applied++; };

  const inv = await inventoryHealth(tx, vendorId, DEFAULT_THRESHOLDS, 100);
  for (const f of [...inv.outOfStock, ...inv.stockoutRisk]) {
    if (f.unitsPerDay <= 0) continue; // no sales, no forecast, no recommendation
    const wh = await primaryWarehouse(tx, vendorId, f.variantId);
    const level = Math.max(1, Math.ceil(f.unitsPerDay * 14));
    await put({
      kind: 'reorder', severity: f.flags.includes('out_of_stock') ? 'critical' : 'warning', dedupeKey: `reorder:${f.variantId}`,
      title: f.flags.includes('out_of_stock') ? `${f.sku} is out of stock and selling ${f.unitsPerDay}/day` : `${f.sku} runs out in about ${f.daysOfCover} days`,
      summary: `${f.available} available, selling ${f.unitsPerDay}/day${f.stockoutDate ? `, projected stock-out ${f.stockoutDate}` : ''}. Restock about ${f.suggestedReorderUnits ?? 0} units; raising the reorder level to ${level} (14 days of sales) triggers the low-stock alert earlier.`,
      evidence: { sku: f.sku, variantId: f.variantId, available: f.available, unitsPerDay: f.unitsPerDay, daysOfCover: f.daysOfCover, windowDays: inv.thresholds.windowDays, suggestedReorderUnits: f.suggestedReorderUnits },
      action: wh ? { type: 'set_reorder_level', params: { variantId: f.variantId, warehouseId: wh, level } } : null,
    });
  }
  for (const a of detectAnomalies(await dailyRevenueSeries(tx, vendorId, 40))) {
    await put({ kind: 'anomaly', severity: a.direction === 'down' && a.metric === 'revenue' ? 'warning' : 'info', dedupeKey: `anomaly:${a.metric}:${a.day}`, title: `Unusual ${a.metric.replace('_', ' ')} on ${a.day}`, summary: `${a.message} (${a.zScore} standard deviations from the last two weeks).`, evidence: { ...a }, ttlDays: 7 });
  }
  const bh = await businessHealth(tx, vendorId);
  for (const i of bh.issues.filter((x) => x.severity === 'critical')) {
    await put({ kind: 'operations', severity: 'critical', dedupeKey: `ops:${i.code}`, title: i.message, summary: `${i.count} affected. Examples: ${i.sampleIds.join(', ') || 'n/a'}.`, evidence: { code: i.code, area: i.area, count: i.count, sampleIds: i.sampleIds }, ttlDays: 3 });
  }
  const ph = await productHealth(tx, vendorId, 5);
  if (ph.products > 0 && (ph.averageScore ?? 100) < 80) {
    await put({ kind: 'catalog_quality', severity: 'info', dedupeKey: 'catalog_quality', title: `Catalogue completeness is ${ph.averageScore}/100`, summary: `Most common gaps: ${Object.entries(ph.issueCounts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${k.replace(/_/g, ' ')} (${c})`).join(', ')}.`, evidence: { averageScore: ph.averageScore, issueCounts: ph.issueCounts, lowest: ph.lowestScoring.map((p) => p.sku) }, ttlDays: 14 });
  }
  return { created, applied, skipped: null };
}
