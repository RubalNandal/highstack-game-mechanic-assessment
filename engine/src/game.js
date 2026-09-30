import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { crashPoint, msToReach, multiplierAt, newServerSeed, sha256Hex, toCents } from './fair.js';
import { faults } from './faults.js';
import { log } from './log.js';
import { createEvent, currentSeq, emit, send } from './stream.js';

let round = null;
let hooks = { onMultiplier: () => {}, onCrash: () => {} };

export function getRound() {
  return round;
}

export function roundSnapshot() {
  const snapshot = {
    roundId: round.id,
    state: round.state,
    seq: currentSeq(),
    serverSeedHash: round.serverSeedHash,
  };
  if (round.state === 'betting') snapshot.bettingEndsAt = round.bettingEndsAt;
  if (round.state !== 'betting') {
    snapshot.startedAt = round.startedAt;
    snapshot.multiplier = round.multiplier;
  }
  if (round.state === 'crashed') {
    snapshot.crashPoint = round.crashPoint;
    snapshot.serverSeed = round.serverSeed;
  }
  return snapshot;
}

/**
 * hooks.onMultiplier(roundId, cents) runs when the multiplier reaches `cents` (hundredths).
 * hooks.onCrash(roundId) runs when the round crashes.
 */
export function startGame(roundHooks) {
  hooks = roundHooks;
  startBetting();
}

function startBetting() {
  const id = randomUUID();
  const serverSeed = newServerSeed();
  round = {
    id,
    state: 'betting',
    serverSeed,
    serverSeedHash: sha256Hex(serverSeed),
    crashPoint: crashPoint(serverSeed, id),
    bettingEndsAt: Date.now() + config.bettingMs,
    startedAt: null,
    multiplier: 1,
    heldTicks: [],
    holdLastTicks: 0,
  };
  log.info('round betting', { roundId: id });
  emit('round.betting', {
    roundId: id,
    serverSeedHash: round.serverSeedHash,
    bettingEndsAt: round.bettingEndsAt,
  });
  setTimeout(startRunning, config.bettingMs);
}

function startRunning() {
  round.state = 'running';
  round.startedAt = Date.now();
  if (faults.reorder && Math.random() < 0.5) round.holdLastTicks = 1 + Math.floor(Math.random() * 2);

  emit('round.started', { roundId: round.id, startedAt: round.startedAt });
  if (toCents(round.crashPoint) <= 100) return crash();

  const timer = setInterval(() => {
    if (tick()) return;
    clearInterval(timer);
    crash();
  }, config.tickMs);
}

/** Returns false when the round must crash. */
function tick() {
  const t = Date.now() - round.startedAt;
  const multiplier = multiplierAt(t);
  if (toCents(multiplier) >= toCents(round.crashPoint)) return false;

  round.multiplier = multiplier;
  const event = createEvent('tick', { roundId: round.id, multiplier, t });
  if (isNearCrash(t)) round.heldTicks.push(event);
  else send(event);

  hooks.onMultiplier(round.id, toCents(multiplier));
  return true;
}

function isNearCrash(t) {
  if (!round.holdLastTicks) return false;
  return t + round.holdLastTicks * config.tickMs >= msToReach(round.crashPoint);
}

function crash() {
  // Bets with a target below the crash point were passed between two ticks.
  hooks.onMultiplier(round.id, toCents(round.crashPoint) - 1);

  round.state = 'crashed';
  round.multiplier = round.crashPoint;
  log.info('round crashed', { roundId: round.id, crashPoint: round.crashPoint });
  emit('round.crashed', {
    roundId: round.id,
    crashPoint: round.crashPoint,
    serverSeed: round.serverSeed,
  });
  for (const event of round.heldTicks) send(event);
  round.heldTicks = [];

  hooks.onCrash(round.id);
  setTimeout(startBetting, config.crashedPauseMs);
}
