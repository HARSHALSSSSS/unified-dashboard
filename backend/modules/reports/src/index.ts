import { manifest } from './manifest';
import { reportRoutes } from './routes';

export { manifest };
export { reportRoutes } from './routes';
export { salesReport, ordersReport, inventoryReport, productsReport, marketplacesReport, returnsReport, fulfillmentReport } from './queries';

/**
 * Reports: the reporting foundation. Tenant-scoped, read-only aggregates (sales, orders, inventory, products, marketplaces,
 * returns, fulfillment). Plain SQL over the operational tables today; a read model or export can sit behind the same endpoints later.
 */
export const reportsModule = { manifest, routes: reportRoutes };
