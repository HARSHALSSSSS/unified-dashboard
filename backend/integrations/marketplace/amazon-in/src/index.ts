import type { MarketplaceConnector } from '@oms/marketplace-core';
import { AmazonIndiaConnector, type AmazonOptions } from './adapter';

export { AmazonIndiaConnector, type AmazonOptions } from './adapter';
export { amazonControl, amazonSimulator, amazonWorld, createAmazonSimulator } from './simulator';
export { capabilities as amazonCapabilities, readiness as amazonReadiness, polling as amazonPolling } from './capabilities';
export { mapOrder as mapAmazonOrder, toInternalOrderStatus as toInternalAmazonOrderStatus, ORDER_STATUS_MAP as AMAZON_ORDER_STATUS_MAP } from './mappers';
export { AMAZON_HOSTS, INDIA_MARKETPLACE_ID } from './environment';

export const createAmazonInConnector = (opts?: AmazonOptions): MarketplaceConnector => new AmazonIndiaConnector(opts);
