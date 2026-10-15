import type { MarketplaceConnector } from '@oms/marketplace-core';
import { FlipkartConnector, type FlipkartOptions } from './adapter';

export { FlipkartConnector, type FlipkartOptions } from './adapter';
export { flipkartControl, flipkartSimulator, flipkartWorld, createFlipkartSimulator } from './simulator';
export { capabilities as flipkartCapabilities, readiness as flipkartReadiness, polling as flipkartPolling } from './capabilities';
export { mapShipment as mapFlipkartShipment, toInternalOrderStatus as toInternalFlipkartOrderStatus, ORDER_STATUS_MAP as FLIPKART_ORDER_STATUS_MAP } from './mappers';
export { FLIPKART_HOSTS } from './environment';

export const createFlipkartConnector = (opts?: FlipkartOptions): MarketplaceConnector => new FlipkartConnector(opts);
