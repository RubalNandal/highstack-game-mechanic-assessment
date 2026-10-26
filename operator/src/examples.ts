import { evaluateBonus, type BonusConfig } from '@highstack/bonus';

/** Examples use the real module and config; this function has no wallet access. */
export function makeExamples(config: BonusConfig) {
  const examples = new Map<string, object>();
  const targets = new Set(config.multipliers.filter(row => row.weight > 0).map(row => row.multiplier));
  for (let nonce = 0; nonce < 10_000; nonce++) {
    const seed = { serverSeed: 'highstack-documented-example', nonce };
    const bet = { amount: 100, baseWin: 200 };
    const outcome = evaluateBonus(seed, bet, config);
    const label = outcome.triggered ? `${outcome.multiplier}x bonus` : 'No bonus';
    if (!examples.has(label)) examples.set(label, { label, seed, bet, config, outcome });
    if (outcome.triggered && !examples.has('Win cap')) {
      const cappedBet = { amount: 100, baseWin: Math.max(config.maxWin + 1, 200) };
      const cappedOutcome = evaluateBonus(seed, cappedBet, config);
      if (cappedOutcome.capped) examples.set('Win cap', { label: 'Win cap', seed, bet: cappedBet, config, outcome: cappedOutcome });
    }
    if ([...targets].every(n => examples.has(`${n}x bonus`)) && (config.triggerChance === 1 || examples.has('No bonus')) && examples.has('Win cap')) break;
    if (config.triggerChance === 0) break;
  }
  return [...examples.values()];
}
