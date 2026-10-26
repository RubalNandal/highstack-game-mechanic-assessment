import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canActivateBet } from '../src/eligibility.js';
import { msToReach } from '../src/fair.js';

test('a late debit is rejected at the actual crash time, even before the timer updates state', () => {
  const round = { id: 'r', state: 'running', startedAt: 1000, crashPoint: 2 };
  const deadline = round.startedAt + msToReach(2);
  assert.equal(canActivateBet(round, 'r', deadline - 1), true);
  assert.equal(canActivateBet(round, 'r', deadline), false);
  assert.equal(canActivateBet(round, 'r', deadline + 1), false);
  assert.equal(canActivateBet(round, 'old', 1000), false);
  assert.equal(canActivateBet({ ...round, state: 'crashed' }, 'r', 1000), false);
  assert.equal(canActivateBet(null, 'r'), false);
  assert.equal(canActivateBet({ ...round, state: 'betting' }, 'r', 1000), true);
});
