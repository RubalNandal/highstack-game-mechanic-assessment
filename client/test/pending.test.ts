import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPending } from '../src/pending.js';

test('an unfinished bet keeps the same ID when upgrading old browser storage', () => {
  const betId = '00000000-0000-4000-8000-000000000001';
  const storage = {
    getItem: () => JSON.stringify({ requestId: betId, roundId: 'r1', amount: 100, autoCashout: 2 }),
  };
  const expected = { betId, roundId: 'r1', amount: 100, autoCashout: 2 };
  assert.deepEqual(readPending(storage), expected);
  assert.deepEqual(readPending({ getItem: () => JSON.stringify(expected) }), expected);
  assert.deepEqual(readPending(storage), expected);
});

test('missing or unreadable browser storage does not create a pending bet', () => {
  for (const raw of [null, 'invalid JSON']) {
    assert.equal(readPending({ getItem: () => raw }), null);
  }
});
