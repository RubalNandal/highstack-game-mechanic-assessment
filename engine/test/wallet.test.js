import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sign } from '../src/wallet.js';

test('signature is hex HMAC-SHA256 of "timestamp.rawBody"', () => {
  const rawBody = '{"txId":"t1","playerId":"p1","amount":100,"betId":"b1","roundId":"r1"}';
  assert.equal(
    sign('dev-webhook-secret', 1700000000, rawBody),
    '02682282393301bcb5d2d651940863d69116b5318b87e2e10bfcf8ffd820a171',
  );
});
