import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStake } from '../src/money.js';
test('stake parsing converts decimal text to exact minor units', () => {
  assert.equal(parseStake('0.29'), 29);
  assert.equal(parseStake('12.3'), 1230);
  for (const value of ['0', '-1', '1.001', '1e2', 'Infinity', '10000000.01']) assert.throws(() => parseStake(value));
});
