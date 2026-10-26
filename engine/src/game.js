import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { crashPoint, msToReach, multiplierAt, newServerSeed, sha256Hex, toCents } from './fair.js';
import { faults } from './faults.js';
import { log } from './log.js';
import { createEvent, currentSeq, emit, send } from './stream.js';
import { loadBonusConfig, store } from './runtime.js';
import { evaluateBonus } from '@highstack/bonus';

let round = null;
let hooks;
let timer;
let stopped = false;
export function getRound() { return round; }

export function roundSnapshot() {
  if (!round) return { state: 'starting', seq: currentSeq() };
  const snapshot = { roundId: round.id, state: round.state, seq: currentSeq(),
    serverSeedHash: round.serverSeedHash, nonce: round.nonce, configVersion: round.configVersion };
  if (round.state === 'betting') snapshot.bettingEndsAt = round.bettingEndsAt;
  if (round.state !== 'betting') {
    snapshot.startedAt = round.startedAt;
    snapshot.multiplier = round.multiplier;
  }
  if (round.state === 'crashed') {
    snapshot.crashPoint = round.crashPoint;
    snapshot.serverSeed = round.serverSeed;
    snapshot.bonus = round.bonus;
  }
  return snapshot;
}

export async function startGame(roundHooks) {
  hooks = roundHooks;
  await startBetting();
}
export function stopGame() { stopped = true; clearTimeout(timer); }
export function fatal(error) {
  log.error('engine stopped to preserve recoverable state', { error: error.stack ?? error.message });
  stopGame();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50);
}
function schedule(fn, delay) {
  if (!stopped) timer = setTimeout(() => fn().catch(fatal), delay);
}
async function startBetting() {
  const bonus = await loadBonusConfig();
  const id = randomUUID(), serverSeed = newServerSeed();
  const saved = await store.createRound(id, serverSeed, bonus.version);
  round = { id, state: 'betting', serverSeed, serverSeedHash: sha256Hex(serverSeed),
    nonce: saved.nonce, configVersion: bonus.version, crashPoint: crashPoint(serverSeed, id),
    bettingEndsAt: Date.now() + config.bettingMs, startedAt: null, multiplier: 1,
    heldTicks: [], holdLastTicks: 0 };
  const decision = evaluateBonus({ serverSeed, nonce: saved.nonce }, { amount: 1, baseWin: 0 }, bonus);
  round.bonus = { triggered: decision.triggered, multiplier: decision.multiplier, configVersion: bonus.version };
  log.info('round betting', { roundId: id, nonce: round.nonce, configVersion: bonus.version });
  emit('round.betting', { roundId: id, serverSeedHash: round.serverSeedHash, bettingEndsAt: round.bettingEndsAt });
  schedule(startRunning, config.bettingMs);
}
async function startRunning() {
  await store.setRoundState(round.id, 'running');
  round.state = 'running';
  round.startedAt = Date.now();
  if (faults.reorder && Math.random() < 0.5) round.holdLastTicks = 1 + Math.floor(Math.random() * 2);
  emit('round.started', { roundId: round.id, startedAt: round.startedAt });
  if (toCents(round.crashPoint) <= 100) return crash();
  schedule(tick, config.tickMs);
}
async function tick() {
  const t = Date.now() - round.startedAt;
  const multiplier = multiplierAt(t);
  if (toCents(multiplier) >= toCents(round.crashPoint)) return crash();
  round.multiplier = multiplier;
  const event = createEvent('tick', { roundId: round.id, multiplier, t });
  if (round.holdLastTicks && t + round.holdLastTicks * config.tickMs >= msToReach(round.crashPoint)) round.heldTicks.push(event);
  else send(event);
  await hooks.onMultiplier(round.id, toCents(multiplier));
  schedule(tick, config.tickMs);
}
async function crash() {
  // Close manual cash-outs before awaiting automatic settlement/database work.
  round.state = 'crashed';
  await hooks.onMultiplier(round.id, toCents(round.crashPoint) - 1);
  await hooks.onCrash(round.id);
  await store.setRoundState(round.id, 'crashed');
  round.multiplier = round.crashPoint;
  log.info('round crashed', { roundId: round.id, crashPoint: round.crashPoint });
  emit('round.crashed', { roundId: round.id, crashPoint: round.crashPoint, serverSeed: round.serverSeed });
  for (const event of round.heldTicks) send(event);
  round.heldTicks = [];
  schedule(startBetting, config.crashedPauseMs);
}
