import type { MarketplaceConnector } from '@oms/marketplace-core';
import { SnapdealConnector, type SnapdealOptions } from './adapter';

export { SnapdealConnector, type SnapdealOptions } from './adapter';
export { snapdealControl, snapdealSimulator, snapdealWorld, createSnapdealSimulator } from './simulator';
export { capabilities as snapdealCapabilities, readiness as snapdealReadiness, polling as snapdealPolling } from './capabilities';
export { mapOrder as mapSnapdealOrder, toInternalOrderStatus as toInternalSnapdealOrderStatus, ORDER_STATUS_MAP as SNAPDEAL_ORDER_STATUS_MAP } from './mappers';

export const createSnapdealConnector = (opts?: SnapdealOptions): MarketplaceConnector => new SnapdealConnector(opts);
