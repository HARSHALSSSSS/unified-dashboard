import { and, eq, inArray, lt, or, isNull, schema, withSystem, withVendor } from '@oms/database';
import { systemOpCtx, type EventConsumer, type JobHandler } from '@oms/module-kit';
import { manifest } from './manifest';
import { shippingRoutes } from './routes';
import { IN_FLIGHT, PRE_DISPATCH } from './domain';
import { getProvider } from './providers';
import { cancelShipment, refreshTracking } from './service';

export { manifest };
export { shippingRoutes } from './routes';
export { applyTracking, ingestTracking, createShipment, dispatchShipment, cancelShipment, getShipment, toShipmentDto, type ShipmentRow } from './service';
export { getProvider, listProviders, registerProvider, type ShippingProvider, type ShipmentRequest, type ProviderShipment, type TrackingUpdate } from './providers';
export { SHIPMENT_STATUSES, TRANSITIONS as SHIPMENT_TRANSITIONS, canMove as canMoveShipment, fulfillmentStatusFor, type ShipmentStatus } from './domain';

/** An order was cancelled before dispatch: cancel its open shipments (the booking at the provider too). */
const consumers: EventConsumer[] = [{
  event: 'order.cancelled',
  name: 'shipping.cancel-on-order-cancelled',
  async handle(e, c) {
    const vendorId = e.vendorId;
    if (!vendorId) return;
    const ctx = systemOpCtx(c, vendorId, 'shipping-cancel-on-order');
    const S = schema.shipments;
    const open = await withVendor(c.database.db, vendorId, (tx) => tx.select({ id: S.id }).from(S).where(and(eq(S.vendorId, vendorId), eq(S.orderId, e.aggregateId), inArray(S.status, [...PRE_DISPATCH]))));
    for (const s of open) await cancelShipment(ctx, s.id, 'order cancelled');
  },
}];

export const JOB_POLL_TRACKING = 'shipping.poll-tracking';

/**
 * Every few minutes: shipments in flight whose provider can be polled are asked for news (never more often than every 10 minutes
 * per shipment, never more than 200 per run). Providers that only push (or are manual) are skipped.
 */
const jobs: JobHandler[] = [{
  queue: 'maintenance',
  name: JOB_POLL_TRACKING,
  async handle(_env, c) {
    const S = schema.shipments;
    const stale = new Date(Date.now() - 10 * 60_000);
    const due = await withSystem(c.database.db, (tx) => tx.select({ id: S.id, vendorId: S.vendorId, providerCode: S.providerCode }).from(S).where(and(inArray(S.status, [...IN_FLIGHT]), or(isNull(S.lastTrackedAt), lt(S.lastTrackedAt, stale)))).limit(200));
    let polled = 0;
    for (const d of due) {
      let pollable = false;
      try { pollable = getProvider(d.providerCode).capabilities.polling; } catch { /* a provider that is no longer registered is skipped */ }
      if (!pollable) continue;
      try { await refreshTracking(systemOpCtx(c, d.vendorId, 'shipping-poll'), d.id); polled++; } catch (e) { c.logger.warn({ shipmentId: d.id, err: (e as Error).message }, 'tracking poll failed'); }
    }
    if (polled) c.logger.info({ polled }, 'shipment tracking polled');
  },
}];

/**
 * Shipping: provider-neutral. Vendors enable providers (manual, sandbox courier, real couriers later); shipments, labels,
 * manifests, dispatch, tracking and NDR/RTO never depend on a specific courier.
 */
export const shippingModule = { manifest, routes: shippingRoutes, consumers, jobs };
