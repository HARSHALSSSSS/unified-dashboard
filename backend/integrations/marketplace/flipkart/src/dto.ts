/**
 * Flipkart Seller API wire types used by this connector. They never leave this package.
 * Orders/OAuth follow the public Seller API documentation; the LISTINGS endpoints below are modelled on it but
 * PROVISIONAL (see capabilities.ts `readiness.notes`): confirm each against the Flipkart sandbox before enabling live.
 */
export interface FkTokenResponse { access_token: string; token_type: 'bearer'; expires_in: number; scope?: string; refresh_token?: string }
export interface FkError { error?: string; error_description?: string; message?: string; errors?: Array<{ code?: string; message?: string; attribute?: string }> }

export type FkShipmentState =
  | 'PENDING' | 'APPROVED' | 'PACKING_IN_PROGRESS' | 'PACKED' | 'READY_TO_DISPATCH' | 'PICKUP_COMPLETE' | 'SHIPPED' | 'IN_TRANSIT' | 'DELIVERED'
  | 'CANCELLED' | 'RETURN_REQUESTED' | 'RETURNED';

export interface FkPriceComponents { sellingPrice: number; shippingCharge?: number; totalPrice: number; flipkartDiscount?: number; sellerDiscount?: number; taxAmount?: number }

export interface FkOrderItem {
  orderItemId: string;
  orderId: string;
  listingId?: string;
  fsn?: string;
  sku: string;
  title: string;
  quantity: number;
  status: FkShipmentState;
  priceComponents: FkPriceComponents;
}

export interface FkShipment {
  shipmentId: string;
  orderDate: string;
  updatedAt: string;
  paymentType: 'PREPAID' | 'COD';
  buyerDetails?: { firstName?: string; lastName?: string; email?: string; phone?: string };
  deliveryAddress?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; pinCode?: string; country?: string };
  orderItems: FkOrderItem[];
  trackingDetails?: { trackingId: string; courierName: string };
}

export interface FkShipmentsPage { hasMore: boolean; nextPageToken?: string; shipments: FkShipment[] }

export type FkListingState = 'ACTIVE' | 'INACTIVE' | 'PENDING_REVIEW' | 'REJECTED' | 'CORRECTION_NEEDED';
export interface FkListingError { code: string; message: string; attribute?: string; level?: 'ERROR' | 'WARNING' }
export interface FkListingRecord {
  sku: string;
  listingId?: string;
  fsn?: string;
  title?: string;
  brand?: string;
  category?: string;
  state: FkListingState;
  errors?: FkListingError[];
  price?: { mrp?: number; sellingPrice?: number; currency: string };
  inventory?: number;
  attributes?: Record<string, string | number | boolean>;
  images?: string[];
}
export interface FkListingsPage { hasMore: boolean; nextPageToken?: string; listings: FkListingRecord[] }
export type FkBulkResult = Record<string, { status: 'SUCCESS' | 'FAILURE'; errors?: FkListingError[] }>;
export interface FkCategory { id: string; name: string; path?: string; leaf: boolean }
export interface FkAttributeDef { name: string; displayName?: string; mandatory: boolean; type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'ENUM'; values?: string[]; maxLength?: number }
