import { describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError, ConnectorError, ConnectorRegistry, NO_CAPABILITIES, enabledCapabilities, hasCapability, requireCapability, withRetry,
  type MarketplaceConnector,
} from '@oms/marketplace-core';
import { createConnectorRegistry } from '@oms/connectors';
import { signState, verifyState } from '@oms/mod-marketplace-connectors';
import { parseCsv, toCsv } from '../../modules/catalog/src/csv';

const fake = (caps: Partial<MarketplaceConnector['capabilities']> = {}): MarketplaceConnector => ({
  code: 'mock', displayName: 'Fake', implementation: 'beta', readiness: { sandbox: true, live: false, notes: 'test double' }, verifyConnection: async () => ({ ok: true }),
  capabilities: { ...NO_CAPABILITIES, auth: { type: 'api_key', refreshable: false }, ...caps },
});

describe('capability matrix', () => {
  it('starts with everything off and reports only enabled capabilities', () => {
    expect(enabledCapabilities(fake())).toEqual([]);
    const c = fake({ orders: { ...NO_CAPABILITIES.orders, fetch: true, cancel: true }, inventory: { push: true, pull: false, batch: true } });
    expect(enabledCapabilities(c).sort()).toEqual(['inventory.batch', 'inventory.push', 'orders.cancel', 'orders.fetch']);
    expect(hasCapability(c, 'orders.fetch')).toBe(true);
    expect(hasCapability(c, 'orders.webhook')).toBe(false);
  });

  it('requireCapability throws a typed 422 naming marketplace and capability', () => {
    expect(() => requireCapability(fake(), 'listings.create')).toThrow(CapabilityUnsupportedError);
    try { requireCapability(fake(), 'listings.create'); } catch (e) { expect(e).toMatchObject({ status: 422, code: 'CAPABILITY_UNSUPPORTED', details: { marketplace: 'mock', capability: 'listings.create' } }); }
    expect(() => requireCapability(fake({ catalog: { import: true } }), 'catalog.import')).not.toThrow();
  });

  it('the launch connectors really differ (no assumption of uniformity)', () => {
    const r = createConnectorRegistry();
    const caps = Object.fromEntries(r.list().map((c) => [c.code, new Set(enabledCapabilities(c))]));
    expect(caps.mock!.size).toBeGreaterThan(caps.myntra!.size);
    // real differences, not a uniform matrix: bulk vs one-SKU-per-call inventory, cancellable orders, push vs polling
    expect(caps.flipkart!.has('inventory.batch')).toBe(true);
    expect(caps.amazon_in!.has('inventory.batch')).toBe(false);
    expect(caps.snapdeal!.has('orders.cancel')).toBe(true);
    expect(caps.myntra!.has('orders.cancel')).toBe(false);
    expect(caps.amazon_in!.has('orders.cancel')).toBe(false);
    expect(caps.myntra!.has('orders.webhook')).toBe(false);
    expect(r.supporting((c) => hasCapability(c, 'orders.webhook')).map((c) => c.code).sort()).toEqual(['amazon_in', 'flipkart', 'mock']);
  });

  it('registry: rejects duplicates, reports membership, optional sandbox', () => {
    expect(() => new ConnectorRegistry().register(fake()).register(fake())).toThrow(/already registered/);
    expect(createConnectorRegistry({ mock: false }).has('mock')).toBe(false);
    expect(createConnectorRegistry().has('mock')).toBe(true);
  });
});

describe('ConnectorError', () => {
  it('classifies retryability', () => {
    expect(new ConnectorError('transient', 'x').retryable).toBe(true);
    expect(new ConnectorError('rate_limited', 'x').retryable).toBe(true);
    for (const k of ['auth', 'permanent', 'unsupported'] as const) expect(new ConnectorError(k, 'x').retryable).toBe(false);
    expect(new ConnectorError('auth', 'x', { code: 'invalid_grant' }).code).toBe('invalid_grant');
    expect(new ConnectorError('auth', 'x').code).toBe('auth');
  });

  it('withRetry never retries non-ConnectorErrors', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('bug'); }, { sleep: async () => undefined })).rejects.toThrow('bug');
    expect(n).toBe(1);
  });
});

describe('OAuth state (CSRF protection for the redirect flow)', () => {
  const secret = 'state-secret-state-secret-state-secret';
  it('verifies only for the same vendor+account, before expiry', () => {
    const s = signState(secret, 'v1', 'a1', 60_000, 1_000);
    expect(verifyState(secret, s, 'v1', 'a1', 2_000)).toBe(true);
    expect(verifyState(secret, s, 'v2', 'a1', 2_000)).toBe(false);
    expect(verifyState(secret, s, 'v1', 'a2', 2_000)).toBe(false);
    expect(verifyState(secret, s, 'v1', 'a1', 100_000)).toBe(false); // expired
    expect(verifyState('another-secret-another-secret-xx', s, 'v1', 'a1', 2_000)).toBe(false);
  });
  it('rejects tampered and malformed states', () => {
    const s = signState(secret, 'v1', 'a1', 60_000, 1_000);
    const [payload, sig] = s.split('.');
    expect(verifyState(secret, `${payload}x.${sig}`, 'v1', 'a1', 2_000)).toBe(false);
    for (const bad of ['', 'abc', 'a.b', `${payload}.`]) expect(verifyState(secret, bad, 'v1', 'a1', 2_000)).toBe(false);
  });
});

describe('csv', () => {
  it('round-trips quoting, commas, quotes and newlines', () => {
    const rows = [['a', 'b,c', 'd"e', 'line1\nline2'], ['', '1', '2', '3']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('tolerates BOM, CRLF and blank lines', () => {
    expect(parseCsv('﻿x,y\r\n1,2\r\n\r\n3,4')).toEqual([['x', 'y'], ['1', '2'], ['3', '4']]);
  });
  it('neutralises formula injection', () => {
    expect(toCsv([['=1+1', '+SUM(A1)', '-2', '@x', 'ok']])).toBe("'=1+1,'+SUM(A1),'-2,'@x,ok\r\n");
  });
});
