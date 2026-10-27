import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.env.DEMO_URL ?? 'http://localhost:3100';
async function state() {
  return (await fetch(`${base}/api/state`)).json();
}
async function until(predicate, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value)) return value;
    await sleep(150);
  }
  throw new Error('Timed out waiting for recovery');
}
const before = await until(
  (s) => s.round?.state === 'betting' && s.round.bettingEndsAt - Date.now() >= 4000,
);
const response = await fetch(`${base}/api/bets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ betId: randomUUID(), roundId: before.round.roundId, amount: 100 }),
});
assert.ok(response.ok);
const bet = await response.json();
assert.equal(bet.status, 'active');
execFileSync('docker', ['compose', 'restart', 'engine'], { stdio: 'inherit' });
const after = await until((s) =>
  s.bets.some((b) => b.id === bet.betId && b.status === 'refunded' && b.payoutStatus === 'paid'),
);
assert.equal(after.balance, before.balance);
console.log(
  'Verified: engine restart cancels the interrupted round and refunds the stake exactly once.',
);
