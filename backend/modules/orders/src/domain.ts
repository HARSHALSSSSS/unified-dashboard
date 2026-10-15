import type { InternalOrderStatus } from '@oms/marketplace-core';

/** statuses before the goods leave the warehouse: stock is (or should be) held for the order */
export const PRE_DISPATCH: readonly InternalOrderStatus[] = ['new', 'confirmed', 'picking', 'packed', 'ready_to_dispatch'];

export const orderNumber = (n: number): string => `ORD-${String(n).padStart(6, '0')}`;

/** item status follows the order status (`allocated` is set when stock is held) */
export function itemStatusFor(status: InternalOrderStatus, allocated: boolean): 'new' | 'allocated' | 'shipped' | 'delivered' | 'cancelled' | 'returned' {
  switch (status) {
    case 'cancelled': return 'cancelled';
    case 'returned': return 'returned';
    case 'delivered': return 'delivered';
    case 'dispatched':
    case 'in_transit': return 'shipped';
    default: return allocated ? 'allocated' : 'new';
  }
}

/** Where an order stands inventory-wise, from how many units are held: pure, tested. */
export function inventoryStatusFor(wanted: number, reserved: number): 'reserved' | 'partial' | 'unallocated' {
  if (wanted <= 0) return 'unallocated';
  return reserved >= wanted ? 'reserved' : reserved > 0 ? 'partial' : 'unallocated';
}
