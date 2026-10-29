import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateBonus, parseConfig } from '../src/index.js';

const seed = { serverSeed: 'assessment-example', nonce: 0 };
const bet = { amount: 100, baseWin: 200 };
const config = parseConfig({
  version: 'test-v1',
  triggerChance: 1,
  multipliers: [
    { multiplier: 2, weight: 60 },
    { multiplier: 5, weight: 30 },
    { multiplier: 10, weight: 10 },
  ],
  maxWin: 100_000,
});

test('bonus is deterministic, respects the win cap and rejects invalid config', () => {
  const outcome = evaluateBonus(seed, bet, config);
  assert.equal(outcome.multiplier, 5);
  assert.equal(outcome.finalWin, 1000);
  assert.deepEqual(evaluateBonus(seed, bet, config), outcome);
  const capped = evaluateBonus(seed, bet, { ...config, maxWin: 500 });
  assert.equal(capped.finalWin, 500);
  assert.equal(capped.capped, true);
  assert.equal(evaluateBonus(seed, { ...bet, baseWin: 0 }, config).finalWin, 0);
  assert.throws(() => parseConfig({ ...config, triggerChance: 1.1 }));
  assert.throws(() => parseConfig({ ...config, multipliers: [{ multiplier: 2, weight: 0 }] }));
});

test('zero chance disables the bonus and weights select the configured multipliers', () => {
  const noBonus = evaluateBonus(seed, bet, { ...config, triggerChance: 0 });
  assert.equal(noBonus.triggered, false);
  assert.equal(noBonus.finalWin, bet.baseWin);
  // These seeds produce tickets 59, 60, 89 and 90: both sides of each table boundary.
  for (const [nonce, multiplier] of [
    [183, 2],
    [5, 5],
    [201, 5],
    [173, 10],
  ])
    assert.equal(evaluateBonus({ ...seed, nonce }, bet, config).multiplier, multiplier);
  const zeroWeight = {
    ...config,
    multipliers: [
      { multiplier: 10, weight: 0 },
      { multiplier: 2, weight: 1 },
    ],
  };
  assert.equal(evaluateBonus(seed, bet, zeroWeight).multiplier, 2);
});
