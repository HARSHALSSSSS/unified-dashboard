import { NO_CAPABILITIES, type ConnectorCapabilities, type ConnectorReadiness, type PollingStrategy } from '@oms/marketplace-core';

export const capabilities: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  // static seller auth token: no OAuth, nothing to refresh; rotate it in the seller panel and re-authenticate
  auth: { type: 'custom', refreshable: false },
  account: { fetchProfile: true },
  catalog: { import: true },
  listings: { create: true, update: true, deactivate: true, fetch: true, requiresCategoryMapping: true, categorySearch: true, statusLookup: true },
  inventory: { push: true, pull: true, batch: true },
  pricing: { push: true, pull: false },
  // no push notifications: orders are POLLED (see `polling`)
  orders: { fetch: true, webhook: false, acknowledge: false, updateStatus: true, cancel: true, maxLookbackDays: 7 },
  returns: { fetch: false, webhook: false },
  shipping: { createShipment: false, generateLabel: false, marketplaceManagedLogistics: false, manifest: false },
  limits: { requestsPerSecond: 1, burst: 3, maxBatchSize: 20 },
};

export const readiness: ConnectorReadiness = {
  sandbox: true,
  live: false,
  notes:
    'Snapdeal does not publish its seller API. Endpoints, auth, statuses and payloads here are PROVISIONAL placeholders verified only against the in-process simulator. ' +
    'Obtain the seller API contract from Snapdeal, align dto.ts/client.ts/mappers.ts to it, then run the live-readiness checklist in docs/integrations/CONNECTOR-GUIDE.md.',
};

export const polling: PollingStrategy = {
  orders: { intervalSeconds: 300, lookbackMinutes: 24 * 60, overlapMinutes: 10 },
  listingStatus: { intervalSeconds: 900 },
};
