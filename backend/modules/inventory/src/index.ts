import type { FastifyPluginAsync } from 'fastify';
import { manifest } from './manifest';
import { inventoryRoutes } from './routes';
import { inventoryOpsRoutes } from './ops-routes';

export { manifest };
export { inventoryRoutes } from './routes';
export { inventoryOpsRoutes } from './ops-routes';
export {
  applyMovement, assertStockTargets, availableOf, nextCounter, type MovementInput, type MovementResult, type MovementType, type StockRow,
} from './ledger';
export {
  addIncoming, adjustStock, availabilityFor, availabilityByWarehouse, commitOrder, disposeReturned, issueOutbound, ledgerDrift, listStock, markDamaged, moveReservation, releaseReservedUnits, receiveReturn, receiveStock, releaseOrder,
  reservationsForOrder, reserveForOrderItem, resolveReturned, setReorderLevel, variantOverview, writeOffDamaged, type Availability, type ReserveInput, type ReserveResult,
} from './service';
export { addToBin, binStockOf, moveBetweenBins, removeFromBin, stockLocations, suggestBins } from './bins';

const routes: FastifyPluginAsync = async (app) => {
  await app.register(inventoryRoutes);
  await app.register(inventoryOpsRoutes);
};

/**
 * Inventory: stock per variant per warehouse with an append-only movement ledger. Reservations hold stock for orders;
 * bins say where it sits; inbound shipments bring it in; channel quantities (marketplaces) are DERIVED from availability.
 */
export const inventoryModule = { manifest, routes };
