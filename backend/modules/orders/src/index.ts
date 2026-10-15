import { manifest } from './manifest';
import { orderRoutes } from './routes';
import { orderConsumers, orderJobHandlers } from './runners';

export { manifest };
export { orderRoutes, OrderSchema } from './routes';
export { importNormalizedOrder, applyMarketplaceUpdate, type ImportResult, type AccountRow } from './ingest';
export { importOrderForAccount, ingestOrderById, getOrderDetail, toOrderDto, allocateOrder } from './service';
export { requestOrderSync } from './runners';
export { transitionWithin, transitionOrder, recordShortage, clearAttention } from './service';
export { performTransition, requestMarketplaceStatus, getOrderRow, type OrderRow } from './status';
export { CANCELLATION_REASONS } from './cancellations';
export { inventoryStatusFor, itemStatusFor, orderNumber } from './domain';

/**
 * Orders: the normalised order aggregate. Import (poll or webhook) is idempotent per (vendor, marketplace, marketplace
 * order id) and reserves inventory in the same transaction; status changes keep a timeline and tell the marketplace.
 */
export const ordersModule = { manifest, routes: orderRoutes, jobs: orderJobHandlers, consumers: orderConsumers };
