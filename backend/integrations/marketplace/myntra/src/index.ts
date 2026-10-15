import type { MarketplaceConnector } from '@oms/marketplace-core';
import { MyntraConnector, type MyntraOptions } from './adapter';

export { MyntraConnector, type MyntraOptions } from './adapter';
export { myntraControl, myntraSimulator, myntraWorld, createMyntraSimulator } from './simulator';
export { capabilities as myntraCapabilities, readiness as myntraReadiness, polling as myntraPolling } from './capabilities';
export { mapRelease as mapMyntraRelease, toInternalOrderStatus as toInternalMyntraOrderStatus, ORDER_STATUS_MAP as MYNTRA_ORDER_STATUS_MAP } from './mappers';

export const createMyntraConnector = (opts?: MyntraOptions): MarketplaceConnector => new MyntraConnector(opts);
