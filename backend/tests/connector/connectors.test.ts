import { describe, expect, it } from 'vitest';
import { createConnectorRegistry } from '@oms/connectors';
import { ConnectorRegistry, MARKETPLACES } from '@oms/marketplace-core';

/**
 * Connector conformance suite. EVERY connector (current and future) is run through these checks, so
 * "adding a marketplace" cannot silently break the core contract. Stage 3 adds recorded-fixture tests per connector.
 */
const registry = createConnectorRegistry();

describe('connector registry', () => {
  it('registers the four launch marketplaces plus the sandbox', () => {
    expect(registry.list().map((c) => c.code).sort()).toEqual([...MARKETPLACES].sort());
    expect(MARKETPLACES).toEqual(['amazon_in', 'flipkart', 'myntra', 'snapdeal', 'mock']);
  });
  it('rejects duplicate registration and unknown lookups', () => {
    expect(() => new ConnectorRegistry().register(registry.get('flipkart')).register(registry.get('flipkart'))).toThrow(/already registered/);
    expect(() => registry.get('ebay')).toThrow(/not found/i);
  });
});

describe.each(registry.list().map((c) => [c.code, c] as const))('connector %s', (_code, c) => {
  it('declares a complete capability matrix', () => {
    const k = c.capabilities;
    for (const section of ['auth', 'orders', 'inventory', 'pricing', 'listings', 'shipping', 'returns', 'limits'] as const) {
      expect(k[section], section).toBeTypeOf('object');
    }
    expect(k.limits.requestsPerSecond).toBeGreaterThan(0);
    expect(k.limits.maxBatchSize).toBeGreaterThan(0);
  });
  it.skipIf(c.implementation === 'planned')('implements every operation its capabilities promise', () => {
    if (c.capabilities.orders.fetch) expect(typeof c.fetchOrders, 'fetchOrders').toBe('function');
    if (c.capabilities.inventory.push) expect(typeof c.pushInventory, 'pushInventory').toBe('function');
    if (c.capabilities.pricing.push) expect(typeof c.pushPrices, 'pushPrices').toBe('function');
    if (c.capabilities.orders.webhook) expect(typeof c.verifyWebhook, 'verifyWebhook').toBe('function');
  });
  it('has a stable code and display name', () => {
    expect(MARKETPLACES).toContain(c.code);
    expect(c.displayName.length).toBeGreaterThan(2);
  });
});

describe('planned connectors', () => {
  it('are clearly marked so core never schedules work for them', () => {
    for (const c of registry.list()) expect(['planned', 'beta', 'ga']).toContain(c.implementation);
  });
});
