import { and, desc, eq, schema, sql, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { evaluate, validateRule, type ConditionSet, type Facts, type RuleAction, type RuleDef, type RuleType } from './engine';

const R = schema.businessRules;
export type RuleRow = typeof R.$inferSelect;

export const toRuleDef = (r: RuleRow): RuleDef => ({
  id: r.id, type: r.type as RuleType, name: r.name, status: r.status, priority: r.priority, exclusive: r.exclusive,
  conditions: r.conditions as ConditionSet, action: r.action as RuleAction, startsAt: r.startsAt, endsAt: r.endsAt,
});

export const toRuleDto = (r: RuleRow) => ({
  id: r.id, type: r.type as RuleType, name: r.name, description: r.description, status: r.status as 'draft' | 'active' | 'disabled', priority: r.priority, exclusive: r.exclusive,
  conditions: r.conditions as ConditionSet, action: r.action as RuleAction, startsAt: r.startsAt ? r.startsAt.toISOString() : null, endsAt: r.endsAt ? r.endsAt.toISOString() : null,
  createdBy: r.createdBy, version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

function assertValid(type: RuleType, conditions: ConditionSet, action: RuleAction): void {
  const issues = validateRule(type, conditions, action);
  if (issues.length) throw Errors.validation({ issues });
}

export interface RuleInput {
  type: RuleType; name: string; description?: string | null; status?: 'draft' | 'active' | 'disabled'; priority?: number; exclusive?: boolean;
  conditions: ConditionSet; action: RuleAction; startsAt?: Date | null; endsAt?: Date | null;
}

export async function createRule(tx: Tx, vendorId: string, actorId: string | null, input: RuleInput): Promise<RuleRow> {
  assertValid(input.type, input.conditions, input.action);
  const [row] = await tx.insert(R).values({
    vendorId, type: input.type, name: input.name, description: input.description ?? null, status: input.status ?? 'draft', priority: input.priority ?? 100, exclusive: input.exclusive ?? false,
    conditions: input.conditions, action: input.action, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, createdBy: actorId,
  }).returning();
  return row!;
}

export async function getRule(tx: Tx, vendorId: string, id: string): Promise<RuleRow> {
  const [r] = await tx.select().from(R).where(and(eq(R.id, id), eq(R.vendorId, vendorId)));
  if (!r) throw Errors.notFound('Rule', id);
  return r;
}

export async function updateRule(tx: Tx, vendorId: string, id: string, patch: Partial<Omit<RuleInput, 'type'>> & { version?: number }) {
  const before = await getRule(tx, vendorId, id);
  if (patch.version !== undefined && patch.version !== before.version) throw new AppError('VERSION_CONFLICT', undefined, { details: { currentVersion: before.version } });
  const conditions = patch.conditions ?? (before.conditions as ConditionSet);
  const action = patch.action ?? (before.action as RuleAction);
  assertValid(before.type as RuleType, conditions, action);
  const [after] = await tx.update(R).set({
    name: patch.name ?? before.name, description: patch.description !== undefined ? patch.description : before.description, status: patch.status ?? before.status, priority: patch.priority ?? before.priority,
    exclusive: patch.exclusive ?? before.exclusive, conditions, action, startsAt: patch.startsAt !== undefined ? patch.startsAt : before.startsAt, endsAt: patch.endsAt !== undefined ? patch.endsAt : before.endsAt, version: sql`${R.version} + 1`,
  }).where(eq(R.id, id)).returning();
  return { before, after: after! };
}

export async function deleteRule(tx: Tx, vendorId: string, id: string): Promise<RuleRow> {
  const before = await getRule(tx, vendorId, id);
  await tx.delete(R).where(eq(R.id, id));
  return before;
}

export async function listRules(tx: Tx, vendorId: string, f: { type?: string; status?: string }): Promise<RuleRow[]> {
  return tx.select().from(R).where(and(eq(R.vendorId, vendorId), f.type ? eq(R.type, f.type) : undefined, f.status ? eq(R.status, f.status) : undefined)).orderBy(desc(R.priority), R.createdAt).limit(500);
}

/** The vendor's LIVE rules of a type, ready for the pure evaluator. */
export async function liveRules(tx: Tx, vendorId: string, type: RuleType): Promise<RuleDef[]> {
  return (await tx.select().from(R).where(and(eq(R.vendorId, vendorId), eq(R.type, type), eq(R.status, 'active'))).orderBy(desc(R.priority), R.createdAt).limit(500)).map(toRuleDef);
}

/** Convenience for modules: load + evaluate in one call. */
export async function evaluateRules(tx: Tx, vendorId: string, type: RuleType, facts: Facts, now = new Date()) {
  return evaluate(await liveRules(tx, vendorId, type), facts, now);
}

/** Explainability: remember which rule fired for which entity (bounded, append-only). */
export async function recordExecutions(tx: Tx, vendorId: string, ruleType: RuleType, entityType: string, entityId: string, fired: Array<{ ruleId: string; outcome?: Record<string, unknown> }>): Promise<void> {
  if (fired.length === 0) return;
  await tx.insert(schema.ruleExecutions).values(fired.slice(0, 20).map((f) => ({ vendorId, ruleId: f.ruleId, ruleType, entityType, entityId, outcome: f.outcome ?? {} })));
}
