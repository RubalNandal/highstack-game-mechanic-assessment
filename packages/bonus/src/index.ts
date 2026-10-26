import { createHash, createHmac } from 'node:crypto';
import * as v from 'valibot';

const safeNatural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const preciseMultiplier = v.pipe(v.number(), v.minValue(0.01), v.maxValue(1_000_000),
  v.check(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use at most two multiplier decimals'));

export const ConfigSchema = v.pipe(v.strictObject({
  version: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._-]{1,64}$/)),
  triggerChance: v.pipe(v.number(), v.minValue(0), v.maxValue(1),
    v.check(n => Math.abs(n * 1_000_000 - Math.round(n * 1_000_000)) < 1e-8, 'Use at most six probability decimals')),
  multipliers: v.pipe(v.array(v.strictObject({ multiplier: preciseMultiplier, weight: safeNatural })), v.minLength(1), v.maxLength(100)),
  maxWin: v.pipe(safeNatural, v.maxValue(1_000_000_000_000)),
}), v.check(c => Number.isSafeInteger(c.multipliers.reduce((sum, row) => sum + row.weight, 0)) &&
  c.multipliers.some(row => row.weight > 0), 'Weights must have a positive safe-integer total'));

export type BonusConfig = v.InferOutput<typeof ConfigSchema>;
export type Seed = { serverSeed: string; nonce: number };
export type Bet = { amount: number; baseWin: number };
export type Outcome = { triggered: boolean; multiplier: number; baseWin: number; finalWin: number; capped: boolean; configVersion: string };

export function parseConfig(input: unknown): BonusConfig {
  const c = v.parse(ConfigSchema, input);
  c.multipliers.forEach(Object.freeze);
  Object.freeze(c.multipliers);
  return Object.freeze(c);
}

export function configHash(config: BonusConfig): string {
  const c = parseConfig(config);
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

/** Rejection sampling avoids favouring small buckets when the bound does not divide 2^256. */
export function drawBelow(seed: Seed, version: string, label: string, bound: bigint): bigint {
  const range = 1n << 256n;
  if (bound < 1n || bound > range) throw new RangeError('Invalid draw bound');
  const limit = range - range % bound;
  for (let counter = 0; ; counter++) {
    const bytes = createHmac('sha256', seed.serverSeed)
      .update(JSON.stringify(['bonus-v1', seed.nonce, version, label, counter])).digest('hex');
    const value = BigInt(`0x${bytes}`);
    if (value < limit) return value % bound;
  }
}

export function evaluateBonus(seed: Seed, bet: Bet, input: BonusConfig): Outcome {
  const config = parseConfig(input);
  if (!seed.serverSeed || seed.serverSeed.length > 256 || !Number.isSafeInteger(seed.nonce) || seed.nonce < 0)
    throw new Error('A non-empty seed and non-negative integer nonce are required');
  if (!Number.isSafeInteger(bet.amount) || bet.amount < 1 || !Number.isSafeInteger(bet.baseWin) || bet.baseWin < 0)
    throw new Error('Bet and base winnings must be safe integer minor units');
  const triggered = drawBelow(seed, config.version, 'trigger', 1_000_000n) < BigInt(Math.round(config.triggerChance * 1_000_000));
  let multiplier = 1;
  if (triggered) {
    const total = config.multipliers.reduce((sum, row) => sum + BigInt(row.weight), 0n);
    let ticket = drawBelow(seed, config.version, 'multiplier', total);
    for (const row of config.multipliers) {
      if (ticket < BigInt(row.weight)) { multiplier = row.multiplier; break; }
      ticket -= BigInt(row.weight);
    }
  }
  const rawWin = BigInt(bet.baseWin) * BigInt(Math.round(multiplier * 100)) / 100n;
  const cap = BigInt(config.maxWin);
  return { triggered, multiplier, baseWin: bet.baseWin, finalWin: Number(rawWin > cap ? cap : rawWin),
    capped: rawWin > cap, configVersion: config.version };
}
