import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Generic HMAC webhook verification helper. Marketplace-specific schemes (header names, payload
 * canonicalisation) are implemented per connector and call this for the constant-time comparison.
 * ALWAYS verify against the RAW request body bytes, never re-serialised JSON.
 */
export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time string comparison that can never throw: both sides are hashed first, so the compared buffers always have the same
 * length (comparing raw buffers throws for equal-length strings whose UTF-8 encodings differ in length, which an attacker can use
 * to turn a header into an unauthenticated 500).
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function verifyHmacSignature(opts: { secret: string; rawBody: string | Buffer; signature: string; timestamp?: number; toleranceSeconds?: number; now?: Date }): boolean {
  if (opts.timestamp !== undefined) {
    const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSec - opts.timestamp) > (opts.toleranceSeconds ?? 300)) return false; // replay protection
  }
  const signed = opts.timestamp !== undefined ? `${opts.timestamp}.${opts.rawBody.toString()}` : opts.rawBody;
  return safeEqual(hmacSha256Hex(opts.secret, signed), opts.signature.replace(/^sha256=/, ''));
}
