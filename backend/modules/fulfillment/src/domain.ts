import type { InternalOrderStatus } from '@oms/marketplace-core';

/**
 * Pure fulfillment rules: the state machine, how it maps onto the order status, barcode matching and the order-routing
 * planner. No I/O, so every rule here is unit-tested without a database.
 */

// ------------------------------------------------------------------------------------------------
// state machine
// ------------------------------------------------------------------------------------------------
export const STATUSES = [
  'confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered',
  'on_hold', 'cancelled', 'delivery_failed', 'rto_in_transit', 'rto_received',
] as const;
export type FulfillmentStatus = (typeof STATUSES)[number];

/**
 * Happy path: confirmed -> picking -> picked -> packing -> packed -> ready_to_ship -> shipped -> in_transit -> delivered.
 * Exceptions: on_hold (any pre-ship step; `resume` returns to where it was), cancelled (pre-ship), delivery_failed (NDR) with
 * a re-attempt (back to in_transit) or RTO, rto_in_transit -> rto_received.
 * Back-steps (packing -> picked, packed -> packing, ready_to_ship -> packed) exist for corrections: a package is cancelled, a
 * label is voided.
 */
export const TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  confirmed: ['picking', 'on_hold', 'cancelled'],
  picking: ['picked', 'on_hold', 'cancelled'],
  picked: ['packing', 'picking', 'on_hold', 'cancelled'],
  packing: ['packed', 'picked', 'on_hold', 'cancelled'],
  packed: ['ready_to_ship', 'packing', 'on_hold', 'cancelled'],
  ready_to_ship: ['shipped', 'packed', 'on_hold', 'cancelled'],
  shipped: ['in_transit', 'delivered', 'delivery_failed', 'rto_in_transit'],
  in_transit: ['delivered', 'delivery_failed', 'rto_in_transit'],
  delivery_failed: ['in_transit', 'rto_in_transit', 'delivered'],
  rto_in_transit: ['rto_received'],
  on_hold: [], // leaves through `resume` only
  delivered: [],
  cancelled: [],
  rto_received: [],
};

export const PRE_SHIP: readonly FulfillmentStatus[] = ['confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship'];
export const TERMINAL: readonly FulfillmentStatus[] = ['delivered', 'cancelled', 'rto_received'];
/** statuses in which the warehouse still owns the goods */
export const IN_WAREHOUSE: readonly FulfillmentStatus[] = [...PRE_SHIP, 'on_hold'];

export const canTransition = (from: FulfillmentStatus, to: FulfillmentStatus): boolean => TRANSITIONS[from].includes(to);
export const canHold = (from: FulfillmentStatus): boolean => PRE_SHIP.includes(from);
export const canResumeTo = (holdFrom: string | null): holdFrom is FulfillmentStatus => holdFrom !== null && (PRE_SHIP as readonly string[]).includes(holdFrom);

// ------------------------------------------------------------------------------------------------
// fulfillment status <-> order status
// ------------------------------------------------------------------------------------------------
/** the order-level (marketplace-facing) status a fulfillment status corresponds to; null = it does not move the order */
export function orderStatusFor(s: FulfillmentStatus): InternalOrderStatus | null {
  switch (s) {
    case 'confirmed': return 'confirmed';
    case 'picking': case 'picked': case 'packing': return 'picking';
    case 'packed': return 'packed';
    case 'ready_to_ship': return 'ready_to_dispatch';
    case 'shipped': return 'dispatched';
    case 'in_transit': case 'delivery_failed': case 'rto_in_transit': return 'in_transit';
    case 'delivered': return 'delivered';
    case 'rto_received': return 'returned';
    default: return null; // on_hold, cancelled
  }
}

export const ORDER_SEQUENCE: readonly InternalOrderStatus[] = ['confirmed', 'picking', 'packed', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered'];

/**
 * The order status implied by ALL its fulfillments. An order that ships from two warehouses is only as far along as its
 * slowest part: packed when every part is packed, dispatched when every part is shipped... Cancelled parts are ignored; an
 * order is `returned` only when every live part came back; on-hold parts do not hold the order below what it already is.
 */
export function deriveOrderStatus(statuses: readonly FulfillmentStatus[]): InternalOrderStatus | null {
  const live = statuses.filter((s) => s !== 'cancelled');
  if (live.length === 0) return null;
  if (live.every((s) => s === 'rto_received')) return 'returned';
  const ranks = live.filter((s) => s !== 'on_hold' && s !== 'rto_received').map((s) => ORDER_SEQUENCE.indexOf(orderStatusFor(s)!)).filter((i) => i >= 0);
  if (ranks.length === 0) return null;
  return ORDER_SEQUENCE[Math.min(...ranks)]!;
}

/** the one-step-at-a-time path an order must walk to get from `current` to `target` (empty when already there or ahead) */
export function orderPath(current: InternalOrderStatus, target: InternalOrderStatus): InternalOrderStatus[] {
  const from = ORDER_SEQUENCE.indexOf(current);
  const to = ORDER_SEQUENCE.indexOf(target);
  if (from < 0 || to < 0 || to <= from) return [];
  return ORDER_SEQUENCE.slice(from + 1, to + 1) as InternalOrderStatus[];
}

// ------------------------------------------------------------------------------------------------
// barcode verification
// ------------------------------------------------------------------------------------------------
const norm = (s: string): string => s.trim().toUpperCase();
/** a scanned code identifies a variant if it is its barcode or its SKU (case/space-insensitive) */
export const barcodeMatches = (scanned: string, v: { barcode: string | null; sku: string }): boolean => {
  const code = norm(scanned);
  return code.length > 0 && (code === norm(v.sku) || (v.barcode !== null && code === norm(v.barcode)));
};

// ------------------------------------------------------------------------------------------------
// order routing
// ------------------------------------------------------------------------------------------------
export type Strategy = 'priority' | 'nearest' | 'single_warehouse' | 'balanced';

export interface WarehouseInfo { id: string; code: string; priority: number; isDefault: boolean; state?: string | null; pincode?: string | null }
export interface RouteLine { orderItemId: string; variantId: string; quantity: number }
export interface RoutingInput {
  lines: RouteLine[];
  warehouses: WarehouseInfo[];
  /** variantId -> warehouseId -> units this order could take there */
  availability: Map<string, Map<string, number>>;
  destination: { state?: string | null; pincode?: string | null };
  preference: { warehouseIds?: string[]; strategy?: Strategy; allowSplit?: boolean };
  /** warehouses to leave out (e.g. the one that just failed a pick) */
  exclude?: string[];
}
export interface Allocation { warehouseId: string; lines: RouteLine[] }
export interface RoutingPlan {
  strategy: Strategy;
  allocations: Allocation[];
  unallocated: RouteLine[];
  reasons: string[];
  candidates: Array<{ warehouseId: string; code: string; rank: number; score: number; canFulfilAll: boolean; fulfilableUnits: number }>;
}

const prefixLen = (a?: string | null, b?: string | null): number => {
  if (!a || !b) return 0;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
const sameState = (a?: string | null, b?: string | null): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** how well a warehouse suits the destination: same state + a longer shared pincode prefix is closer */
export function proximityScore(w: Pick<WarehouseInfo, 'state' | 'pincode'>, dest: RoutingInput['destination']): number {
  return prefixLen(w.pincode, dest.pincode) * 10 + (sameState(w.state, dest.state) ? 5 : 0);
}

const need = (lines: RouteLine[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  return m;
};

/**
 * Chooses where an order is fulfilled. Deterministic and explainable (`reasons`, `candidates`).
 *  1. candidates = the preferred warehouses (rules / manual) that are active, else every active warehouse;
 *  2. ranked by: explicit preference order, then the strategy (priority | nearest | balanced | single_warehouse), ties by code;
 *  3. the first candidate that can fulfil EVERY line gets the whole order (one parcel is cheaper and simpler);
 *  4. otherwise, if splitting is allowed, lines are filled warehouse by warehouse in rank order;
 *  5. otherwise the best partial warehouse gets what it can and the rest is reported as `unallocated`.
 */
export function planRouting(input: RoutingInput): RoutingPlan {
  const strategy: Strategy = input.preference.strategy ?? 'priority';
  const reasons: string[] = [];
  const excluded = new Set(input.exclude ?? []);
  let pool = input.warehouses.filter((w) => !excluded.has(w.id));
  const preferred = (input.preference.warehouseIds ?? []).filter((id) => pool.some((w) => w.id === id));
  if (input.preference.warehouseIds?.length) {
    if (preferred.length > 0) { pool = pool.filter((w) => preferred.includes(w.id)); reasons.push(`limited to the ${preferred.length} warehouse(s) named by the routing rule`); }
    else reasons.push('the warehouses named by the routing rule are not available; using all active warehouses');
  }
  const totalFor = (w: WarehouseInfo) => [...need(input.lines).keys()].reduce((n, v) => n + (input.availability.get(v)?.get(w.id) ?? 0), 0);
  const required = need(input.lines);
  const canAll = (w: WarehouseInfo) => [...required].every(([v, q]) => (input.availability.get(v)?.get(w.id) ?? 0) >= q);
  const units = (w: WarehouseInfo) => [...required].reduce((n, [v, q]) => n + Math.min(q, input.availability.get(v)?.get(w.id) ?? 0), 0);

  const scored = pool.map((w) => ({ w, score: strategy === 'nearest' ? proximityScore(w, input.destination) : strategy === 'balanced' ? totalFor(w) : 0 }));
  const prefOrder = (id: string) => { const i = preferred.indexOf(id); return i < 0 ? 1e6 : i; };
  scored.sort((a, b) =>
    prefOrder(a.w.id) - prefOrder(b.w.id)
    || b.score - a.score
    || Number(b.w.isDefault) - Number(a.w.isDefault)
    || a.w.priority - b.w.priority
    || a.w.code.localeCompare(b.w.code));
  const candidates = scored.map((s, rank) => ({ warehouseId: s.w.id, code: s.w.code, rank, score: s.score, canFulfilAll: canAll(s.w), fulfilableUnits: units(s.w) }));

  const full = scored.find((s) => canAll(s.w));
  if (full) {
    reasons.push(`${full.w.code} can fulfil the whole order (strategy: ${strategy})`);
    return { strategy, allocations: [{ warehouseId: full.w.id, lines: input.lines.map((l) => ({ ...l })) }], unallocated: [], reasons, candidates };
  }

  const remaining = new Map(input.lines.map((l) => [l.orderItemId, l.quantity]));
  const take = (w: WarehouseInfo, left: Map<string, number>, budget: Map<string, number>): RouteLine[] => {
    const out: RouteLine[] = [];
    for (const l of input.lines) {
      const want = remaining.get(l.orderItemId) ?? 0;
      if (want <= 0) continue;
      const have = budget.get(l.variantId) ?? 0;
      const q = Math.min(want, have);
      if (q <= 0) continue;
      budget.set(l.variantId, have - q);
      remaining.set(l.orderItemId, want - q);
      out.push({ orderItemId: l.orderItemId, variantId: l.variantId, quantity: q });
    }
    void left;
    return out;
  };

  if (input.preference.allowSplit) {
    const allocations: Allocation[] = [];
    for (const s of scored) {
      const budget = new Map([...required.keys()].map((v) => [v, input.availability.get(v)?.get(s.w.id) ?? 0]));
      const lines = take(s.w, remaining, budget);
      if (lines.length) allocations.push({ warehouseId: s.w.id, lines });
    }
    const unallocated = input.lines.map((l) => ({ ...l, quantity: remaining.get(l.orderItemId) ?? 0 })).filter((l) => l.quantity > 0);
    reasons.push(allocations.length > 1 ? `no single warehouse can fulfil the whole order: split across ${allocations.length} warehouses` : 'no single warehouse can fulfil the whole order');
    if (unallocated.length) reasons.push('not enough stock in the allowed warehouses for the remaining units');
    return { strategy, allocations, unallocated, reasons, candidates };
  }

  const best = [...scored].sort((a, b) => units(b.w) - units(a.w) || scored.indexOf(a) - scored.indexOf(b))[0];
  if (!best || units(best.w) === 0) {
    reasons.push('no warehouse has stock for this order');
    return { strategy, allocations: [], unallocated: input.lines.map((l) => ({ ...l })), reasons, candidates };
  }
  const budget = new Map([...required.keys()].map((v) => [v, input.availability.get(v)?.get(best.w.id) ?? 0]));
  const lines = take(best.w, remaining, budget);
  reasons.push(`no single warehouse can fulfil the whole order and splitting is not allowed: ${best.w.code} takes what it has`);
  return { strategy, allocations: lines.length ? [{ warehouseId: best.w.id, lines }] : [], unallocated: input.lines.map((l) => ({ ...l, quantity: remaining.get(l.orderItemId) ?? 0 })).filter((l) => l.quantity > 0), reasons, candidates };
}
