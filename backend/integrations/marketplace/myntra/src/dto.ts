/**
 * Myntra Partner API wire types. Myntra's partner API contract is not public: EVERYTHING here is PROVISIONAL and must be
 * replaced/confirmed against the contract you receive from Myntra before live use (see capabilities.ts readiness).
 */
export interface MynLoginResponse { token: string; expiresIn: number }
export interface MynError { code?: string; message?: string; field?: string }

export type MynReleaseStatus = 'CREATED' | 'ACKNOWLEDGED' | 'PACKED' | 'READY_TO_SHIP' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
export interface MynOrderLine { orderLineId: string; styleId?: string; skuCode: string; name: string; quantity: number; unitPrice: string; tax: string; discount: string; }
export interface MynRelease {
  releaseId: string; createdOn: string; modifiedOn: string; status: MynReleaseStatus; paymentMode: 'PREPAID' | 'COD';
  customerName?: string; customerEmail?: string; customerMobile?: string;
  address?: { line1: string; city: string; state: string; zipcode: string; country: string };
  lines: MynOrderLine[];
  courier?: { name: string; awb: string };
}
export interface MynReleasesPage { releases: MynRelease[]; total: number; offset: number }

export type MynStyleStatus = 'LIVE' | 'IN_REVIEW' | 'REJECTED' | 'NEEDS_CHANGES' | 'DISABLED';
export interface MynStyleError { code: string; message: string; field?: string; warning?: boolean }
export interface MynStyle {
  skuCode: string; styleId?: string; name?: string; brand?: string; articleType?: string; mrp?: string; sellingPrice?: string; quantity?: number;
  status: MynStyleStatus; errors?: MynStyleError[]; attributes?: Record<string, string | number | boolean>; images?: string[];
}
export interface MynStylesPage { styles: MynStyle[]; total: number; offset: number }
export interface MynArticleType { id: string; name: string }
export interface MynAttributeRule { field: string; label?: string; required: boolean; kind: 'text' | 'number' | 'boolean' | 'list'; options?: string[]; maxLen?: number }
export type MynBulkResult = Array<{ skuCode: string; success: boolean; code?: string; message?: string; errors?: MynStyleError[] }>;
