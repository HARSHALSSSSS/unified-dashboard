import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalizedWebhook } from '@oms/marketplace-core';
import type { FkListingState, FkShipmentState } from './dto';
import { toInternalOrderStatus, toListingStatus } from './mappers';

/**
 * Flipkart pushes shipment/listing notifications to the seller's registered callback URL
 * (`POST /api/v1/webhooks/flipkart/{accountId}`). Signature scheme here is PROVISIONAL (confirm against the Flipkart
 * notification documentation): base64 HMAC-SHA256 of the RAW body with the per-account secret in `x-flipkart-signature`.
 */
export const SIGNATURE_HEADER = 'x-flipkart-signature';

export interface FkNotification {
  eventId: string;
  eventType: 'shipment.updated' | 'shipment.cancelled' | 'listing.updated';
  occurredAt: string;
  data: { shipmentId?: string; state?: FkShipmentState; sku?: string; listingId?: string; listingState?: FkListingState };
}

export const sign = (secret: string, rawBody: string | Buffer): string => createHmac('sha256', secret).update(rawBody).digest('base64');

/** constant-time and never throws (hash first: equal-length strings can still encode to different byte lengths) */
const constantTimeEqual = (a: string, b: string): boolean => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function verifyWebhook({ headers, rawBody, secret }: { headers: Record<string, string | undefined>; rawBody: Buffer; secret: string }): boolean {
  const got = headers[SIGNATURE_HEADER];
  if (!got) return false;
  const expected = sign(secret, rawBody);
  return constantTimeEqual(got, expected);
}

export function parseWebhook({ body }: { body: unknown }): NormalizedWebhook | null {
  const n = body as FkNotification;
  if (!n?.eventId || !n.data) return null;
  const key = `flipkart-${n.eventId}`;
  if ((n.eventType === 'shipment.updated' || n.eventType === 'shipment.cancelled') && n.data.shipmentId) {
    const cancelled = n.eventType === 'shipment.cancelled' || (n.data.state ? toInternalOrderStatus(n.data.state) === 'cancelled' : false);
    // the notification carries no lines: core fetches the shipment by id (idempotent upsert)
    return { eventType: cancelled ? 'order.cancelled' : 'order.updated', externalId: n.eventId, idempotencyKey: key, payload: body, externalOrderId: n.data.shipmentId };
  }
  if (n.eventType === 'listing.updated' && n.data.sku && n.data.listingState) {
    return {
      eventType: 'listing.status_changed', externalId: n.eventId, idempotencyKey: key, payload: body,
      listing: { externalSku: n.data.sku, externalListingId: n.data.listingId ?? n.data.sku, status: toListingStatus(n.data.listingState), marketplaceStatus: n.data.listingState, issues: [] },
    };
  }
  return null;
}
