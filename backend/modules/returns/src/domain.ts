/** Pure return rules: the state machine, reason catalogue and what a disposition does to stock. */
export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'in_transit', 'received', 'inspecting', 'completed', 'cancelled'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['pickup_scheduled', 'picked_up', 'in_transit', 'received', 'cancelled'],
  pickup_scheduled: ['picked_up', 'approved', 'cancelled'],
  picked_up: ['in_transit', 'received'],
  in_transit: ['received'],
  received: ['inspecting', 'completed'],
  inspecting: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
};
export const canMove = (from: ReturnStatus, to: ReturnStatus): boolean => TRANSITIONS[from].includes(to);
/** states in which goods can still be received */
export const RECEIVABLE: readonly ReturnStatus[] = ['approved', 'pickup_scheduled', 'picked_up', 'in_transit', 'received'];
/** states that still "use up" the quantity of an order line (a rejected/cancelled return does not) */
export const ACTIVE: readonly ReturnStatus[] = ['requested', 'approved', 'pickup_scheduled', 'picked_up', 'in_transit', 'received', 'inspecting', 'completed'];

export const RETURN_REASONS = [
  { code: 'damaged_in_transit', label: 'Arrived damaged', sources: ['customer', 'marketplace'] },
  { code: 'defective', label: 'Defective / not working', sources: ['customer', 'marketplace'] },
  { code: 'wrong_item_sent', label: 'Wrong item received', sources: ['customer', 'marketplace'] },
  { code: 'not_as_described', label: 'Not as described', sources: ['customer', 'marketplace'] },
  { code: 'size_fit', label: 'Size / fit issue', sources: ['customer', 'marketplace'] },
  { code: 'changed_mind', label: 'Customer changed their mind', sources: ['customer', 'marketplace'] },
  { code: 'late_delivery', label: 'Delivered too late', sources: ['customer', 'marketplace'] },
  { code: 'undeliverable', label: 'Could not be delivered (RTO)', sources: ['rto'] },
  { code: 'recall', label: 'Recalled by the seller', sources: ['seller'] },
  { code: 'other', label: 'Other', sources: ['customer', 'marketplace', 'seller', 'rto'] },
] as const;

export type Disposition = 'restock' | 'damaged' | 'dispose' | 'return_to_vendor' | 'quarantine';
/** what an inspection decision does to the stock buckets (units are in `returned` until decided) */
export function stockEffect(d: Disposition): { kind: 'to_onhand' | 'to_damaged' | 'leave' | 'none'; final: boolean } {
  switch (d) {
    case 'restock': return { kind: 'to_onhand', final: true };
    case 'damaged': return { kind: 'to_damaged', final: true };
    case 'dispose': case 'return_to_vendor': return { kind: 'leave', final: true };
    case 'quarantine': return { kind: 'none', final: false };
  }
}

/** a unit that is not sellable cannot be restocked */
export function validateDecision(condition: string, disposition: Disposition): string | null {
  if (disposition === 'restock' && condition !== 'sellable') return `A ${condition} item cannot be restocked`;
  if (condition === 'missing' && disposition !== 'dispose') return 'A missing item can only be written off (dispose)';
  return null;
}

/** refund = what the customer paid for the returned units (unit price + its tax), pro-rated per unit */
export function refundFor(lines: Array<{ quantity: number; returned: number; unitPriceMinor: number; taxMinor: number; discountMinor: number }>): number {
  return lines.reduce((n, l) => n + Math.max(0, Math.round(((l.unitPriceMinor * l.quantity + l.taxMinor - l.discountMinor) * l.returned) / Math.max(1, l.quantity))), 0);
}
