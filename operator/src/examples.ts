/**
 * Prepare read-only UI examples with the same bonus module used for live results.
 * These searched inputs illustrate branches; they are not bets or evidence of outcome frequencies.
 */
import { evaluateBonus, type BonusConfig } from '@highstack/bonus';

/**
 * At app startup, search up to 10,000 fixed nonces for available factor/no-bonus/cap examples.
 * Return the inputs and real outcomes for cards; rare cases may be absent and no money is moved.
 */
export function makeExamples(config: BonusConfig) {
  const examples = new Map<string, object>();
  const targets = new Set(
    config.multipliers.filter((row) => row.weight > 0).map((row) => row.multiplier),
  );
  for (let nonce = 0; nonce < 10_000; nonce++) {
    const seed = { serverSeed: 'highstack-documented-example', nonce };
    const bet = { amount: 100, baseWin: 200 };
    const outcome = evaluateBonus(seed, bet, config);
    const label = outcome.triggered ? `${outcome.multiplier}x bonus` : 'No bonus';
    if (!examples.has(label)) examples.set(label, { label, seed, bet, config, outcome });
    if (outcome.triggered && !examples.has('Win cap')) {
      const cappedBet = { amount: 100, baseWin: Math.max(config.maxWin + 1, 200) };
      const cappedOutcome = evaluateBonus(seed, cappedBet, config);
      if (cappedOutcome.capped)
        examples.set('Win cap', {
          label: 'Win cap',
          seed,
          bet: cappedBet,
          config,
          outcome: cappedOutcome,
        });
    }
    if (
      [...targets].every((n) => examples.has(`${n}x bonus`)) &&
      (config.triggerChance === 1 || examples.has('No bonus')) &&
      examples.has('Win cap')
    )
      break;
    if (config.triggerChance === 0) break;
  }
  return [...examples.values()];
}
