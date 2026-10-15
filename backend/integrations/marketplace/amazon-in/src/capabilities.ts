import { NO_CAPABILITIES, type ConnectorCapabilities, type ConnectorReadiness, type ListingRequirement, type PollingStrategy } from '@oms/marketplace-core';

export const capabilities: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  auth: { type: 'oauth2_lwa', refreshable: true, redirectFlow: true },
  account: { fetchProfile: true },
  catalog: { import: true },
  listings: { create: true, update: true, deactivate: true, fetch: true, requiresCategoryMapping: true, categorySearch: true, statusLookup: true },
  // Listings Items PATCH updates ONE SKU per call
  inventory: { push: true, pull: true, batch: false },
  pricing: { push: true, pull: true },
  // notifications are delivered through SQS/EventBridge; an ingress bridge re-posts them signed to our webhook endpoint
  // Orders API has no acknowledge/cancel; shipment confirmation moves an order to Shipped
  orders: { fetch: true, webhook: true, acknowledge: false, updateStatus: true, cancel: false, maxLookbackDays: 30 },
  returns: { fetch: false, webhook: false },
  shipping: { createShipment: false, generateLabel: false, marketplaceManagedLogistics: true, manifest: false },
  // getOrders: 0.0167 rps burst 20; listings items: 5 rps burst 10 (documented defaults; dynamic limits come back in headers)
  limits: { requestsPerSecond: 5, burst: 10, maxBatchSize: 1 },
};

export const readiness: ConnectorReadiness = {
  sandbox: true,
  live: false,
  notes:
    'Modeled on the public SP-API documentation (LWA, Orders v0, Listings Items 2021-08-01, Product Type Definitions). Verified against the in-process simulator only. ' +
    'Live use needs a registered SP-API application and a seller authorization; run the sandbox/production checklist in docs/integrations/CONNECTOR-GUIDE.md first.',
};

/** Orders are the time-critical flow: poll frequently even when notifications are configured (they can be missed). */
export const polling: PollingStrategy = {
  orders: { intervalSeconds: 300, lookbackMinutes: 24 * 60, overlapMinutes: 15 },
  listingStatus: { intervalSeconds: 300 },
};

/**
 * Subset of product-type requirements kept locally. The full schema is a JSON-Schema document behind
 * `GET /definitions/2020-09-01/productTypes/{type}`; extend this table (or fetch + derive) per product type you onboard.
 */
export const PRODUCT_TYPE_REQUIREMENTS: Record<string, ListingRequirement[]> = {
  SHIRT: [
    { name: 'item_name', label: 'Title', required: true, type: 'string', maxLength: 200, coreField: 'title' },
    { name: 'brand', label: 'Brand', required: true, type: 'string', maxLength: 50, coreField: 'brand' },
    { name: 'product_description', label: 'Description', required: false, type: 'string', maxLength: 2000, coreField: 'description' },
    { name: 'color', label: 'Colour', required: true, type: 'string', maxLength: 50 },
    { name: 'size', label: 'Size', required: true, type: 'string', maxLength: 20 },
    { name: 'country_of_origin', label: 'Country of origin', required: true, type: 'string', coreField: 'country_of_origin' },
  ],
  BAG: [
    { name: 'item_name', label: 'Title', required: true, type: 'string', maxLength: 200, coreField: 'title' },
    { name: 'brand', label: 'Brand', required: true, type: 'string', maxLength: 50, coreField: 'brand' },
    { name: 'material', label: 'Material', required: true, type: 'string', maxLength: 50 },
    { name: 'color', label: 'Colour', required: true, type: 'string', maxLength: 50 },
  ],
};
