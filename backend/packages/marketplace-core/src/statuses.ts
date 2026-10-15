/**
 * Internal status models. Marketplaces have their own vocabularies; connectors map THEIR statuses to these and keep
 * the original string alongside (`marketplaceStatus`) for debugging. Core code only ever reasons about these.
 */
export const ORDER_STATUSES = ['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered', 'cancelled', 'returned'] as const;
export type InternalOrderStatus = (typeof ORDER_STATUSES)[number];

/** Forward progress ranks. cancelled/returned are terminal side-exits. */
const RANK: Record<InternalOrderStatus, number> = {
  new: 0, confirmed: 1, picking: 2, packed: 3, ready_to_dispatch: 4, dispatched: 5, in_transit: 6, delivered: 7, cancelled: 99, returned: 99,
};
export const isTerminalOrderStatus = (s: InternalOrderStatus): boolean => s === 'cancelled' || s === 'returned';

/** Allowed MANUAL next steps (an operator moving an order along the fulfilment flow). */
export const MANUAL_NEXT: Record<InternalOrderStatus, InternalOrderStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['picking', 'cancelled'],
  picking: ['packed', 'cancelled'],
  packed: ['ready_to_dispatch', 'cancelled'],
  ready_to_dispatch: ['dispatched', 'cancelled'],
  dispatched: ['in_transit', 'delivered', 'returned'],
  in_transit: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};
export const canManualTransition = (from: InternalOrderStatus, to: InternalOrderStatus): boolean => MANUAL_NEXT[from].includes(to);

/**
 * How a MARKETPLACE-reported status is applied to our order:
 *  - apply  : strictly forward progress, or a cancellation / return
 *  - ignore : same status or a regression (late/out-of-order notification); recorded in the timeline, never applied
 * Cancelling after dispatch is not a cancellation any more: the parcel is on its way back (returned).
 */
export function marketplaceTransition(from: InternalOrderStatus, to: InternalOrderStatus): 'apply' | 'ignore' {
  if (from === to || isTerminalOrderStatus(from)) return 'ignore';
  if (to === 'cancelled') return RANK[from] >= RANK.dispatched ? 'ignore' : 'apply';
  if (to === 'returned') return RANK[from] >= RANK.dispatched ? 'apply' : 'ignore';
  return RANK[to] > RANK[from] ? 'apply' : 'ignore';
}

export const LISTING_STATUSES = ['draft', 'ready', 'approved', 'pending', 'active', 'rejected', 'correction_required', 'unpublished'] as const;
export type InternalListingStatus = (typeof LISTING_STATUSES)[number];
