import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(secret: string, timestamp: unknown, signature: unknown, rawBody: string, now = Date.now()): boolean {
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 60) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
