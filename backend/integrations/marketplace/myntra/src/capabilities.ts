import { NO_CAPABILITIES, type ConnectorCapabilities, type ConnectorReadiness, type PollingStrategy } from '@oms/marketplace-core';

export const capabilities: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  auth: { type: 'api_key', refreshable: true },
  account: { fetchProfile: true },
  catalog: { import: true },
  listings: { create: true, update: true, deactivate: true, fetch: true, requiresCategoryMapping: true, categorySearch: true, statusLookup: true },
  inventory: { push: true, pull: true, batch: true },
  pricing: { push: true, pull: false },
  // no push notifications: orders are POLLED (see `polling`). Release progress (acknowledge → packed → ready to ship → shipped) is requested through updateOrderStatus.
  orders: { fetch: true, webhook: false, acknowledge: false, updateStatus: true, cancel: false, maxLookbackDays: 14 },
  returns: { fetch: false, webhook: false },
  shipping: { createShipment: false, generateLabel: false, marketplaceManagedLogistics: true, manifest: false },
  limits: { requestsPerSecond: 2, burst: 5, maxBatchSize: 50 },
};

export const readiness: ConnectorReadiness = {
  sandbox: true,
  live: false,
  notes:
    'Myntra does not publish its partner API. Endpoints, auth, statuses and payloads here are PROVISIONAL placeholders verified only against the in-process simulator. ' +
    'Obtain the partner API contract from Myntra, align dto.ts/client.ts/mappers.ts to it, then run the live-readiness checklist in docs/integrations/CONNECTOR-GUIDE.md.',
};

export const polling: PollingStrategy = {
  orders: { intervalSeconds: 180, lookbackMinutes: 24 * 60, overlapMinutes: 10 },
  listingStatus: { intervalSeconds: 900 },
};
