import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from '../src/security.js';
import {
  BetSchema,
  parseInput,
  RoundSnapshotSchema,
  SessionSchema,
  StreamSchema,
  WalletSchema,
} from '../src/validation.js';

test('signature authenticates exact bytes and rejects expired/future/tampered requests', () => {
  const raw = '{"amount":100}',
    timestamp = '1793000000';
  const sign = (body: string) =>
    createHmac('sha256', 'secret').update(`${timestamp}.${body}`).digest('hex');
  const now = Number(timestamp) * 1000;
  assert.equal(verifySignature('secret', timestamp, sign(raw), raw, now), true);
  assert.equal(verifySignature('secret', timestamp, sign(raw), raw + ' ', now), false);
  assert.equal(verifySignature('secret', timestamp, sign(raw), raw, now + 61_000), false);
  assert.equal(verifySignature('secret', timestamp, sign(raw), raw, now - 61_000), false);
  assert.equal(verifySignature('secret', timestamp, 'bad', raw, now), false);
});

test('untrusted bet and wallet input reject unsafe/fractional money and extra properties', () => {
  const payload = { txId: 'debit:b', betId: 'b', playerId: 'demo', roundId: 'r', amount: 100 };
  assert.deepEqual(parseInput(WalletSchema, payload), payload);
  for (const amount of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parseInput(WalletSchema, { ...payload, amount }));
  assert.throws(() => parseInput(WalletSchema, { ...payload, admin: true }));
  const bet = {
    betId: '00000000-0000-4000-8000-000000000001',
    roundId: '00000000-0000-4000-8000-000000000000',
    amount: 100,
  };
  assert.deepEqual(parseInput(BetSchema, bet), bet);
  assert.throws(() => parseInput(BetSchema, { ...bet, betId: 'invalid' }));
  assert.throws(() => parseInput(BetSchema, { roundId: bet.roundId, amount: 100 }));
  assert.throws(() => parseInput(BetSchema, { roundId: 'invalid', amount: 100 }));
});

test('engine snapshots, sessions and streamed money are validated at the server boundary', () => {
  assert.throws(() => parseInput(SessionSchema, { sessionId: 'not-a-uuid' }));
  assert.throws(() => parseInput(RoundSnapshotSchema, { state: 'running', multiplier: -1 }));
  assert.throws(() =>
    parseInput(StreamSchema, {
      seq: 1,
      type: 'bet.cashed_out',
      data: {
        roundId: '00000000-0000-4000-8000-000000000000',
        betId: '00000000-0000-4000-8000-000000000001',
        playerId: 'demo',
        multiplier: 2,
        payout: -1,
      },
    }),
  );
});
