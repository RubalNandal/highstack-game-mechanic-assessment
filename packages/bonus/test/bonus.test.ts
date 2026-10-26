import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configHash, drawBelow, evaluateBonus, parseConfig } from '../src/index.js';

const seed = { serverSeed: 'assessment-example', nonce: 0 };
const bet = { amount: 100, baseWin: 200 };
const config = parseConfig({ version: 'test-v1', triggerChance: 1,
  multipliers: [{ multiplier: 2, weight: 60 }, { multiplier: 5, weight: 30 }, { multiplier: 10, weight: 10 }], maxWin: 100_000 });

test('documented project-owned seed vector stays stable', () => {
  assert.equal(drawBelow(seed, 'test-v1', 'multiplier', 100n), 73n);
  assert.deepEqual(evaluateBonus(seed, bet, config), {
    triggered: true, multiplier: 5, baseWin: 200, finalWin: 1000, capped: false, configVersion: 'test-v1',
  });
});

test('same complete inputs reproduce the exact outcome without mutation', () => {
  const first = evaluateBonus(seed, bet, config);
  for (let i = 0; i < 20; i++) assert.deepEqual(evaluateBonus(seed, bet, config), first);
  assert.equal(bet.baseWin, 200);
  assert.ok(Object.isFrozen(config.multipliers[0]));
  assert.equal(configHash(config), configHash({ ...config }));
});

test('zero/full chance and losing bets', () => {
  assert.deepEqual(evaluateBonus(seed, bet, { ...config, triggerChance: 0 }), {
    triggered: false, multiplier: 1, baseWin: 200, finalWin: 200, capped: false, configVersion: 'test-v1',
  });
  assert.equal(evaluateBonus(seed, bet, config).triggered, true);
  assert.equal(evaluateBonus(seed, { ...bet, baseWin: 0 }, config).finalWin, 0);
});

test('zero-weight rows never win; exact cap and floor rounding use integer arithmetic', () => {
  const c = { ...config, multipliers: [{ multiplier: 10, weight: 0 }, { multiplier: 2.55, weight: 1 }], maxWin: 1000 };
  assert.equal(evaluateBonus(seed, { amount: 1, baseWin: 101 }, c).finalWin, 257);
  assert.equal(evaluateBonus(seed, bet, { ...c, maxWin: 500 }).finalWin, 500);
  assert.equal(evaluateBonus(seed, bet, { ...c, maxWin: 500 }).capped, true);
  assert.equal(evaluateBonus(seed, bet, { ...c, maxWin: 510 }).capped, false);
  assert.equal(evaluateBonus(seed, bet, { ...c, maxWin: 0 }).finalWin, 0);
});

test('weighted selection follows integer ticket boundaries', () => {
  const seen = new Set<number>();
  for (let nonce = 0; nonce < 1000; nonce++) {
    const s = { ...seed, nonce };
    const ticket = Number(drawBelow(s, config.version, 'multiplier', 100n));
    const expected = ticket < 60 ? 2 : ticket < 90 ? 5 : 10;
    assert.equal(evaluateBonus(s, bet, config).multiplier, expected);
    seen.add(expected);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [2, 5, 10]);
});

test('reject invalid config and unsafe money inputs', () => {
  for (const change of [{ triggerChance: -1 }, { triggerChance: 1.1 }, { triggerChance: 0.1234567 },
    { multipliers: [] }, { multipliers: [{ multiplier: 2, weight: 0 }] },
    { multipliers: [{ multiplier: 2, weight: -1 }] }, { multipliers: [{ multiplier: 1.001, weight: 1 }] },
    { maxWin: -1 }, { maxWin: 1.5 }, { version: '' }, { extra: true }]) {
    assert.throws(() => parseConfig({ ...config, ...change }));
  }
  assert.throws(() => evaluateBonus(seed, { amount: 1, baseWin: Number.MAX_SAFE_INTEGER + 1 }, config));
  assert.throws(() => evaluateBonus({ ...seed, nonce: -1 }, bet, config));
});
