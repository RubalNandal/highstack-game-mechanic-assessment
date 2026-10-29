/**
 * Bridge between crash-game cash-outs and the reusable bonus calculation.
 * The engine supplies the saved round/bet; database storage and payment happen in other files.
 */
import { evaluateBonus } from '@highstack/bonus';

/**
 * Called by cash-out, or with factor zero when a bet loses.
 * First calculate ordinary winnings from the stake and accepted game multiplier, in cents.
 * Then apply the round's original bonus settings: $10 at 2x gives $20 before any bonus.
 */
export function calculateOutcome(round, bet, multiplier) {
  if (round.id !== bet.roundId) throw new Error('Bet belongs to a different round');
  const baseWin = Number((BigInt(bet.amount) * BigInt(Math.round(multiplier * 100))) / 100n);
  return evaluateBonus(
    { serverSeed: round.serverSeed, nonce: round.nonce },
    { amount: bet.amount, baseWin },
    round.bonusConfig,
  );
}
