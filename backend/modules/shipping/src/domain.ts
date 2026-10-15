/** Pure shipping rules: the shipment state machine and how a shipment status maps onto the fulfillment status. */
export const SHIPMENT_STATUSES = [
  'created', 'label_ready', 'manifested', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered',
  'delivery_failed', 'rto_initiated', 'rto_in_transit', 'rto_delivered', 'cancelled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** statuses a courier / tracking source may report */
export const TRACKING_STATUSES = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'rto_in_transit', 'rto_delivered'] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export const TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  created: ['label_ready', 'cancelled'],
  label_ready: ['manifested', 'dispatched', 'cancelled'],
  manifested: ['dispatched', 'label_ready', 'cancelled'],
  dispatched: ['in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'rto_in_transit'],
  in_transit: ['out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'rto_in_transit'],
  out_for_delivery: ['in_transit', 'delivered', 'delivery_failed', 'rto_initiated'],
  delivery_failed: ['in_transit', 'out_for_delivery', 'delivered', 'rto_initiated', 'rto_in_transit'],
  rto_initiated: ['rto_in_transit', 'rto_delivered'],
  rto_in_transit: ['rto_delivered'],
  delivered: [],
  rto_delivered: [],
  cancelled: [],
};
export const canMove = (from: ShipmentStatus, to: ShipmentStatus): boolean => TRANSITIONS[from].includes(to);
export const IN_FLIGHT: readonly ShipmentStatus[] = ['dispatched', 'in_transit', 'out_for_delivery', 'delivery_failed', 'rto_initiated', 'rto_in_transit'];
export const PRE_DISPATCH: readonly ShipmentStatus[] = ['created', 'label_ready', 'manifested'];

/** fulfillment status that goes with a shipment status (null = no change) */
export function fulfillmentStatusFor(s: ShipmentStatus): 'shipped' | 'in_transit' | 'delivered' | 'delivery_failed' | 'rto_in_transit' | 'rto_received' | null {
  switch (s) {
    case 'dispatched': return 'shipped';
    case 'in_transit': case 'out_for_delivery': return 'in_transit';
    case 'delivered': return 'delivered';
    case 'delivery_failed': return 'delivery_failed';
    case 'rto_initiated': case 'rto_in_transit': return 'rto_in_transit';
    case 'rto_delivered': return 'rto_received';
    default: return null;
  }
}

export const DEFAULT_MAX_ATTEMPTS = 3;
