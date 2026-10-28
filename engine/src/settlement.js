import { evaluateBonus } from '@highstack/bonus';

export function calculateOutcome(round, bet, multiplier) {
  if (round.id !== bet.roundId) throw new Error('Bet belongs to a different round');
  const baseWin = Number((BigInt(bet.amount) * BigInt(Math.round(multiplier * 100))) / 100n);
  return evaluateBonus(
    { serverSeed: round.serverSeed, nonce: round.nonce },
    { amount: bet.amount, baseWin },
    round.bonusConfig,
  );
}
