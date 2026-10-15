import { withVendor } from '@oms/database';
import { systemOpCtx, type EventConsumer } from '@oms/module-kit';
import { manifest } from './manifest';
import { returnRoutes } from './routes';
import { createRtoReturn } from './service';

export { manifest };
export { returnRoutes } from './routes';
export { createReturn, createRtoReturn, receiveReturnGoods, inspectReturn, completeReturn, returnDetail, listReturns, type ReturnRow } from './service';
export { RETURN_STATUSES, RETURN_REASONS, TRANSITIONS as RETURN_TRANSITIONS, canMove as canMoveReturn, stockEffect, validateDecision, refundFor, type ReturnStatus, type Disposition } from './domain';

/** The courier brought a parcel back (RTO): open a return order, receive it into the warehouse's `returned` bucket, wait for inspection. */
const consumers: EventConsumer[] = [{
  event: 'shipment.rto_delivered',
  name: 'returns.open-on-rto-delivered',
  async handle(e, c) {
    const vendorId = e.vendorId;
    const p = e.payload as { orderId?: string; warehouseId?: string; awb?: string | null; items?: Array<{ orderItemId: string; quantity: number }> } | null;
    if (!vendorId || !p?.orderId || !p.warehouseId) return;
    const ctx = systemOpCtx(c, vendorId, 'returns-rto');
    await withVendor(c.database.db, vendorId, (tx) => createRtoReturn(tx, ctx, { shipmentId: e.aggregateId, orderId: p.orderId!, warehouseId: p.warehouseId!, items: p.items ?? [], awb: p.awb }));
  },
}];

/**
 * Returns: customer / marketplace / RTO / seller returns as return orders. Receiving, inspection and disposition drive the
 * inventory engine (returned -> on hand / damaged / written off), so stock is always right.
 */
export const returnsModule = { manifest, routes: returnRoutes, consumers };
