import { NO_CAPABILITIES, type ConnectorCapabilities, type ConnectorReadiness, type PollingStrategy } from '@oms/marketplace-core';

export const capabilities: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  auth: { type: 'oauth2', refreshable: true, redirectFlow: true },
  account: { fetchProfile: true },
  catalog: { import: true },
  listings: { create: true, update: true, deactivate: true, fetch: true, requiresCategoryMapping: true, categorySearch: true, statusLookup: true },
  // bulk inventory/price endpoints accept many SKUs per call
  inventory: { push: true, pull: true, batch: true },
  pricing: { push: true, pull: true },
  // Flipkart can push order/shipment notifications; polling stays on as the safety net
  orders: { fetch: true, webhook: true, acknowledge: false, updateStatus: true, cancel: true, maxLookbackDays: 30 },
  returns: { fetch: false, webhook: false },
  shipping: { createShipment: false, generateLabel: false, marketplaceManagedLogistics: true, manifest: false },
  limits: { requestsPerSecond: 10, burst: 20, maxBatchSize: 50 },
};

export const readiness: ConnectorReadiness = {
  sandbox: true,
  live: false,
  notes:
    'OAuth2 and shipments follow the public Flipkart Seller API documentation; listings/category/inventory endpoints are PROVISIONAL (modelled on it, not confirmed against Flipkart). ' +
    'Verified against the in-process simulator only. Live use needs a Flipkart seller application; confirm every endpoint against the Flipkart sandbox first (docs/integrations/CONNECTOR-GUIDE.md).',
};

export const polling: PollingStrategy = {
  orders: { intervalSeconds: 300, lookbackMinutes: 24 * 60, overlapMinutes: 15 },
  listingStatus: { intervalSeconds: 600 },
};
