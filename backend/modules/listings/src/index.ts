import { manifest } from './manifest';
import { listingRoutes } from './routes';
import { listingJobHandlers } from './runners';
import { listingConsumers } from './consumers';

export { manifest };
export { listingRoutes } from './routes';
export { applyStatusReport, getListingDto, listingsByStatus, toListingDto } from './service';
export { computeSellable, DEFAULT_POLICY, fromReport, validateListingInput, stableHash, type ChannelPolicy, type ListingStatus } from './domain';
export { markDirty, requestInventorySync, requestPriceSync } from './channel';
export { setListingPrice } from './channel';
export { getListingRow, type ListingRow } from './context';
export { systemCtx, type Ctx } from './ctx';

/**
 * Listings & Channels: the master-product -> marketplace-listing flow, category/attribute mapping, marketplace catalogue
 * import, and event-driven channel inventory/price synchronisation.
 */
export const listingsModule = { manifest, routes: listingRoutes, jobs: listingJobHandlers, consumers: listingConsumers };
