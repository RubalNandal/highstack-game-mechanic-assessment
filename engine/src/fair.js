import { createHash, createHmac, randomBytes } from 'node:crypto';

const E = 2n ** 52n;
const GROWTH_PER_MS = 0.00006;

export function newServerSeed() {
  return randomBytes(32).toString('hex');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Crash point from a hex digest. Uses the first 52 bits (13 hex chars). */
export function crashPointFromHex(hex) {
  const h = BigInt('0x' + hex.slice(0, 13));
  if (h % 100n === 0n) return 1;
  const cents = (100n * E - h) / (E - h); // BigInt division is floor for positive values
  return Number(cents) / 100;
}

export function crashPoint(serverSeed, roundId) {
  const hex = createHmac('sha256', serverSeed).update(roundId, 'utf8').digest('hex');
  return crashPointFromHex(hex);
}

/** Multiplier after `ms` milliseconds of running, rounded down to 2 decimals. */
export function multiplierAt(ms) {
  return Math.floor(100 * Math.exp(GROWTH_PER_MS * ms)) / 100;
}

/** Multiplier as integer hundredths, to compare without float noise. */
export function toCents(multiplier) {
  return Math.round(multiplier * 100);
}

/** Milliseconds of running needed to reach `multiplier`. */
export function msToReach(multiplier) {
  return Math.log(multiplier) / GROWTH_PER_MS;
}
