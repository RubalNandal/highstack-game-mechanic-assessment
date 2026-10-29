/**
 * Coordinate bet acceptance, cash-outs, losses and immediate wallet requests.
 * Live bets stay in memory; all saved records and money changes go through the operator API.
 */
import { randomUUID } from 'node:crypto';
import { toCents, msToReach } from './fair.js';
import { fatal, getRound } from './game.js';
import { emit } from './stream.js';
import { wallet } from './wallet.js';
import { operator } from './operator.js';
import { canActivateBet } from './eligibility.js';
import { calculateOutcome } from './settlement.js';

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
/**
 * Let the trusted operator identify a player before placing a bet.
 * Return a temporary in-memory session ID; this starter mechanism is not account login.
 */
export function createSession(playerId) {
  const sessionId = randomUUID();
  sessions.set(sessionId, playerId);
  // Demo sessions are short-lived; browsers create one for each bet request.
  setTimeout(() => sessions.delete(sessionId), 60_000).unref();
  return sessionId;
}
export async function getBet(betId) {
  const bet = await operator.getBet(betId);
  return bet ? view(bet) : null;
}
/**
 * Handle the operator's placement request and return the saved public bet with an HTTP status.
 * New bets must be inside the betting window. Retries keep betId and match the original details.
 * Save the attempt before requesting its stake, so a lost response cannot create a second wager.
 */
export async function placeBet({ sessionId, roundId, amount, autoCashout, betId }) {
  const playerId = sessions.get(sessionId);
  if (!playerId) return reply(404, { error: 'session_not_found' });
  const existing = betId && (await operator.getBet(betId));
  if (!existing) {
    const round = getRound();
    if (round.id !== roundId || round.state !== 'betting' || Date.now() >= round.bettingEndsAt)
      return reply(409, { error: 'betting_closed' });
  }
  const bet = await operator.createBet(
    playerId,
    roundId,
    amount,
    autoCashout,
    betId ?? randomUUID(),
  );
  if (bet.status === 'pending') await processDebit(bet);
  const saved = await operator.getBet(bet.id);
  if (saved.status === 'rejected')
    return reply(402, { error: 'insufficient_funds', ...view(saved) });
  return reply(saved.status === 'pending' ? 202 : 200, view(saved));
}
/**
 * Request a saved pending bet's stake, then accept, reject or refund it based on the answer.
 * A timeout leaves the answer uncertain; a later attempt must reuse the same payment ID.
 * Placement and the one-time startup recovery call this helper.
 */
async function processDebit(bet) {
  // Do not start two debit attempts for this bet at once in the same engine process.
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
    if (result.kind === 'declined') return operator.rejectDebit(bet.id);
    // A missing confirmation cannot prove whether the debit happened; keep the saved pending bet.
    if (result.kind !== 'ok') return;
    const current = getRound();
    const accepted = canActivateBet(current, bet.roundId);
    let saved = await operator.confirmDebit(bet.id, Boolean(accepted));
    if (saved?.status === 'active') {
      // Saving acceptance awaited HTTP: the round may have ended during that wait.
      const latest = getRound();
      if (canActivateBet(latest, bet.roundId)) activeBets.set(saved.id, saved);
      else {
        await operator.refundActive(saved.id);
        saved = await operator.getBet(saved.id);
      }
    }
    if (saved?.status === 'refunded') await payCredit(saved);
  } finally {
    inFlight.delete(bet.id);
  }
}
/**
 * Handle a manual cash-out only before the actual crash deadline, not merely while a timer says running.
 * This internal handler can also retry a saved cash-out's pending credit without calculating another win.
 */
export async function cashout(betId) {
  const bet = activeBets.get(betId);
  if (!bet) {
    const saved = await operator.getBet(betId);
    if (saved?.status === 'cashed_out') return reply(200, view(await payCredit(saved)));
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
/**
 * Shared path for manual and automatic cash-outs: calculate, save, then immediately credit the result.
 * Saving first preserves the amount owed if the engine stops before the separate wallet call.
 * Return the saved bet with its confirmed or still-pending payment status.
 */
async function settleCashout(bet, multiplier) {
  // Remove before awaiting anything, so another cash-out cannot start from the same live bet.
  activeBets.delete(bet.id);
  let saved;
  try {
    const outcome = calculateOutcome(getRound(), bet, multiplier);
    saved = await operator.settleWin(bet.id, multiplier, outcome);
    saved = await payCredit(saved);
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
/**
 * Called by the clock with multiplier hundredths: 200 means 2x, not 200 cents of money.
 * Settle reached targets at their exact chosen factor, even if this clock tick arrived above it.
 */
export async function runAutoCashouts(roundId, cents) {
  for (const bet of activeBets.values()) {
    if (bet.roundId === roundId && bet.autoCashout !== null && bet.autoCashout <= cents)
      await settleCashout(bet, bet.autoCashout / 100);
  }
}
/**
 * At the crash, record zero winnings for bets that never cashed out.
 * A triggered round bonus still pays zero when the bet's ordinary winnings are zero.
 */
export async function settleLostBets(roundId) {
  const losses = [];
  for (const bet of activeBets.values()) {
    if (bet.roundId === roundId) {
      activeBets.delete(bet.id);
      losses.push(bet);
    }
  }
  for (const bet of losses) await operator.markLost(bet.id, calculateOutcome(getRound(), bet, 0));
}
/**
 * Request the saved payout or refund using this bet's fixed credit ID; do not calculate a new amount.
 * Cash-out, late-debit refunds and startup recovery call this. A failed delivery stays pending.
 */
async function payCredit(bet) {
  if (bet.payoutStatus !== 'pending') return bet;
  const result = await wallet.credit({
    txId: bet.creditTxId,
    playerId: bet.playerId,
    amount: bet.payout,
    betId: bet.id,
    roundId: bet.roundId,
  });
  return result.kind === 'ok' ? { ...bet, payoutStatus: 'paid' } : bet;
}

/**
 * Run once at engine startup to retry saved uncertain debits and unpaid winnings/refunds.
 * Original payment IDs let the operator recognise money already applied before a lost response.
 * This is a startup pass, not a repeating payment worker.
 */
export async function recoverPayments() {
  const { debits, credits } = await operator.pendingPayments();
  for (const bet of debits) await processDebit(bet);
  for (const bet of credits) await payCredit(bet);
}
