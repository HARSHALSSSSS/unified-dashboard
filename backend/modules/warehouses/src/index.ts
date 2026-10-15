import type { FastifyPluginAsync } from 'fastify';
import { manifest } from './manifest';
import { warehouseRoutes } from './routes';
import { warehouseLayoutRoutes } from './layout-routes';

export { manifest };
export { warehouseRoutes, WarehouseSchema } from './routes';
export { allocationOrder, createWarehouse, getWarehouseRow, listWarehouses, toWarehouseDto, type WarehouseRow } from './service';
export { assertWarehouseCapability, allowedWarehouses, capabilitiesOf, findBinByBarcode, getBin, ROLE_CAPABILITIES, type Capability, type WarehouseRole } from './layout';

const routes: FastifyPluginAsync = async (app) => {
  await app.register(warehouseRoutes);
  await app.register(warehouseLayoutRoutes);
};

/** Warehouses: locations, zones, bins and the people who work there (roles + capabilities). Stock itself lives in the Inventory module. */
export const warehousesModule = { manifest, routes };
