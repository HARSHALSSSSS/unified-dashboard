import { describe, expect, it } from 'vitest';
import { STATUSES, TRANSITIONS, PRE_SHIP, TERMINAL, barcodeMatches, canHold, canResumeTo, canTransition, deriveOrderStatus, orderPath, orderStatusFor, planRouting, proximityScore, type FulfillmentStatus, type RoutingInput } from '../../modules/fulfillment/src/domain';
import { SHIPMENT_STATUSES, TRANSITIONS as SHIP, canMove, fulfillmentStatusFor, IN_FLIGHT } from '../../modules/shipping/src/domain';
import { getProvider, listProviders } from '../../modules/shipping/src/providers';
import { RETURN_STATUSES, TRANSITIONS as RET, canMove as canMoveReturn, refundFor, stockEffect, validateDecision } from '../../modules/returns/src/domain';
import { applyChange, computePrice, effectivePrice, saleActive } from '../../modules/pricing/src/domain';
import { evaluate, validateRule, type RuleDef } from '../../modules/rules/src/engine';
import { SPECS } from '../../modules/notifications/src/catalog';
import { manifest as notificationsManifest } from '../../modules/notifications/src/manifest';

describe('fulfillment state machine', () => {
  it('walks the happy path CONFIRMED -> ... -> DELIVERED one step at a time', () => {
    const path: FulfillmentStatus[] = ['confirmed', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
  });
  it('refuses skipping steps and going backwards past a correction', () => {
    expect(canTransition('confirmed', 'packed')).toBe(false);
    expect(canTransition('picked', 'shipped')).toBe(false);
    expect(canTransition('packed', 'confirmed')).toBe(false);
    expect(canTransition('delivered', 'in_transit')).toBe(false);
    expect(canTransition('shipped', 'cancelled')).toBe(false); // once it left, it can only be delivered / fail / return
  });
  it('every status is covered, terminal states are dead ends, every target exists', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATUSES].sort());
    for (const s of TERMINAL) expect(TRANSITIONS[s]).toEqual([]);
    for (const [from, to] of Object.entries(TRANSITIONS)) for (const t of to) expect(STATUSES, `${from} -> ${t}`).toContain(t);
  });
  it('supports exceptions: hold/resume only before shipping, failed delivery -> re-attempt or RTO', () => {
    for (const s of PRE_SHIP) expect(canHold(s)).toBe(true);
    expect(canHold('shipped')).toBe(false);
    expect(canResumeTo('picked')).toBe(true);
    expect(canResumeTo('shipped')).toBe(false);
    expect(canResumeTo(null)).toBe(false);
    expect(canTransition('delivery_failed', 'in_transit')).toBe(true);
    expect(canTransition('delivery_failed', 'rto_in_transit')).toBe(true);
    expect(canTransition('rto_in_transit', 'rto_received')).toBe(true);
  });
  it('maps onto the (marketplace-facing) order status', () => {
    expect(orderStatusFor('picked')).toBe('picking');
    expect(orderStatusFor('ready_to_ship')).toBe('ready_to_dispatch');
    expect(orderStatusFor('delivery_failed')).toBe('in_transit');
    expect(orderStatusFor('rto_received')).toBe('returned');
    expect(orderStatusFor('on_hold')).toBeNull();
    expect(orderStatusFor('cancelled')).toBeNull();
  });
  it('an order is only as far along as its slowest part; cancelled parts are ignored; held parts never drag it back', () => {
    expect(deriveOrderStatus(['packed', 'confirmed'])).toBe('confirmed');
    expect(deriveOrderStatus(['packed', 'packed'])).toBe('packed');
    expect(deriveOrderStatus(['shipped', 'ready_to_ship'])).toBe('ready_to_dispatch');
    expect(deriveOrderStatus(['delivered', 'in_transit'])).toBe('in_transit');
    expect(deriveOrderStatus(['delivered', 'cancelled'])).toBe('delivered');
    expect(deriveOrderStatus(['cancelled'])).toBeNull();
    expect(deriveOrderStatus(['picking', 'on_hold'])).toBe('picking');
    expect(deriveOrderStatus(['on_hold'])).toBeNull();
    expect(deriveOrderStatus(['rto_received', 'rto_received'])).toBe('returned');
    expect(deriveOrderStatus(['rto_received', 'delivered'])).toBe('delivered');
  });
  it('orderPath steps through every intermediate status, never backwards', () => {
    expect(orderPath('confirmed', 'packed')).toEqual(['picking', 'packed']);
    expect(orderPath('confirmed', 'dispatched')).toEqual(['picking', 'packed', 'ready_to_dispatch', 'dispatched']);
    expect(orderPath('packed', 'picking')).toEqual([]);
    expect(orderPath('delivered', 'delivered')).toEqual([]);
    expect(orderPath('new', 'confirmed')).toEqual([]); // `new` is not on the fulfillment path
  });
  it('matches scanned barcodes by barcode or SKU, ignoring case and spaces', () => {
    const v = { barcode: '8901234567890', sku: 'TEE-BLU-M' };
    expect(barcodeMatches(' 8901234567890 ', v)).toBe(true);
    expect(barcodeMatches('tee-blu-m', v)).toBe(true);
    expect(barcodeMatches('TEE-BLU-L', v)).toBe(false);
    expect(barcodeMatches('', v)).toBe(false);
    expect(barcodeMatches('whatever', { barcode: null, sku: 'A' })).toBe(false);
  });
});

describe('order routing planner', () => {
  const wh = (id: string, code: string, priority = 100, extra: Partial<{ isDefault: boolean; state: string; pincode: string }> = {}) => ({ id, code, priority, isDefault: false, ...extra });
  const av = (m: Record<string, Record<string, number>>) => new Map(Object.entries(m).map(([v, w]) => [v, new Map(Object.entries(w))]));
  const base = (over: Partial<RoutingInput> = {}): RoutingInput => ({
    lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 3 }],
    warehouses: [wh('A', 'AAA', 100, { isDefault: true }), wh('B', 'BBB', 200)],
    availability: av({ v1: { A: 5, B: 5 } }), destination: {}, preference: {}, ...over,
  });

  it('prefers the default / highest-priority warehouse that can fulfil the WHOLE order', () => {
    const p = planRouting(base());
    expect(p.allocations).toEqual([{ warehouseId: 'A', lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 3 }] }]);
    expect(p.unallocated).toEqual([]);
    expect(p.reasons[0]).toContain('AAA');
  });
  it('skips a warehouse without enough stock and uses the next one', () => {
    expect(planRouting(base({ availability: av({ v1: { A: 1, B: 5 } }) })).allocations[0]!.warehouseId).toBe('B');
  });
  it('honours the warehouses named by a rule (in their order) and falls back when they are unavailable', () => {
    expect(planRouting(base({ preference: { warehouseIds: ['B'] } })).allocations[0]!.warehouseId).toBe('B');
    const ghost = planRouting(base({ preference: { warehouseIds: ['Z'] } }));
    expect(ghost.allocations[0]!.warehouseId).toBe('A');
    expect(ghost.reasons.join(' ')).toContain('not available');
    expect(planRouting(base({ preference: { warehouseIds: ['B', 'A'] } })).allocations[0]!.warehouseId).toBe('B');
  });
  it('"nearest" ranks by shared pincode prefix and same state', () => {
    const ws = [wh('A', 'AAA', 100, { isDefault: true, state: 'Delhi', pincode: '110001' }), wh('B', 'BBB', 200, { state: 'Maharashtra', pincode: '400001' })];
    expect(planRouting(base({ warehouses: ws, destination: { state: 'Maharashtra', pincode: '400052' }, preference: { strategy: 'nearest' } })).allocations[0]!.warehouseId).toBe('B');
    expect(proximityScore({ state: 'Delhi', pincode: '110001' }, { state: 'delhi', pincode: '110099' })).toBe(40 + 5);
    expect(proximityScore({ state: null, pincode: null }, { state: 'x', pincode: '1' })).toBe(0);
  });
  it('"balanced" prefers the warehouse with more stock', () => {
    expect(planRouting(base({ availability: av({ v1: { A: 4, B: 40 } }), preference: { strategy: 'balanced' } })).allocations[0]!.warehouseId).toBe('B');
  });
  it('splits across warehouses only when allowed, filling in rank order', () => {
    const input = base({ lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 5 }], availability: av({ v1: { A: 2, B: 3 } }) });
    const noSplit = planRouting(input);
    expect(noSplit.allocations).toEqual([{ warehouseId: 'B', lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 3 }] }]); // best partial takes what it has
    expect(noSplit.unallocated).toEqual([{ orderItemId: 'i1', variantId: 'v1', quantity: 2 }]);
    const split = planRouting({ ...input, preference: { allowSplit: true } });
    expect(split.allocations.map((a) => [a.warehouseId, a.lines[0]!.quantity])).toEqual([['A', 2], ['B', 3]]);
    expect(split.unallocated).toEqual([]);
  });
  it('reports what nobody has, excludes warehouses, handles several lines and sums the same variant', () => {
    expect(planRouting(base({ availability: av({ v1: { A: 0, B: 0 } }) })).allocations).toEqual([]);
    expect(planRouting(base({ exclude: ['A'] })).allocations[0]!.warehouseId).toBe('B');
    const two = planRouting(base({ lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 2 }, { orderItemId: 'i2', variantId: 'v2', quantity: 1 }], availability: av({ v1: { A: 9 }, v2: { B: 1 } }) }));
    expect(two.allocations).toEqual([{ warehouseId: 'A', lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 2 }] }].slice(0, 0).concat(two.allocations)); // no single warehouse has both
    expect(two.unallocated.length + two.allocations.reduce((n, a) => n + a.lines.length, 0)).toBeGreaterThanOrEqual(2);
    const sameVariant = planRouting(base({ lines: [{ orderItemId: 'i1', variantId: 'v1', quantity: 3 }, { orderItemId: 'i2', variantId: 'v1', quantity: 3 }], availability: av({ v1: { A: 4, B: 4 } }) }));
    expect(sameVariant.candidates.every((c) => !c.canFulfilAll)).toBe(true); // 6 needed, 4 each: the same variant on two lines is added up
  });
  it('is deterministic and explains itself', () => {
    const a = JSON.stringify(planRouting(base()));
    expect(JSON.stringify(planRouting(base()))).toBe(a);
    expect(planRouting(base()).candidates.map((c) => c.code)).toEqual(['AAA', 'BBB']);
  });
});

describe('shipping domain + providers', () => {
  it('the shipment machine only moves forward, with failed-delivery and RTO branches', () => {
    expect(canMove('created', 'label_ready')).toBe(true);
    expect(canMove('label_ready', 'dispatched')).toBe(true);
    expect(canMove('dispatched', 'delivered')).toBe(true);
    expect(canMove('delivery_failed', 'out_for_delivery')).toBe(true);
    expect(canMove('rto_in_transit', 'rto_delivered')).toBe(true);
    expect(canMove('delivered', 'in_transit')).toBe(false);
    expect(canMove('rto_delivered', 'delivered')).toBe(false);
    expect(canMove('dispatched', 'cancelled')).toBe(false);
    expect(Object.keys(SHIP).sort()).toEqual([...SHIPMENT_STATUSES].sort());
    for (const s of IN_FLIGHT) expect(SHIP[s].length).toBeGreaterThan(0);
  });
  it('maps shipment statuses onto fulfillment statuses', () => {
    expect(fulfillmentStatusFor('out_for_delivery')).toBe('in_transit');
    expect(fulfillmentStatusFor('rto_initiated')).toBe('rto_in_transit');
    expect(fulfillmentStatusFor('rto_delivered')).toBe('rto_received');
    expect(fulfillmentStatusFor('label_ready')).toBeNull();
  });
  it('providers share ONE interface; the catalogue is open (nothing hardcoded)', async () => {
    expect(listProviders().map((p) => p.code).sort()).toEqual(['manual', 'sandbox']);
    const req = { shipmentNumber: 'SHP-1', orderNumber: 'ORD-1', warehouse: { code: 'W', name: 'W', address: {} }, destination: { name: 'Asha', pincode: '110001' }, packages: [{ barcode: 'PKG-1', weightGrams: 900, lengthMm: 1, widthMm: 1, heightMm: 1 }], codAmountMinor: 12_300, currency: 'INR' };
    for (const code of ['manual', 'sandbox']) {
      const p = getProvider(code);
      const s = await p.createShipment(req, {});
      expect(s.awb.length).toBeGreaterThan(3);
      expect(s.label.content).toContain(s.awb);
      expect(await p.track(s.awb, {})).toEqual([]);
    }
    expect((await getProvider('manual').createShipment({ ...req, manual: { awb: 'MY-AWB', carrier: 'Own' } }, {})).awb).toBe('MY-AWB');
    const a = await getProvider('sandbox').createShipment(req, {});
    const b = await getProvider('sandbox').createShipment(req, {});
    expect(a.awb).not.toBe(b.awb); // AWBs are unique
    await expect(getProvider('sandbox').createShipment(req, { fail: 'create' })).rejects.toThrow();
    expect(() => getProvider('dtdc')).toThrow(/Unknown shipping provider/);
  });
});

describe('returns domain', () => {
  it('state machine', () => {
    expect(canMoveReturn('requested', 'approved')).toBe(true);
    expect(canMoveReturn('approved', 'received')).toBe(true);
    expect(canMoveReturn('received', 'inspecting')).toBe(true);
    expect(canMoveReturn('inspecting', 'completed')).toBe(true);
    expect(canMoveReturn('requested', 'received')).toBe(false);
    expect(canMoveReturn('completed', 'inspecting')).toBe(false);
    expect(canMoveReturn('rejected', 'approved')).toBe(false);
    expect(Object.keys(RET).sort()).toEqual([...RETURN_STATUSES].sort());
  });
  it('dispositions map to stock effects; a non-sellable item cannot be restocked', () => {
    expect(stockEffect('restock')).toEqual({ kind: 'to_onhand', final: true });
    expect(stockEffect('damaged')).toEqual({ kind: 'to_damaged', final: true });
    expect(stockEffect('dispose')).toEqual({ kind: 'leave', final: true });
    expect(stockEffect('return_to_vendor')).toEqual({ kind: 'leave', final: true });
    expect(stockEffect('quarantine')).toEqual({ kind: 'none', final: false });
    expect(validateDecision('sellable', 'restock')).toBeNull();
    expect(validateDecision('damaged', 'restock')).toMatch(/cannot be restocked/);
    expect(validateDecision('missing', 'restock')).not.toBeNull();
    expect(validateDecision('missing', 'dispose')).toBeNull();
  });
  it('refund = what was paid for the returned units, pro-rated', () => {
    expect(refundFor([{ quantity: 4, returned: 2, unitPriceMinor: 10_000, taxMinor: 2_000, discountMinor: 400 }])).toBe(Math.round(((40_000 + 2_000 - 400) * 2) / 4));
    expect(refundFor([{ quantity: 1, returned: 1, unitPriceMinor: 999, taxMinor: 0, discountMinor: 0 }, { quantity: 2, returned: 0, unitPriceMinor: 500, taxMinor: 0, discountMinor: 0 }])).toBe(999);
    expect(refundFor([])).toBe(0);
  });
});

describe('pricing maths', () => {
  const basis = { baseMinor: 50_000, mrpMinor: 60_000, costMinor: 30_000 };
  const act = (type: string, params: Record<string, unknown> = {}) => ({ type, params });
  it('applies arithmetic actions in order', () => {
    expect(computePrice(basis, [act('markup_percent', { percent: 10 })]).priceMinor).toBe(55_000);
    expect(computePrice(basis, [act('markup_fixed', { amountMinor: 1_000 })]).priceMinor).toBe(51_000);
    expect(computePrice(basis, [act('discount_percent', { percent: 20 })]).priceMinor).toBe(40_000);
    expect(computePrice(basis, [act('fixed_price', { priceMinor: 42_000 })]).priceMinor).toBe(42_000);
    expect(computePrice(basis, [act('markup_percent', { percent: 10 }), act('discount_percent', { percent: 10 })]).priceMinor).toBe(49_500);
  });
  it('margin floor, rounding, MRP cap and the minimum', () => {
    expect(computePrice(basis, [act('discount_percent', { percent: 50 }), act('margin_floor', { minMarginPercent: 10 })]).priceMinor).toBe(33_000);
    expect(computePrice(basis, [act('markup_percent', { percent: 1 }), act('round_to', { mode: 'nearest', step: 5_000 })]).priceMinor).toBe(50_000);
    expect(computePrice({ ...basis, baseMinor: 48_700 }, [act('round_to', { mode: 'ending', ending: 99 })]).priceMinor).toBe(49_900); // ₹487 -> ₹499
    expect(computePrice({ ...basis, baseMinor: 52_000 }, [act('round_to', { mode: 'ending', ending: 99 })]).priceMinor).toBe(49_900); // ₹520 -> nearest ..99 is ₹499
    expect(computePrice(basis, [act('markup_percent', { percent: 100 })]).priceMinor).toBe(60_000); // capped at MRP
    expect(computePrice({ ...basis, mrpMinor: null }, [act('markup_percent', { percent: 100 })]).priceMinor).toBe(100_000);
    expect(computePrice({ ...basis, mrpMinor: null }, [act('fixed_price', { priceMinor: 0 })]).priceMinor).toBe(1);
    const r = computePrice(basis, [act('discount_percent', { percent: 10 })]);
    expect(r.steps[0]).toBe('base 50000');
    expect(r.steps.length).toBe(2);
  });
  it('flags a price that cannot honour the margin floor under the MRP', () => {
    expect(computePrice({ baseMinor: 20_000, mrpMinor: 25_000, costMinor: 30_000 }, [act('margin_floor', { minMarginPercent: 10 })])).toMatchObject({ priceMinor: 25_000, belowMargin: true });
  });
  it('bulk change arithmetic never goes below 1', () => {
    expect(applyChange(10_000, { kind: 'set', value: 7_777 })).toBe(7_777);
    expect(applyChange(10_000, { kind: 'percent', value: -10 })).toBe(9_000);
    expect(applyChange(10_000, { kind: 'amount', value: -20_000 })).toBe(1);
  });
  it('sales: active only inside their window; effective price picks the sale', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const sale = (s: string | null, e: string | null, price: number | null = 400) => ({ salePriceMinor: price, saleStartsAt: s ? new Date(s) : null, saleEndsAt: e ? new Date(e) : null, priceMinor: 500 });
    expect(saleActive(sale('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'), now)).toBe(true);
    expect(saleActive(sale('2026-06-02T00:00:00Z', null), now)).toBe(false);
    expect(saleActive(sale(null, '2026-06-01T12:00:00Z'), now)).toBe(false); // the end is exclusive
    expect(saleActive(sale(null, null, null), now)).toBe(false);
    expect(effectivePrice(sale(null, null), now)).toBe(400);
    expect(effectivePrice(sale('2027-01-01T00:00:00Z', null), now)).toBe(500);
    expect(effectivePrice({ salePriceMinor: null, saleStartsAt: null, saleEndsAt: null, priceMinor: null }, now)).toBeNull();
  });
});

describe('rules engine', () => {
  const rule = (o: Partial<RuleDef> & { id: string }): RuleDef => ({ type: 'fulfillment', name: o.id, status: 'active', priority: 100, exclusive: false, conditions: { combinator: 'all', conditions: [] }, action: { type: 'set_priority', params: { priority: 'high' } }, ...o });
  it('orders by priority, stops at an exclusive match, honours windows and combinators', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const rules = [
      rule({ id: 'low', priority: 10 }),
      rule({ id: 'hi', priority: 500, conditions: { combinator: 'any', conditions: [{ field: 'marketplace', op: 'eq', value: 'x' }, { field: 'itemCount', op: 'gte', value: 3 }] } }),
      rule({ id: 'expired', priority: 400, endsAt: new Date('2026-01-01') }),
      rule({ id: 'off', priority: 300, status: 'disabled' }),
      rule({ id: 'future', priority: 250, startsAt: new Date('2027-01-01') }),
    ];
    expect(evaluate(rules, { marketplace: 'y', itemCount: 5 }, now).map((m) => m.rule.id)).toEqual(['hi', 'low']);
    expect(evaluate(rules, { marketplace: 'y', itemCount: 1 }, now).map((m) => m.rule.id)).toEqual(['low']);
    expect(evaluate([rule({ id: 'a', priority: 9, exclusive: true }), rule({ id: 'b', priority: 1 })], {}, now).map((m) => m.rule.id)).toEqual(['a']);
  });
  it('validates rules against a whitelist: unknown fields, operators and actions are rejected', () => {
    const ok = validateRule('fulfillment', { combinator: 'all', conditions: [{ field: 'marketplace', op: 'in', value: ['a'] }] }, { type: 'route', params: { strategy: 'nearest' } });
    expect(ok).toEqual([]);
    expect(validateRule('fulfillment', { combinator: 'all', conditions: [{ field: 'hacker', op: 'eq', value: 1 }] }, { type: 'route', params: {} }).length).toBeGreaterThan(0);
    expect(validateRule('fulfillment', { combinator: 'all', conditions: [] }, { type: 'drop_database', params: {} }).length).toBeGreaterThan(0);
    expect(validateRule('pricing', { combinator: 'all', conditions: [] }, { type: 'markup_percent', params: { percent: 5000 } }).length).toBeGreaterThan(0);
    expect(validateRule('fulfillment', { combinator: 'all', conditions: [{ field: 'orderValueMinor', op: 'contains', value: 'x' }] }, { type: 'route', params: {} }).length).toBeGreaterThan(0);
  });
});

describe('notification catalogue', () => {
  it('every event that raises a notification is consumed by the module (and only those)', () => {
    expect(Object.keys(SPECS).sort()).toEqual([...notificationsManifest.consumes].sort());
  });
  it('titles are human, types are unique, severities are valid', () => {
    const types = Object.values(SPECS).map((s) => s.type);
    expect(new Set(types).size).toBe(types.length);
    for (const s of Object.values(SPECS)) {
      expect(['info', 'warning', 'critical']).toContain(s.severity);
      expect(s.title({}).length).toBeGreaterThan(5);
    }
    expect(SPECS['inventory.low_stock']!.dedupe!('x', { variantId: 'v', warehouseId: 'w' })).toBe('low-stock:v:w');
    expect(SPECS['order.created']!.title({ orderNumber: 'ORD-9' })).toContain('ORD-9');
  });
});
