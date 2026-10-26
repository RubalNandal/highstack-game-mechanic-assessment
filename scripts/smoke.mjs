import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.env.DEMO_URL ?? 'http://localhost:3100';
async function request(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
async function until(read, predicate, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(200); }
  throw new Error('Timed out waiting for game state');
}
const before = await until(() => request('/api/state'), s => s.round?.state === 'betting');
const input = { requestId: randomUUID(), roundId: before.round.roundId, amount: 100, autoCashout: 1.01 };
const placed = await request('/api/bets', input);
assert.equal(placed.betId, input.requestId);
const duplicate = await request('/api/bets', input);
assert.equal(duplicate.betId, placed.betId);
const after = await until(() => request('/api/state'), s => {
  const bet = s.bets.find(b => b.id === placed.betId);
  return ['crashed', 'cancelled'].includes(bet?.roundState) && (bet.status === 'lost' || bet.payoutStatus === 'paid');
});
const bet = after.bets.find(b => b.id === placed.betId);
assert.equal(after.balance, before.balance - input.amount + (bet.payout ?? 0));
const replay = await request(`/api/replay/${bet.id}`);
assert.equal(replay.matches, true);
const examples = await request('/api/examples');
assert.ok(examples.examples.length > 0);
console.log(JSON.stringify({ verified: ['one bet for duplicate request', 'debit', 'settlement', 'wallet balance', 'deterministic replay', 'example fixtures'], betStatus: bet.status, bonus: bet.outcome, balance: after.balance }, null, 2));
