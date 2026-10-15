import { z } from 'zod';

/**
 * Controlled rule engine. A rule is DATA: conditions over a whitelisted set of facts + one whitelisted action with
 * validated parameters. There is no expression language, no script and no way to reach outside the facts handed in,
 * so a vendor can configure behaviour but can never inject code. Each module declares the facts it provides and the
 * actions it understands (RULE_TYPE_SPECS); creating a rule is rejected unless it fits the spec.
 */
export const RULE_TYPES = ['pricing', 'stock', 'marketplace', 'fulfillment', 'notification'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const OPS = ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'between', 'exists'] as const;
export type Op = (typeof OPS)[number];
type FactType = 'string' | 'number' | 'boolean' | 'string[]';

/** which operators make sense for which fact type */
const OPS_FOR: Record<FactType, readonly Op[]> = {
  string: ['eq', 'ne', 'in', 'nin', 'contains', 'startsWith', 'exists'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin', 'exists'],
  boolean: ['eq', 'ne'],
  'string[]': ['contains', 'in', 'exists'],
};

export interface Condition { field: string; op: Op; value?: unknown }
export interface ConditionSet { combinator: 'all' | 'any'; conditions: Condition[] }
export interface RuleAction { type: string; params: Record<string, unknown> }
export interface RuleDef {
  id: string; type: RuleType; name: string; status: string; priority: number; exclusive: boolean;
  conditions: ConditionSet; action: RuleAction; startsAt?: Date | null; endsAt?: Date | null;
}
export type Facts = Record<string, string | number | boolean | string[] | null | undefined>;

const pct = (min: number, max: number) => z.number().min(min).max(max);
const uuid = z.uuid();

export interface RuleTypeSpec {
  title: string;
  description: string;
  /** facts a rule of this type may use */
  fields: Record<string, FactType>;
  /** actions a rule of this type may carry, with their parameter schemas */
  actions: Record<string, { description: string; params: z.ZodType<Record<string, unknown>> }>;
}

export const RULE_TYPE_SPECS: Record<RuleType, RuleTypeSpec> = {
  pricing: {
    title: 'Pricing rules',
    description: 'Compute a marketplace price from the base price. Matching rules apply in priority order; the result is always clamped to a positive price at or below the MRP.',
    fields: { marketplace: 'string', accountId: 'string', categoryId: 'string', brand: 'string', sku: 'string', tags: 'string[]', basePriceMinor: 'number', costMinor: 'number', mrpMinor: 'number' },
    actions: {
      markup_percent: { description: 'Add a percentage to the running price (negative = reduce)', params: z.object({ percent: pct(-90, 1000) }) },
      markup_fixed: { description: 'Add a fixed amount (minor units) to the running price', params: z.object({ amountMinor: z.number().int().min(-100_000_000).max(100_000_000) }) },
      discount_percent: { description: 'Reduce the running price by a percentage', params: z.object({ percent: pct(0, 95) }) },
      fixed_price: { description: 'Set the price (minor units)', params: z.object({ priceMinor: z.number().int().min(1) }) },
      margin_floor: { description: 'Never go below cost + this margin %', params: z.object({ minMarginPercent: pct(0, 95) }) },
      round_to: { description: 'Round: "nearest" step (minor units) or "ending" such as 99 (-> ...99)', params: z.object({ mode: z.enum(['nearest', 'ending']), step: z.number().int().min(1).optional(), ending: z.number().int().min(0).max(99).optional() }) },
      cap_to_mrp: { description: 'Never exceed the MRP', params: z.object({}) },
    },
  },
  fulfillment: {
    title: 'Fulfillment routing rules',
    description: 'Decide which warehouse(s) fulfil an order and how urgently.',
    fields: { marketplace: 'string', accountId: 'string', paymentMethod: 'string', destinationState: 'string', destinationPincode: 'string', orderValueMinor: 'number', itemCount: 'number' },
    actions: {
      route: { description: 'Prefer these warehouses and/or a strategy', params: z.object({ warehouseIds: z.array(uuid).max(50).optional(), strategy: z.enum(['priority', 'nearest', 'single_warehouse', 'balanced']).optional(), allowSplit: z.boolean().optional() }) },
      set_priority: { description: 'Set the fulfillment priority', params: z.object({ priority: z.enum(['normal', 'high', 'urgent']) }) },
    },
  },
  notification: {
    title: 'Notification rules',
    description: 'Mute, re-route or escalate notifications.',
    fields: { eventType: 'string', severity: 'string', marketplace: 'string', title: 'string' },
    actions: {
      mute: { description: 'Do not notify', params: z.object({}) },
      channels: { description: 'Force these channels for matching notifications', params: z.object({ channels: z.array(z.enum(['in_app', 'email', 'push'])).min(1).max(3) }) },
      escalate: { description: 'Raise the severity', params: z.object({ severity: z.enum(['info', 'warning', 'critical']) }) },
    },
  },
  stock: {
    title: 'Stock rules',
    description: 'Extension point for stock behaviour (evaluated through POST /rules/evaluate; not yet enforced automatically by the inventory engine).',
    fields: { sku: 'string', variantId: 'string', warehouseId: 'string', categoryId: 'string', available: 'number', onHand: 'number' },
    actions: {
      set_reorder_level: { description: 'Suggest a reorder level', params: z.object({ level: z.number().int().min(0) }) },
      safety_buffer: { description: 'Suggest a channel safety buffer', params: z.object({ units: z.number().int().min(0) }) },
    },
  },
  marketplace: {
    title: 'Marketplace rules',
    description: 'Extension point for per-marketplace behaviour (evaluated through POST /rules/evaluate; not yet enforced automatically by the listing flow).',
    fields: { marketplace: 'string', accountId: 'string', categoryId: 'string', brand: 'string', priceMinor: 'number' },
    actions: {
      require_approval: { description: 'A listing needs a second approval', params: z.object({}) },
      block_publish: { description: 'Block publishing with a reason', params: z.object({ reason: z.string().min(2).max(200) }) },
    },
  },
};

export interface RuleIssue { path: string; message: string }

/** Structural validation of a rule against its type's spec. Returns [] when valid. */
export function validateRule(type: RuleType, conditions: ConditionSet, action: RuleAction): RuleIssue[] {
  const spec = RULE_TYPE_SPECS[type];
  const issues: RuleIssue[] = [];
  if (conditions.conditions.length > 20) issues.push({ path: 'conditions', message: 'at most 20 conditions per rule' });
  conditions.conditions.forEach((c, i) => {
    const ft = spec.fields[c.field];
    if (!ft) { issues.push({ path: `conditions[${i}].field`, message: `unknown field "${c.field}" for ${type} rules (allowed: ${Object.keys(spec.fields).join(', ')})` }); return; }
    if (!OPS_FOR[ft].includes(c.op)) { issues.push({ path: `conditions[${i}].op`, message: `operator "${c.op}" is not valid for ${ft} field "${c.field}" (allowed: ${OPS_FOR[ft].join(', ')})` }); return; }
    const v = c.value;
    const scalar = ft === 'string[]' ? 'string' : ft;
    const okScalar = (x: unknown) => (scalar === 'string' ? typeof x === 'string' : scalar === 'number' ? typeof x === 'number' && Number.isFinite(x) : typeof x === 'boolean');
    if (c.op === 'exists') { if (v !== undefined && typeof v !== 'boolean') issues.push({ path: `conditions[${i}].value`, message: 'exists takes true/false' }); return; }
    if (c.op === 'in' || c.op === 'nin') { if (!Array.isArray(v) || v.length === 0 || v.length > 100 || !v.every(okScalar)) issues.push({ path: `conditions[${i}].value`, message: 'expected a non-empty list of values of the field type' }); return; }
    if (c.op === 'between') { if (!Array.isArray(v) || v.length !== 2 || !v.every(okScalar) || (v[0] as number) > (v[1] as number)) issues.push({ path: `conditions[${i}].value`, message: 'expected [min, max]' }); return; }
    if (!okScalar(v)) issues.push({ path: `conditions[${i}].value`, message: `expected a ${scalar}` });
  });
  const a = spec.actions[action.type];
  if (!a) { issues.push({ path: 'action.type', message: `unknown action "${action.type}" for ${type} rules (allowed: ${Object.keys(spec.actions).join(', ')})` }); return issues; }
  const parsed = a.params.safeParse(action.params ?? {});
  if (!parsed.success) for (const i of parsed.error.issues) issues.push({ path: `action.params.${i.path.join('.')}`, message: i.message });
  return issues;
}

const num = (x: unknown): number | null => (typeof x === 'number' ? x : null);

export function conditionMatches(c: Condition, facts: Facts): boolean {
  const f = facts[c.field];
  const v = c.value;
  if (c.op === 'exists') return (f !== undefined && f !== null) === (v === undefined ? true : Boolean(v));
  if (f === undefined || f === null) return false;
  const list = Array.isArray(f);
  switch (c.op) {
    case 'eq': return !list && f === v;
    case 'ne': return !list && f !== v;
    case 'in': return list ? (f as string[]).some((x) => (v as unknown[]).includes(x)) : (v as unknown[]).includes(f);
    case 'nin': return list ? !(f as string[]).some((x) => (v as unknown[]).includes(x)) : !(v as unknown[]).includes(f);
    case 'contains': return list ? (f as string[]).includes(v as string) : typeof f === 'string' && f.toLowerCase().includes(String(v).toLowerCase());
    case 'startsWith': return typeof f === 'string' && f.toLowerCase().startsWith(String(v).toLowerCase());
    case 'gt': return num(f) !== null && (f as number) > (v as number);
    case 'gte': return num(f) !== null && (f as number) >= (v as number);
    case 'lt': return num(f) !== null && (f as number) < (v as number);
    case 'lte': return num(f) !== null && (f as number) <= (v as number);
    case 'between': return num(f) !== null && (f as number) >= (v as number[])[0]! && (f as number) <= (v as number[])[1]!;
    default: return false;
  }
}

/** An empty condition list always matches ("for everything"). */
export function matches(set: ConditionSet, facts: Facts): boolean {
  if (set.conditions.length === 0) return true;
  return set.combinator === 'all' ? set.conditions.every((c) => conditionMatches(c, facts)) : set.conditions.some((c) => conditionMatches(c, facts));
}

export const isLive = (r: Pick<RuleDef, 'status' | 'startsAt' | 'endsAt'>, now: Date): boolean =>
  r.status === 'active' && (!r.startsAt || r.startsAt <= now) && (!r.endsAt || r.endsAt > now);

export interface Matched { rule: RuleDef; action: RuleAction }

/** Rules that apply to these facts, highest priority first; an `exclusive` match stops the list. Deterministic: ties break by id. */
export function evaluate(rules: RuleDef[], facts: Facts, now: Date = new Date()): Matched[] {
  const out: Matched[] = [];
  const ordered = [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const r of ordered) {
    if (!isLive(r, now) || !matches(r.conditions, facts)) continue;
    out.push({ rule: r, action: r.action });
    if (r.exclusive) break;
  }
  return out;
}
