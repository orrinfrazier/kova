// Webhook signature verification — HMAC-SHA256 with timing-safe comparison.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook payload signature against a shared secret.
 * Accepts both raw hex and `sha256=`-prefixed signatures.
 */
export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const rawSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  if (rawSig.length === 0) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  // Both must be the same length for timingSafeEqual
  if (rawSig.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(rawSig, 'utf8'), Buffer.from(expected, 'utf8'));
}
