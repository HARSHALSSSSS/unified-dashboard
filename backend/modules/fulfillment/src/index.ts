import { manifest } from './manifest';
import { fulfillmentRoutes } from './routes';
import { fulfillmentConsumers } from './consumers';

export { manifest };
export { fulfillmentRoutes } from './routes';
export {
  Work, getFulfillment, itemsOf, moveFulfillment, syncOrderStatus, fulfillmentDetail, fulfillmentTimeline, recordEvent, holdFulfillment, resumeFulfillment, cancelFulfillment, listFulfillments, type FulfillmentRow, type FulfillmentItemRow,
} from './core';
export { listPackages, packageDetail } from './packing';
export { packagesForShipment, attachPackages, markPackagesShipped, type PackageRow } from './packing';
export { startFulfillment, previewRouting, type StartInput } from './start';
export { raiseException, resolveException, listExceptions, toExceptionDto } from './exceptions';
export { PRE_SHIP, TERMINAL, IN_WAREHOUSE, TRANSITIONS, STATUSES, canTransition, deriveOrderStatus, orderStatusFor, planRouting, barcodeMatches, type FulfillmentStatus } from './domain';

/**
 * Fulfillment: what happens in a warehouse after an order is confirmed. Routing picks the warehouse(s); pick lists and packing
 * drive the fulfillment state machine; the ORDER status is derived from its fulfillments, and the stock reservation follows
 * the routing decision, so this layer stays connected to the inventory and order engines.
 */
export const fulfillmentModule = { manifest, routes: fulfillmentRoutes, consumers: fulfillmentConsumers };
