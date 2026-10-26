import { msToReach } from './fair.js';

/** A delayed debit cannot enter a round whose crash time has already passed. */
export function canActivateBet(round, roundId, now = Date.now()) {
  return Boolean(
    round &&
    round.id === roundId &&
    (round.state === 'betting' ||
      (round.state === 'running' && now - round.startedAt < msToReach(round.crashPoint))),
  );
}
