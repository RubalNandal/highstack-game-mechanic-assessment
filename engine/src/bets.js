import { randomUUID } from 'node:crypto';
import { toCents, msToReach } from './fair.js';
import { fatal, getRound } from './game.js';
import { emit } from './stream.js';
import { wallet } from './wallet.js';
import { store } from './runtime.js';
import { canActivateBet } from './eligibility.js';

const sessions = new Map();
const activeBets = new Map();
const inFlight = new Set();
const reply = (status, body) => ({ status, body });

function view(bet) {
  return {
    betId: bet.id,
    playerId: bet.playerId,
    roundId: bet.roundId,
    amount: bet.amount,
    status: bet.status,
    autoCashout: bet.autoCashout === null ? undefined : bet.autoCashout / 100,
    multiplier: bet.multiplier === null ? undefined : bet.multiplier / 100,
    payout: bet.payout,
    payoutStatus: bet.payoutStatus,
    outcome: bet.outcome,
  };
}
export function createSession(playerId) {
  const sessionId = randomUUID();
  sessions.set(sessionId, playerId);
  // Demo sessions are short-lived; browsers create one for each bet request.
  setTimeout(() => sessions.delete(sessionId), 60_000).unref();
  return sessionId;
}
export async function getBet(betId) {
  const bet = await store.getBet(betId);
  return bet ? view(bet) : null;
}
export async function placeBet({ sessionId, roundId, amount, autoCashout, betId }) {
  const playerId = sessions.get(sessionId);
  if (!playerId) return reply(404, { error: 'session_not_found' });
  const existing = betId && (await store.getBet(betId));
  if (!existing) {
    const round = getRound();
    if (round.id !== roundId || round.state !== 'betting' || Date.now() >= round.bettingEndsAt)
      return reply(409, { error: 'betting_closed' });
  }
  const bet = await store.createBet(
    playerId,
    roundId,
    amount,
    autoCashout,
    betId ?? randomUUID(),
  );
  if (bet.status === 'pending') await processDebit(bet);
  const saved = await store.getBet(bet.id);
  if (saved.status === 'rejected')
    return reply(402, { error: 'insufficient_funds', ...view(saved) });
  return reply(saved.status === 'pending' ? 202 : 200, view(saved));
}
async function processDebit(bet) {
  if (inFlight.has(bet.id)) return;
  inFlight.add(bet.id);
  try {
    const result = await wallet.debit({
      txId: bet.debitTxId,
      playerId: bet.playerId,
      amount: bet.amount,
      betId: bet.id,
      roundId: bet.roundId,
    });
    if (result.kind === 'declined') return store.rejectDebit(bet.id);
    if (result.kind !== 'ok') return; // Unknown outcome stays durable and is retried with the same ID.
    const current = getRound();
    const accepted = canActivateBet(current, bet.roundId);
    const saved = await store.confirmDebit(bet.id, Boolean(accepted));
    if (saved?.status === 'active') {
      const latest = getRound();
      if (canActivateBet(latest, bet.roundId)) activeBets.set(saved.id, saved);
      else await store.refundActive(saved.id);
    }
  } finally {
    inFlight.delete(bet.id);
  }
}
export async function cashout(betId) {
  const bet = activeBets.get(betId);
  if (!bet) {
    const saved = await store.getBet(betId);
    if (saved?.status === 'cashed_out') return reply(200, view(saved));
    return reply(saved ? 409 : 404, { error: saved ? 'bet_not_active' : 'bet_not_found' });
  }
  const round = getRound();
  if (
    round.id !== bet.roundId ||
    round.state !== 'running' ||
    Date.now() - round.startedAt >= msToReach(round.crashPoint)
  )
    return reply(409, { error: 'round_not_running' });
  return reply(200, view(await settleCashout(bet, round.multiplier)));
}
async function settleCashout(bet, multiplier) {
  activeBets.delete(bet.id);
  let saved;
  try {
    saved = await store.settleWin(bet.id, multiplier);
  } catch (error) {
    fatal(error);
    throw error;
  }
  emit('bet.cashed_out', {
    betId: bet.id,
    playerId: bet.playerId,
    roundId: bet.roundId,
    multiplier,
    payout: saved.payout,
  });
  return saved;
}
export async function runAutoCashouts(roundId, cents) {
  for (const bet of activeBets.values()) {
    if (bet.roundId === roundId && bet.autoCashout !== null && bet.autoCashout <= cents)
      await settleCashout(bet, bet.autoCashout / 100);
  }
}
export async function settleLostBets(roundId) {
  const ids = [];
  for (const bet of activeBets.values()) {
    if (bet.roundId === roundId) {
      activeBets.delete(bet.id);
      ids.push(bet.id);
    }
  }
  await store.markLost(ids);
}
let recovering = false;
export async function recoverPayments() {
  if (recovering) return;
  recovering = true;
  try {
    for (const bet of await store.pendingDebits()) await processDebit(bet);
    for (const bet of await store.pendingCredits()) {
      await wallet.credit({
        txId: bet.creditTxId,
        playerId: bet.playerId,
        amount: bet.payout,
        betId: bet.id,
        roundId: bet.roundId,
      });
    }
  } finally {
    recovering = false;
  }
}
