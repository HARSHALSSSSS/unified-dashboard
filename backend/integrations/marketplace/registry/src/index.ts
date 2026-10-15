import { ConnectorRegistry } from '@oms/marketplace-core';
import { createAmazonInConnector, type AmazonOptions } from '@oms/connector-amazon-in';
import { createFlipkartConnector, type FlipkartOptions } from '@oms/connector-flipkart';
import { createMyntraConnector } from '@oms/connector-myntra';
import { createSnapdealConnector } from '@oms/connector-snapdeal';
import { createMockConnector } from '@oms/connector-mock';

export { mockControl } from '@oms/connector-mock';
export { amazonControl } from '@oms/connector-amazon-in';
export { flipkartControl } from '@oms/connector-flipkart';
export { myntraControl } from '@oms/connector-myntra';
export { snapdealControl } from '@oms/connector-snapdeal';

export interface RegistryOptions {
  /** register the mock sandbox connector */
  mock?: boolean;
  /** platform-level application credentials for redirect-based authorization (live use only; sandbox needs none) */
  amazon?: AmazonOptions['app'];
  flipkart?: FlipkartOptions['app'];
}

/**
 * The ONLY place that knows every concrete connector. Adding a marketplace =
 * new package under integrations/marketplace/<name> + one line here. Core code never changes.
 *
 * `mock` (sandbox) is registered unless disabled; production keeps it off unless MOCK_MARKETPLACE_ENABLED=true.
 * Every real connector declares `readiness.live = false` until verified against the real marketplace; the host enforces it.
 */
export function createConnectorRegistry(opts: RegistryOptions = {}): ConnectorRegistry {
  const registry = new ConnectorRegistry()
    .register(createAmazonInConnector({ app: opts.amazon }))
    .register(createFlipkartConnector({ app: opts.flipkart }))
    .register(createMyntraConnector())
    .register(createSnapdealConnector());
  if (opts.mock ?? true) registry.register(createMockConnector());
  return registry;
}
