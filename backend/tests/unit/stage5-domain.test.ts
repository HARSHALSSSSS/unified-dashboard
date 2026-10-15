import { describe, expect, it } from 'vitest';
import { CircuitBreaker, TimeoutError, withTimeout } from '../../packages/marketplace-core/src/resilience';
import { classifyStock, healthScore, DEFAULT_THRESHOLDS, type StockLine } from '../../modules/analytics/src/health';
import { computeProfit } from '../../modules/analytics/src/profit';
import { previousRange } from '../../modules/analytics/src/queries';
import { detectAnomalies, type DayPoint } from '../../modules/ai/src/detect';
import { classify } from '../../modules/ai/src/brain';
import { factsOf, render } from '../../modules/automation/src/engine';

const line = (o: Partial<StockLine>): StockLine => ({ variantId: 'v', sku: 'SKU', title: null, onHand: 100, reserved: 0, reorderLevel: null, unitsSold: 0, lastReceivedAt: null, ...o });
const NOW = new Date('2026-06-30T00:00:00Z');

describe('inventory health maths', () => {
  it('days of cover and stockout date come from real sales only', () => {
    const f = classifyStock(line({ onHand: 12, reserved: 0, unitsSold: 60 }), DEFAULT_THRESHOLDS, NOW); // 2/day
    expect(f).toMatchObject({ available: 12, unitsPerDay: 2, daysOfCover: 6, stockoutDate: '2026-07-06' });
    expect(f.flags).toEqual(expect.arrayContaining(['stockout_risk', 'fast_moving']));
    expect(f.suggestedReorderUnits).toBe(48); // 30 days of cover (60) - 12
  });
  it('no sales means no forecast (never an invented one)', () => {
    const f = classifyStock(line({ onHand: 50, unitsSold: 0 }), DEFAULT_THRESHOLDS, NOW);
    expect(f.daysOfCover).toBeNull();
    expect(f.stockoutDate).toBeNull();
    expect(f.flags).not.toContain('stockout_risk');
    expect(f.flags).toContain('slow_moving');
    expect(f.suggestedReorderUnits).toBeNull();
  });
  it('out of stock, low stock, excess and aging', () => {
    expect(classifyStock(line({ onHand: 0, unitsSold: 30 }), DEFAULT_THRESHOLDS, NOW).flags).toContain('out_of_stock');
    expect(classifyStock(line({ onHand: 5, reorderLevel: 10 }), DEFAULT_THRESHOLDS, NOW).flags).toContain('low_stock');
    expect(classifyStock(line({ onHand: 4, reserved: 4, unitsSold: 30 }), DEFAULT_THRESHOLDS, NOW).flags).toContain('out_of_stock'); // reserved stock is not available
    expect(classifyStock(line({ onHand: 1000, unitsSold: 30 }), DEFAULT_THRESHOLDS, NOW).flags).toContain('excess'); // 1000 days of cover
    const old = classifyStock(line({ onHand: 20, unitsSold: 0, lastReceivedAt: new Date('2026-01-01T00:00:00Z') }), DEFAULT_THRESHOLDS, NOW);
    expect(old.flags).toEqual(expect.arrayContaining(['aging', 'excess']));
    expect(old.ageDays).toBeGreaterThan(150);
  });
  it('business health score drops with severity and count, never below 0', () => {
    expect(healthScore([])).toBe(100);
    expect(healthScore([{ severity: 'critical', count: 1 }])).toBeLessThan(healthScore([{ severity: 'warning', count: 1 }]));
    expect(healthScore([{ severity: 'warning', count: 100 }])).toBeLessThan(healthScore([{ severity: 'warning', count: 2 }]));
    expect(healthScore(Array.from({ length: 20 }, () => ({ severity: 'critical' as const, count: 50 })))).toBe(0);
  });
  it('previous period has the same length and ends the day before', () => {
    expect(previousRange({ from: '2026-06-01', to: '2026-06-30' })).toEqual({ from: '2026-05-02', to: '2026-05-31' });
    expect(previousRange({ from: '2026-06-10', to: '2026-06-10' })).toEqual({ from: '2026-06-09', to: '2026-06-09' });
  });
});

describe('profitability keeps actual, estimated and missing apart', () => {
  const o = (x: Partial<Parameters<typeof computeProfit>[0][number]> = {}) => ({ revenue: 100_000, costKnown: 40_000, costCovered: 100_000, shipping: 6_000, fee: 15_000, penalty: 0, refundProcessed: 0, refundPending: 0, feeEstimate: null, ...x });
  it('complete data gives a contribution and margin', () => {
    const p = computeProfit([o()]);
    expect(p).toMatchObject({ contributionMinor: 39_000, marginPercent: 39, completeness: 'estimated', missing: [] }); // cost is the current cost price: an estimate
    expect(p.productCost.basis).toBe('estimated');
    expect(p.shipping.basis).toBe('actual');
    expect(p.marketplaceFees.basis).toBe('actual');
  });
  it('a missing component makes the contribution null, not zero', () => {
    const p = computeProfit([o({ shipping: null })]);
    expect(p.contributionMinor).toBeNull();
    expect(p.marginPercent).toBeNull();
    expect(p.missing).toEqual(['shipping']);
    expect(p.completeness).toBe('incomplete');
    expect(p.knownPartMinor).toBe(100_000 - 40_000 - 15_000); // what is known, labelled as not-a-profit
  });
  it('no cost price anywhere is "missing", never a free product', () => {
    const p = computeProfit([o({ costKnown: 0, costCovered: 0 })]);
    expect(p.productCost).toMatchObject({ amountMinor: null, basis: 'missing' });
    expect(p.missing).toContain('productCost');
  });
  it('fees fall back to the fee profile, labelled estimated; penalties are never guessed', () => {
    const p = computeProfit([o({ fee: null, feeEstimate: 12_000, penalty: 0 })]);
    expect(p.marketplaceFees).toMatchObject({ amountMinor: 12_000, basis: 'estimated' });
    const q = computeProfit([o({ penalty: null })]);
    expect(q.penalties.basis).toBe('missing');
    expect(q.contributionMinor).toBeNull();
  });
  it('partial coverage is reported and blocks the contribution', () => {
    const p = computeProfit([o(), o({ costKnown: 0, costCovered: 0 })]);
    expect(p.productCost.coverage).toBe(0.5);
    expect(p.missing).toContain('productCost');
    expect(p.contributionMinor).toBeNull();
  });
  it('refunds reduce the figure; pending refunds make it an estimate', () => {
    const p = computeProfit([o({ refundProcessed: 10_000, refundPending: 5_000 })]);
    expect(p.refunds).toMatchObject({ amountMinor: 15_000, basis: 'estimated' });
    expect(p.contributionMinor).toBe(24_000);
  });
});

describe('anomaly detection', () => {
  const day = (i: number, over: Partial<DayPoint> = {}): DayPoint => ({ day: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), orders: 20, cancelled: 1, returnedUnits: 1, units: 40, revenueMinor: 1_000_000 + (i % 3) * 20_000, ...over });
  const base = Array.from({ length: 14 }, (_, i) => day(i));
  it('flags a day far outside the recent normal', () => {
    const a = detectAnomalies([...base, day(14, { revenueMinor: 200_000, orders: 4 })]);
    expect(a.map((x) => x.metric)).toEqual(expect.arrayContaining(['revenue', 'orders']));
    expect(a.find((x) => x.metric === 'revenue')).toMatchObject({ direction: 'down' });
  });
  it('does not flag normal variation, short history or tiny shops', () => {
    expect(detectAnomalies([...base, day(14)])).toEqual([]);
    expect(detectAnomalies(base.slice(0, 8))).toEqual([]);
    const tiny = Array.from({ length: 14 }, (_, i) => day(i, { orders: 1, revenueMinor: 50_000, cancelled: 0, returnedUnits: 0, units: 1 }));
    expect(detectAnomalies([...tiny, day(14, { orders: 2, revenueMinor: 100_000, cancelled: 0, returnedUnits: 0, units: 2 })])).toEqual([]);
  });
});

describe('AI question routing', () => {
  it('maps questions to data intents (and says "unknown" instead of guessing)', () => {
    expect(classify('Which products are likely to run out this week?')).toBe('stockout_risk');
    expect(classify('what are my best sellers')).toBe('top_products');
    expect(classify('How is my business doing?')).toBe('sales_summary');
    expect(classify('what is my return rate')).toBe('returns');
    expect(classify('anything unusual lately?')).toBe('anomalies');
    expect(classify('is there dead stock?')).toBe('excess_stock');
    expect(classify('what is my profit margin')).toBe('profitability');
    expect(classify('what is stuck in operations')).toBe('business_issues');
    expect(classify('write me a poem')).toBe('unknown');
  });
});

describe('automation helpers', () => {
  it('turns an event payload into flat facts (top-level + one nested level)', () => {
    const f = factsOf({ type: 'order.created', aggregateId: 'o1', payload: { orderNumber: 'ORD-1', totalMinor: 500, buyer: { city: 'Pune' }, deep: { a: { b: 1 } }, tags: ['x'] } });
    expect(f).toMatchObject({ eventType: 'order.created', aggregateId: 'o1', orderNumber: 'ORD-1', totalMinor: 500, 'buyer.city': 'Pune', tags: ['x'] });
    expect(f['deep.a.b']).toBeUndefined();
  });
  it('renders {{placeholders}} safely (single line, bounded)', () => {
    expect(render('Order {{orderNumber}} for {{totalMinor}}', { orderNumber: 'ORD-9', totalMinor: 250 })).toBe('Order ORD-9 for 250');
    expect(render('{{missing}}|x', {})).toBe('|x');
    expect(render('a\r\nb {{x}}', { x: 'c\nd' })).not.toMatch(/[\r\n]/);
    expect(render('x'.repeat(1000), {}).length).toBe(300);
  });
});

describe('circuit breaker and timeouts', () => {
  it('opens after consecutive failures, fails fast, probes once, then closes on success', () => {
    let t = 0;
    const b = new CircuitBreaker(3, 1000, () => t);
    expect(b.check('a')).toBeNull();
    b.failure('a'); b.failure('a');
    expect(b.check('a')).toBeNull(); // 2 < threshold
    b.failure('a');
    expect(b.check('a')).toBe(1000); // open
    t = 400;
    expect(b.check('a')).toBe(600);
    expect(b.check('b')).toBeNull(); // per account
    t = 1100;
    expect(b.check('a')).toBeNull(); // half-open: one probe
    expect(b.check('a')).not.toBeNull(); // a second concurrent call waits
    b.success('a');
    expect(b.check('a')).toBeNull();
  });
  it('a failed probe re-opens the circuit immediately', () => {
    let t = 0;
    const b = new CircuitBreaker(2, 1000, () => t);
    b.failure('a'); b.failure('a');
    t = 1500;
    expect(b.check('a')).toBeNull();
    b.failure('a');
    expect(b.check('a')).toBe(1000);
  });
  it('a call that takes too long is cut off', async () => {
    await expect(withTimeout(() => new Promise((r) => setTimeout(r, 200)), 20)).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(async () => 7, 100)).resolves.toBe(7);
  });
});
