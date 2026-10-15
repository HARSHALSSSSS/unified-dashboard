import { describe, expect, it } from 'vitest';
import { canManualTransition, fromMinor, isTerminalOrderStatus, marketplaceTransition, MANUAL_NEXT, ORDER_STATUSES, toMinor, type InternalOrderStatus } from '@oms/marketplace-core';
import { computeSellable, contentHash, DEFAULT_POLICY, fromReport, stableHash, validateListingInput } from '../../modules/listings/src/domain';
import { inventoryStatusFor, itemStatusFor, orderNumber, PRE_DISPATCH } from '../../modules/orders/src/domain';
import { backoffMs, classifyFailure } from '../../modules/sync/src/engine';
import { AppError } from '@oms/shared';
import { parseConfig } from '@oms/config';
import { TEST_ENV } from '@oms/testing';

describe('channel quantity (computeSellable)', () => {
  const P = (o: Partial<typeof DEFAULT_POLICY> = {}) => ({ ...DEFAULT_POLICY, ...o });

  it('defaults to everything that is available', () => {
    expect(computeSellable(10, P())).toBe(10);
    expect(computeSellable(0, P())).toBe(0);
  });

  it('applies allocation, then the safety buffer, then the cap — in that order', () => {
    expect(computeSellable(20, P({ allocationPercent: 50, safetyBuffer: 3 }))).toBe(7); // floor(10) - 3
    expect(computeSellable(21, P({ allocationPercent: 50 }))).toBe(10); // floor, never rounds up into stock we do not have
    expect(computeSellable(100, P({ maxQuantity: 25 }))).toBe(25);
    expect(computeSellable(100, P({ allocationPercent: 50, safetyBuffer: 10, maxQuantity: 30 }))).toBe(30);
  });

  it('never negative, never above what is available', () => {
    expect(computeSellable(4, P({ safetyBuffer: 10 }))).toBe(0);
    expect(computeSellable(-5, P())).toBe(0);
    expect(computeSellable(3, P({ maxQuantity: 99 }))).toBe(3);
    expect(computeSellable(3.9, P())).toBe(3);
    for (const avail of [0, 1, 7, 50, 1000]) for (const pct of [0, 10, 100]) for (const buf of [0, 5, 2000]) {
      const q = computeSellable(avail, P({ allocationPercent: pct, safetyBuffer: buf }));
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(avail);
    }
  });

  it('a listing override beats the channel policy', () => {
    expect(computeSellable(10, P({ safetyBuffer: 5 }), { buffer: 1 })).toBe(9);
    expect(computeSellable(10, P({ safetyBuffer: 5 }), { buffer: 0 })).toBe(10); // 0 is a real override, not "unset"
    expect(computeSellable(10, P({ maxQuantity: 8 }), { max: 2 })).toBe(2);
    expect(computeSellable(10, P(), { max: null })).toBe(10);
  });
});

describe('listing validation and the approval hash', () => {
  const base = { externalSku: 'S1', title: 'A good title', priceMinor: 1000, mrpMinor: 1200, currency: 'INR', marketplaceCategoryId: 'C1', attributes: { color: 'Blue' } };
  const reqs = [
    { name: 'color', required: true, type: 'string' as const, maxLength: 10 },
    { name: 'size', required: true, type: 'enum' as const, allowedValues: ['S', 'M'] },
    { name: 'age', required: false, type: 'number' as const },
  ];
  const run = (input: typeof base & { attributes?: Record<string, string | number | boolean> }, o: Partial<Parameters<typeof validateListingInput>[0]> = {}) =>
    validateListingInput({ input, requirements: reqs, categoryRequired: true, imageCount: 1, ...o });

  it('passes a complete listing and reports warnings separately from errors', () => {
    const r = run({ ...base, attributes: { color: 'Blue', size: 'M' } });
    expect(r).toMatchObject({ ready: true, errors: [] });
    expect(run({ ...base, attributes: { color: 'Blue', size: 'M' } }, { imageCount: 0 }).warnings.map((w) => w.code)).toContain('images_missing');
  });

  it('flags every blocker with the attribute it concerns', () => {
    const r = run({ ...base, title: 'x', priceMinor: 0, marketplaceCategoryId: undefined as never, attributes: { color: 'WayTooLongColourName', size: 'XL', age: 'abc' } });
    const byCode = Object.fromEntries(r.errors.map((e) => [e.attribute ?? e.code, e.code]));
    expect(r.ready).toBe(false);
    expect(byCode).toMatchObject({ title: 'title_missing', price: 'price_missing', category: 'category_missing', color: 'attribute_too_long', size: 'attribute_not_allowed', age: 'attribute_invalid' });
    expect(run({ ...base, attributes: { color: 'Blue' } }).errors).toEqual([expect.objectContaining({ code: 'attribute_missing', attribute: 'size' })]);
  });

  it('price above MRP is an error; a marketplace without category mapping needs no category', () => {
    expect(run({ ...base, priceMinor: 5000, attributes: { color: 'Blue', size: 'S' } }).errors.map((e) => e.code)).toEqual(['price_above_mrp']);
    expect(run({ ...base, marketplaceCategoryId: undefined as never, attributes: { color: 'Blue', size: 'S' } }, { categoryRequired: false }).ready).toBe(true);
  });

  it('the content hash is stable, order-independent, and sensitive to every approved field', () => {
    const a = contentHash({ ...base, attributes: { a: 1, b: 2 } }, ['k1']);
    expect(contentHash({ ...base, attributes: { b: 2, a: 1 } }, ['k1'])).toBe(a);
    expect(contentHash({ ...base, quantity: 99, attributes: { a: 1, b: 2 } }, ['k1'])).toBe(a); // quantity syncs on its own: not part of the approval
    expect(contentHash({ ...base, imageUrls: ['https://signed.example/x?sig=1'], attributes: { a: 1, b: 2 } }, ['k1'])).toBe(a); // signed URLs change every call
    for (const change of [{ title: 'Other title' }, { priceMinor: 1001 }, { mrpMinor: 1300 }, { marketplaceCategoryId: 'C2' }, { description: 'new' }, { brand: 'B' }, { barcode: '123456' }, { attributes: { a: 1, b: 3 } }]) {
      expect(contentHash({ ...base, attributes: { a: 1, b: 2 }, ...change }, ['k1']), JSON.stringify(change)).not.toBe(a);
    }
    expect(contentHash({ ...base, attributes: { a: 1, b: 2 } }, ['k1', 'k2'])).not.toBe(a); // an extra image is a change
    expect(stableHash({ x: [1, { y: 2 }] })).toBe(stableHash({ x: [1, { y: 2 }] }));
  });

  it('maps the marketplace status vocabulary', () => {
    expect(fromReport('inactive')).toBe('unpublished');
    for (const s of ['active', 'pending', 'rejected', 'correction_required'] as const) expect(fromReport(s)).toBe(s);
  });
});

describe('order status model', () => {
  const ALL = ORDER_STATUSES as readonly InternalOrderStatus[];

  it('the normalised set is exactly the specified one', () => {
    expect([...ALL]).toEqual(['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered', 'cancelled', 'returned']);
  });

  it('manual flow: forward one step at a time, cancel until dispatch, return after dispatch', () => {
    expect(canManualTransition('new', 'confirmed')).toBe(true);
    expect(canManualTransition('new', 'delivered')).toBe(false);
    expect(canManualTransition('ready_to_dispatch', 'cancelled')).toBe(true);
    expect(canManualTransition('dispatched', 'cancelled')).toBe(false);
    expect(canManualTransition('dispatched', 'returned')).toBe(true);
    expect(canManualTransition('delivered', 'returned')).toBe(true);
    for (const s of ['cancelled', 'returned'] as const) { expect(MANUAL_NEXT[s]).toEqual([]); expect(isTerminalOrderStatus(s)).toBe(true); }
    for (const from of ALL) for (const to of MANUAL_NEXT[from]) expect(ALL).toContain(to);
  });

  it('marketplace reports: forward progress applies; regressions, repeats and impossible jumps are ignored', () => {
    expect(marketplaceTransition('new', 'confirmed')).toBe('apply');
    expect(marketplaceTransition('new', 'dispatched')).toBe('apply'); // the marketplace may skip steps we track
    expect(marketplaceTransition('dispatched', 'confirmed')).toBe('ignore');
    expect(marketplaceTransition('confirmed', 'confirmed')).toBe('ignore');
    expect(marketplaceTransition('packed', 'cancelled')).toBe('apply');
    expect(marketplaceTransition('dispatched', 'cancelled')).toBe('ignore'); // the parcel is out: not a cancellation
    expect(marketplaceTransition('in_transit', 'returned')).toBe('apply');
    expect(marketplaceTransition('new', 'returned')).toBe('ignore');
    expect(marketplaceTransition('cancelled', 'confirmed')).toBe('ignore'); // terminal
    expect(marketplaceTransition('returned', 'delivered')).toBe('ignore');
  });

  it('inventory status and item status derive from the facts', () => {
    expect(inventoryStatusFor(5, 5)).toBe('reserved');
    expect(inventoryStatusFor(5, 2)).toBe('partial');
    expect(inventoryStatusFor(5, 0)).toBe('unallocated');
    expect(inventoryStatusFor(0, 0)).toBe('unallocated');
    expect(itemStatusFor('new', true)).toBe('allocated');
    expect(itemStatusFor('new', false)).toBe('new');
    expect(itemStatusFor('in_transit', true)).toBe('shipped');
    expect(itemStatusFor('cancelled', true)).toBe('cancelled');
    expect(PRE_DISPATCH).toEqual(['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch']);
    expect(orderNumber(42)).toBe('ORD-000042');
  });
});

describe('money', () => {
  it('converts decimal strings and numbers to integer minor units without float drift', () => {
    expect(toMinor('499.00')).toBe(49900);
    expect(toMinor('0.07')).toBe(7);
    expect(toMinor(19.99)).toBe(1999);
    expect(toMinor('1234567.89')).toBe(123456789);
    expect(toMinor(undefined)).toBe(0);
    expect(fromMinor(49900)).toBe('499.00');
    expect(fromMinor(7)).toBe('0.07');
    for (const n of [1, 99, 100, 101, 12345, 99999999]) expect(toMinor(fromMinor(n))).toBe(n);
  });
});

describe('sync engine policy', () => {
  const cfg = (o: Record<string, string> = {}) => parseConfig({ ...TEST_ENV, SYNC_BACKOFF_BASE_MS: '1000', SYNC_BACKOFF_MAX_MS: '60000', ...o });

  it('backs off exponentially with jitter, bounded, and honours Retry-After as a floor', () => {
    const c = { config: cfg() };
    const noJitter = () => 1;
    expect([1, 2, 3, 4, 5].map((n) => backoffMs(c, n, 0, noJitter))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(backoffMs(c, 20, 0, noJitter)).toBe(60_000); // capped
    expect(backoffMs(c, 1, 45_000, noJitter)).toBe(45_000); // Retry-After wins
    const low = backoffMs(c, 3, 0, () => 0);
    expect(low).toBe(3000); // jitter never drops below 75% of the step
    for (let i = 0; i < 50; i++) { const d = backoffMs(c, 3); expect(d).toBeGreaterThanOrEqual(3000); expect(d).toBeLessThanOrEqual(4000); }
  });

  it('decides what is worth retrying', () => {
    const up = (kind: string, code?: string, extra: Record<string, unknown> = {}) => new AppError('UPSTREAM_ERROR', 'x', { details: { kind, ...(code ? { code } : {}), ...extra } });
    expect(classifyFailure(up('transient', 'http_503'))).toMatchObject({ retryable: true, code: 'http_503' });
    expect(classifyFailure(up('rate_limited', undefined, { retryAfterSeconds: 9 }))).toMatchObject({ retryable: true, retryAfterMs: 9000 });
    expect(classifyFailure(new AppError('RATE_LIMITED', 'slow down', { details: { retryAfterSeconds: 2 } }))).toMatchObject({ retryable: true, code: 'RATE_LIMITED', retryAfterMs: 2000 });
    expect(classifyFailure(up('auth'))).toMatchObject({ retryable: false, code: 'AUTH_FAILED' });
    expect(classifyFailure(up('permanent', 'bad_request'))).toMatchObject({ retryable: false, code: 'bad_request' });
    expect(classifyFailure(new AppError('ACCOUNT_NOT_CONNECTED'))).toMatchObject({ retryable: false });
    expect(classifyFailure(new AppError('VALIDATION_FAILED'))).toMatchObject({ retryable: false });
    expect(classifyFailure(new AppError('NOT_FOUND'))).toMatchObject({ retryable: false });
    expect(classifyFailure(new Error('connection reset by peer'))).toMatchObject({ retryable: true, code: 'INTERNAL' }); // unknown = assume transient
  });
});
