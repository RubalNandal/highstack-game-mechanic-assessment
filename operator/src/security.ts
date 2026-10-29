/**
 * Verify shared-secret signatures on wallet requests and private engine actions.
 * This establishes a recent, correctly signed message; bet/payment eligibility is checked separately.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reject malformed headers, timestamps more than 60 seconds away, and mismatched signatures.
 * Compare valid-length signatures without timing differences based on where bytes first differ.
 * Repeated valid messages still need the wallet's stored receipt checks to prevent double payment.
 */
export function verifySignature(
  secret: string,
  timestamp: unknown,
  signature: unknown,
  rawBody: string,
  now = Date.now(),
): boolean {
  if (
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 60) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
