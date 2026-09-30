import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crashPoint, crashPointFromHex, multiplierAt, sha256Hex } from '../src/fair.js';

test('serverSeedHash is sha256 of the seed text', () => {
  assert.equal(sha256Hex('seed-1'), '0eb026731d9ea3f870511f8c18daeb814eaa2c9e276082b204f2a962212fb5bd');
});

test('crash point matches a known vector', () => {
  // HMAC-SHA256(key "seed-1", message "r1") starts with 2da823f890138
  assert.equal(crashPoint('seed-1', 'r1'), 1.21);
});

test('crash point formula', () => {
  assert.equal(crashPointFromHex('0000000000000'), 1); // h % 100 === 0
  assert.equal(crashPointFromHex('8000000000000'), 1.99); // h = 2^51
  assert.equal(crashPointFromHex('c000000000000'), 3.97); // h = 3 * 2^50
});

test('crash point is always at least 1.00 with 2 decimals', () => {
  for (let i = 0; i < 2000; i++) {
    const value = crashPoint(`seed-${i}`, `round-${i}`);
    assert.ok(value >= 1);
    assert.equal(Math.round(value * 100) / 100, value);
  }
});

test('multiplier starts at 1.00 and grows', () => {
  assert.equal(multiplierAt(0), 1);
  assert.ok(multiplierAt(10_000) > multiplierAt(5_000));
  assert.equal(multiplierAt(11_553), 2); // ln(2) / 0.00006 ≈ 11552.5 ms
});
