/**
 * Reusable bonus mathematics: validate settings, draw the round's bonus and cap a bet's winnings.
 * Receives plain values and returns an outcome; it never reads a database or changes a wallet.
 */
import { createHash, createHmac } from 'node:crypto';
import * as v from 'valibot';

const safeNatural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const preciseMultiplier = v.pipe(
  v.number(),
  v.minValue(0.01),
  v.maxValue(1_000_000),
  v.check(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8,
    'Use at most two multiplier decimals',
  ),
);

// Reject settings that cannot be represented safely by the ticket and money calculations below.
export const ConfigSchema = v.pipe(
  v.strictObject({
    version: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._-]{1,64}$/)),
    triggerChance: v.pipe(
      v.number(),
      v.minValue(0),
      v.maxValue(1),
      v.check(
        (n) => Math.abs(n * 1_000_000 - Math.round(n * 1_000_000)) < 1e-8,
        'Use at most six probability decimals',
      ),
    ),
    multipliers: v.pipe(
      v.array(v.strictObject({ multiplier: preciseMultiplier, weight: safeNatural })),
      v.minLength(1),
      v.maxLength(100),
    ),
    maxWin: v.pipe(safeNatural, v.maxValue(1_000_000_000_000)),
  }),
  v.check(
    (c) =>
      Number.isSafeInteger(c.multipliers.reduce((sum, row) => sum + row.weight, 0)) &&
      c.multipliers.some((row) => row.weight > 0),
    'Weights must have a positive safe-integer total',
  ),
);

export type BonusConfig = v.InferOutput<typeof ConfigSchema>;
export type Seed = { serverSeed: string; nonce: number };
export type Bet = { amount: number; baseWin: number };
export type Outcome = {
  triggered: boolean;
  multiplier: number;
  baseWin: number;
  finalWin: number;
  capped: boolean;
  configVersion: string;
};

/**
 * Check settings loaded from JSON or supplied by a caller; invalid values throw.
 * Freeze the object and its rows so later code cannot change a running round's settings.
 */
export function parseConfig(input: unknown): BonusConfig {
  const c = v.parse(ConfigSchema, input);
  c.multipliers.forEach(Object.freeze);
  Object.freeze(c.multipliers);
  return Object.freeze(c);
}

/**
 * Return a fingerprint of the validated settings for Store.saveConfig.
 * Store compares it with the saved version to reject changed content under the same name.
 */
export function configHash(config: BonusConfig): string {
  const c = parseConfig(config);
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

/**
 * Turn the saved seed, nonce, config version and purpose label into a repeatable ticket.
 * Returns an exact whole number from zero through bound - 1; the same inputs repeat it.
 * Labels separate the trigger decision from multiplier selection.
 */
export function drawBelow(seed: Seed, version: string, label: string, bound: bigint): bigint {
  const range = 1n << 256n;
  if (bound < 1n || bound > range) throw new RangeError('Invalid draw bound');
  // Keep only a range divisible by bound, so no ticket gets an extra way to be selected.
  const limit = range - (range % bound);
  for (let counter = 0; ; counter++) {
    // HMAC gives the same 256-bit number for the same saved key and JSON message.
    // A rejected value changes only this attempt counter, not the saved seed or game settings.
    const bytes = createHmac('sha256', seed.serverSeed)
      .update(JSON.stringify(['bonus-v1', seed.nonce, version, label, counter]))
      .digest('hex');
    const value = BigInt(`0x${bytes}`);
    if (value < limit) return value % bound;
  }
}

/**
 * Calculate a bet's bonus from its saved round inputs and ordinary winnings in cents.
 * The engine calls this at settlement; replay and example cards use the same calculation.
 * Seed + nonce + config choose the factor. The supplied baseWin determines the final money.
 * Return the outcome only: the caller must save it and request payment separately.
 */
export function evaluateBonus(seed: Seed, bet: Bet, input: BonusConfig): Outcome {
  const config = parseConfig(input);
  if (
    !seed.serverSeed ||
    seed.serverSeed.length > 256 ||
    !Number.isSafeInteger(seed.nonce) ||
    seed.nonce < 0
  )
    throw new Error('A non-empty seed and non-negative integer nonce are required');
  if (
    !Number.isSafeInteger(bet.amount) ||
    bet.amount < 1 ||
    !Number.isSafeInteger(bet.baseWin) ||
    bet.baseWin < 0
  )
    throw new Error('Bet and base winnings must be safe integer minor units');
  // Millionths allow fractional chances: 0.05 gives 50,000 winning tickets out of 1,000,000.
  const triggered =
    drawBelow(seed, config.version, 'trigger', 1_000_000n) <
    BigInt(Math.round(config.triggerChance * 1_000_000));
  let multiplier = 1;
  if (triggered) {
    // Weights are relative shares, not percentages: 10/10/10 is valid and uses 30 tickets.
    const total = config.multipliers.reduce((sum, row) => sum + BigInt(row.weight), 0n);
    // A separate multiplier draw chooses a position in that combined weighted range.
    let ticket = drawBelow(seed, config.version, 'multiplier', total);
    for (const row of config.multipliers) {
      if (ticket < BigInt(row.weight)) {
        multiplier = row.multiplier;
        break;
      }
      // Skip this row's positions, making ticket relative to the next row. Zero-weight rows cannot win.
      ticket -= BigInt(row.weight);
    }
  }
  // Convert the factor to hundredths; exact integer division floors fractional cents.
  // For a $20 base win and 5x factor: 2000 * 500 / 100 = 10000 cents ($100).
  const rawWin = (BigInt(bet.baseWin) * BigInt(Math.round(multiplier * 100))) / 100n;
  // Cap the entire payout, including ordinary winnings when no bonus triggers (factor 1).
  const cap = BigInt(config.maxWin);
  return {
    triggered,
    multiplier,
    baseWin: bet.baseWin,
    finalWin: Number(rawWin > cap ? cap : rawWin),
    capped: rawWin > cap,
    configVersion: config.version,
  };
}
