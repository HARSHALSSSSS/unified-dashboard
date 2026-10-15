import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalizedWebhook } from '@oms/marketplace-core';
import type { AmzNotification } from './dto';
import { listingStatusOf, toInternalOrderStatus } from './mappers';

/**
 * Amazon does not call HTTPS endpoints directly: SP-API Notifications go to SQS / EventBridge. The platform's ingress
 * bridge (EventBridge API destination or a small forwarder) re-posts each notification to
 * `POST /api/v1/webhooks/amazon_in/{accountId}` and signs the RAW body with the per-account secret:
 *     x-oms-signature: <hex hmac-sha256(secret, rawBody)>
 * Verification is therefore OUR scheme (constant-time), the payload is Amazon's notification envelope.
 */
export const SIGNATURE_HEADER = 'x-oms-signature';

export function sign(secret: string, rawBody: string | Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** constant-time and never throws (hash first: equal-length strings can still encode to different byte lengths) */
const constantTimeEqual = (a: string, b: string): boolean => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function verifyWebhook({ headers, rawBody, secret }: { headers: Record<string, string | undefined>; rawBody: Buffer; secret: string }): boolean {
  const got = headers[SIGNATURE_HEADER];
  if (!got) return false;
  const expected = sign(secret, rawBody);
  return constantTimeEqual(got, expected);
}

export function parseWebhook({ body }: { body: unknown }): NormalizedWebhook | null {
  const n = body as AmzNotification;
  const id = n?.NotificationMetadata?.NotificationId;
  if (!id) return null;
  const key = `amazon-${id}`;
  if (n.NotificationType === 'ORDER_CHANGE' && n.Payload.OrderChangeNotification) {
    const o = n.Payload.OrderChangeNotification;
    const internal = o.OrderStatus ? toInternalOrderStatus(o.OrderStatus) : undefined;
    // the notification carries no order lines: core fetches the order by id (idempotent upsert)
    return { eventType: internal === 'cancelled' ? 'order.cancelled' : 'order.updated', externalId: id, idempotencyKey: key, payload: body, externalOrderId: o.AmazonOrderId };
  }
  if (n.NotificationType === 'LISTINGS_ITEM_STATUS_CHANGE' && n.Payload.ListingsItemStatusChangeNotification) {
    const l = n.Payload.ListingsItemStatusChangeNotification;
    const status = listingStatusOf({ summaries: [{ marketplaceId: '', status: l.Status }], issues: [] });
    return { eventType: 'listing.status_changed', externalId: id, idempotencyKey: key, payload: body, listing: { externalSku: l.Sku, externalListingId: l.Sku, status, marketplaceStatus: l.Status.join(','), issues: [] } };
  }
  return null;
}
