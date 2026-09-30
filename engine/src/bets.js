import { randomUUID } from 'node:crypto';
import { toCents } from './fair.js';
import { getRound } from './game.js';
import { log } from './log.js';
import { emit } from './stream.js';
import { wallet } from './wallet.js';

const sessions = new Map(); // sessionId -> playerId
const bets = new Map(); // betId -> bet
const activeBets = new Set();

const reply = (status, body) => ({ status, body });

function view(bet) {
  const { betId, playerId, roundId, amount, status, autoCashout, multiplier, payout } = bet;
  return { betId, playerId, roundId, amount, status, autoCashout, multiplier, payout };
}

export function createSession(playerId) {
  const sessionId = randomUUID();
  sessions.set(sessionId, playerId);
  return sessionId;
}

export function getBet(betId) {
  const bet = bets.get(betId);
  return bet ? view(bet) : null;
}

export async function placeBet({ sessionId, roundId, amount, autoCashout }) {
  const playerId = sessions.get(sessionId);
  if (!playerId) return reply(404, { error: 'session_not_found' });

  const round = getRound();
  if (round.id !== roundId || round.state !== 'betting') {
    return reply(409, { error: 'betting_closed' });
  }

  const bet = { betId: randomUUID(), playerId, roundId, amount, autoCashout, status: 'pending' };
  bets.set(bet.betId, bet);

  const result = await wallet.debit({ txId: randomUUID(), playerId, amount, betId: bet.betId, roundId });

  if (result.kind === 'declined') {
    bet.status = 'rejected';
    return reply(402, { error: 'insufficient_funds', betId: bet.betId, status: bet.status });
  }
  if (result.kind === 'failed') {
    bet.status = 'rejected';
    log.warn('debit failed', { betId: bet.betId, reason: result.reason });
    return reply(502, { error: 'wallet_unavailable', betId: bet.betId, status: bet.status });
  }

  const current = getRound();
  if (current.id === roundId && current.state !== 'crashed') {
    bet.status = 'active';
    activeBets.add(bet);
  } else {
    bet.status = 'lost';
  }
  log.info('bet placed', { betId: bet.betId, playerId, roundId, amount, status: bet.status });
  return reply(200, { betId: bet.betId, status: bet.status });
}

export function cashout(betId) {
  const bet = bets.get(betId);
  if (!bet) return reply(404, { error: 'bet_not_found' });
  if (bet.status !== 'active') return reply(409, { error: 'bet_not_active', status: bet.status });

  const round = getRound();
  if (round.id !== bet.roundId || round.state !== 'running') {
    return reply(409, { error: 'round_not_running' });
  }

  settleCashout(bet, round.multiplier);
  return reply(200, { betId, status: bet.status, multiplier: bet.multiplier, payout: bet.payout });
}

function settleCashout(bet, multiplier) {
  bet.status = 'cashed_out';
  bet.multiplier = multiplier;
  bet.payout = Number((BigInt(bet.amount) * BigInt(toCents(multiplier))) / 100n);
  activeBets.delete(bet);

  log.info('bet cashed out', { betId: bet.betId, multiplier, payout: bet.payout });
  emit('bet.cashed_out', {
    betId: bet.betId,
    playerId: bet.playerId,
    roundId: bet.roundId,
    multiplier,
    payout: bet.payout,
  });

  const payload = {
    txId: randomUUID(),
    playerId: bet.playerId,
    amount: bet.payout,
    betId: bet.betId,
    roundId: bet.roundId,
  };
  wallet.credit(payload).then((result) => {
    if (result.kind !== 'ok') log.error('credit not delivered', { betId: bet.betId, reason: result.reason });
  });
}

/** Cashes out every active bet whose auto-cashout target is at or below `cents`. */
export function runAutoCashouts(roundId, cents) {
  for (const bet of activeBets) {
    if (bet.roundId === roundId && bet.autoCashout && toCents(bet.autoCashout) <= cents) {
      settleCashout(bet, bet.autoCashout);
    }
  }
}

export function settleLostBets(roundId) {
  for (const bet of activeBets) {
    if (bet.roundId !== roundId) continue;
    bet.status = 'lost';
    activeBets.delete(bet);
  }
}
