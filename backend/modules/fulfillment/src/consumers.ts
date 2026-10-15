import { and, eq, inArray, schema, withVendor } from '@oms/database';
import { systemOpCtx, type EventConsumer } from '@oms/module-kit';
import { Work, cancelFulfillment } from './core';
import { PRE_SHIP } from './domain';

/** An order was cancelled (customer, seller, marketplace): stop the warehouse work. Stock was already released by the order engine. */
export const fulfillmentConsumers: EventConsumer[] = [{
  event: 'order.cancelled',
  name: 'fulfillment.cancel-on-order-cancelled',
  async handle(e, c) {
    const vendorId = e.vendorId;
    if (!vendorId) return;
    const orderId = e.aggregateId;
    const ctx = systemOpCtx(c, vendorId, 'fulfillment-cancel-on-order');
    const w = new Work();
    await withVendor(c.database.db, vendorId, async (tx) => {
      const F = schema.fulfillments;
      const rows = await tx.select({ id: F.id }).from(F).where(and(eq(F.vendorId, vendorId), eq(F.orderId, orderId), inArray(F.status, [...PRE_SHIP, 'on_hold'])));
      for (const r of rows) await cancelFulfillment(tx, ctx, w, r.id, 'order cancelled');
    });
    await w.flush(c);
  },
}];
