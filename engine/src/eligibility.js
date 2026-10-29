/**
 * Decide whether a confirmed stake can still enter its intended round.
 */
import { msToReach } from './fair.js';

/**
 * Called around debit acceptance because HTTP waits can outlast the round.
 * Check the actual crash deadline too: a delayed timer might still leave state as running.
 * Returns a boolean; it does not accept, refund or pay the bet itself.
 */
export function canActivateBet(round, roundId, now = Date.now()) {
  return Boolean(
    round &&
    round.id === roundId &&
    (round.state === 'betting' ||
      (round.state === 'running' && now - round.startedAt < msToReach(round.crashPoint))),
  );
}
