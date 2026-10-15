/**
 * Snapdeal seller API wire types. Snapdeal's seller API contract is not public: EVERYTHING here is PROVISIONAL and must be
 * confirmed against the contract you receive from Snapdeal before live use (see capabilities.ts readiness).
 */
export interface SdError { errorCode?: string; errorMessage?: string; field?: string }

export type SdOrderState = 'NEW' | 'CONFIRMED' | 'PACKED' | 'MANIFESTED' | 'HANDED_OVER' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
export interface SdSuborder { suborderCode: string; supc?: string; sellerSku: string; productName: string; qty: number; sellingPrice: number; taxAmount: number; discount: number }
export interface SdOrder {
  orderCode: string; orderDate: string; lastUpdated: string; state: SdOrderState; paymentType: 'ONLINE' | 'COD';
  customer?: { name?: string; email?: string; mobile?: string };
  shipTo?: { address: string; city: string; state: string; pincode: string; country: string };
  suborders: SdSuborder[];
  awb?: { courier: string; number: string };
}
export interface SdOrdersPage { orders: SdOrder[]; page: number; pageSize: number; totalPages: number }

export type SdProductState = 'LIVE' | 'QC_PENDING' | 'QC_FAILED' | 'NEEDS_INFO' | 'INACTIVE';
export interface SdProductIssue { code: string; message: string; field?: string; advisory?: boolean }
export interface SdProduct {
  sellerSku: string; supc?: string; productName?: string; brand?: string; categoryId?: string; mrp?: number; sellingPrice?: number; stock?: number;
  state: SdProductState; issues?: SdProductIssue[]; attributes?: Record<string, string | number | boolean>; images?: string[];
}
export interface SdProductsPage { products: SdProduct[]; page: number; totalPages: number }
export interface SdCategory { id: string; name: string; path: string }
export interface SdFieldRule { key: string; title?: string; mandatory: boolean; dataType: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'LIST'; allowed?: string[]; max?: number }
export type SdBulkResult = Array<{ sellerSku: string; ok: boolean; errorCode?: string; errorMessage?: string; issues?: SdProductIssue[] }>;
