import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { parseConfig } from '@highstack/bonus';
import { Store, type StoredBet } from '../src/index.js';
import { createApp } from '../../../operator/src/app.js';

if (!process.env.TEST_DATABASE_URL)
  throw new Error('Set TEST_DATABASE_URL to a dedicated Postgres test database');
const store = new Store(process.env.TEST_DATABASE_URL);
await store.migrate();
after(() => store.close());
const config = parseConfig({
  version: 'integration-v1',
  triggerChance: 1,
  multipliers: [{ multiplier: 2, weight: 1 }],
  maxWin: 10_000,
});
await store.saveConfig(config);

async function fixture(balance = 1000) {
  const player = `test-${randomUUID()}`;
  await store.seedPlayer(player, balance);
  const round = await store.createRound(randomUUID(), 'integration-test-seed', config.version);
  return { player, round, bet: await store.createBet(player, round.id, 100) };
}
function payload(bet: StoredBet, kind: 'debit' | 'credit') {
  return {
    txId: kind === 'debit' ? bet.debitTxId : bet.creditTxId,
    playerId: bet.playerId,
    roundId: bet.roundId,
    betId: bet.id,
    amount: kind === 'debit' ? bet.amount : bet.payout!,
  };
}
async function win(bet: StoredBet) {
  await store.applyWallet('debit', payload(bet, 'debit'));
  await store.confirmDebit(bet.id, true);
  return store.settleWin(bet.id, 2);
}

test('concurrent debits cannot overspend; declined requests have a stable result', async () => {
  const f = await fixture(100);
  const other = await store.createBet(f.player, f.round.id, 100);
  const results = await Promise.all(
    [f.bet, other].map((b) => store.applyWallet('debit', payload(b, 'debit'))),
  );
  assert.deepEqual(results.map((r) => r.code).sort(), [200, 402]);
  assert.equal(await store.balance(f.player), 0);
  const declined = results[0].code === 402 ? f.bet : other;
  assert.equal((await store.applyWallet('debit', payload(declined, 'debit'))).code, 402);
});

test('concurrent duplicate credits pay once; changed IDs/details cannot pay again', async () => {
  const f = await fixture();
  const bet = await win(f.bet);
  assert.equal(bet.payout, 400);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.applyWallet('credit', payload(bet, 'credit'))),
  );
  assert.ok(results.every((r) => r.balance === 1300));
  assert.equal(await store.balance(f.player), 1300);
  assert.equal((await store.getBet(bet.id))!.payoutStatus, 'paid');
  await assert.rejects(
    store.applyWallet('credit', { ...payload(bet, 'credit'), amount: 401 }),
    /different data/,
  );
  await assert.rejects(
    store.applyWallet('credit', { ...payload(bet, 'credit'), txId: randomUUID() }),
    /recorded bet/,
  );
  await assert.rejects(store.settleWin(bet.id, 3), /already settled/);
});

test('lost debit response is safely retried using its original ID', async () => {
  const f = await fixture();
  await store.applyWallet('debit', payload(f.bet, 'debit'));
  assert.equal((await store.applyWallet('debit', payload(f.bet, 'debit'))).balance, 900);
  await store.confirmDebit(f.bet.id, false);
  const refunded = (await store.getBet(f.bet.id))!;
  await store.applyWallet('credit', payload(refunded, 'credit'));
  await store.applyWallet('credit', payload(refunded, 'credit'));
  assert.equal(await store.balance(f.player), 1000);
});

test('same browser request cannot create two bets or change its original input', async () => {
  const f = await fixture();
  const duplicate = await store.createBet(f.player, f.round.id, 100, undefined, f.bet.id);
  assert.equal(duplicate.id, f.bet.id);
  await assert.rejects(
    store.createBet(f.player, f.round.id, 101, undefined, f.bet.id),
    /different bet/,
  );
});

test('config versions are immutable; stored outcomes replay only after seed reveal', async () => {
  const f = await fixture();
  const bet = await win(f.bet);
  await assert.rejects(store.replay(bet.id, f.player), /not revealed/);
  await assert.rejects(store.saveConfig({ ...config, maxWin: 1 }), /new version/);
  await store.saveConfig({ ...config, version: 'integration-v2', maxWin: 1 });
  await store.setRoundState(f.round.id, 'crashed');
  const replay = await store.replay(bet.id, f.player);
  assert.equal(replay.matches, true);
  assert.equal(replay.outcome.finalWin, 400);
  assert.equal(replay.config.version, 'integration-v1');
  await assert.rejects(store.replay(bet.id, 'someone-else'), /not found/);
});

test('lost rounds preserve their bonus decision and replay a zero payout', async () => {
  const f = await fixture();
  await store.applyWallet('debit', payload(f.bet, 'debit'));
  await store.confirmDebit(f.bet.id, true);
  await store.markLost([f.bet.id]);
  await store.setRoundState(f.round.id, 'crashed');
  const replay = await store.replay(f.bet.id, f.player);
  assert.equal(replay.matches, true);
  assert.equal(replay.outcome.finalWin, 0);
  assert.equal(replay.outcome.triggered, true);
  assert.equal(await store.balance(f.player), 900);
});

test('restart refunds unresolved active bets and preserves already calculated winnings', async () => {
  const active = await fixture();
  await store.applyWallet('debit', payload(active.bet, 'debit'));
  await store.confirmDebit(active.bet.id, true);
  const settled = await fixture();
  const won = await win(settled.bet);
  await store.recoverInterrupted();
  const refund = (await store.getBet(active.bet.id))!;
  assert.equal(refund.status, 'refunded');
  await store.applyWallet('credit', payload(refund, 'credit'));
  assert.equal(await store.balance(active.player), 1000);
  const saved = (await store.getBet(won.id))!;
  assert.equal(saved.status, 'cashed_out');
  await store.applyWallet('credit', payload(saved, 'credit'));
  assert.equal(await store.balance(settled.player), 1300);
});

test('wallet HTTP endpoints authenticate exact body bytes and validate before paying', async () => {
  const f = await fixture();
  const app = await createApp(store, {
    engineUrl: 'http://127.0.0.1:1',
    operatorKey: 'key',
    webhookSecret: 'secret',
    config,
    stream: false,
    logger: false,
  });
  try {
    const body = JSON.stringify(payload(f.bet, 'debit'));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-signature': createHmac('sha256', 'secret').update(`${timestamp}.${body}`).digest('hex'),
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/wallet/debit',
          headers: { 'content-type': 'application/json' },
          payload: body,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/wallet/debit', headers, payload: body + ' ' }))
        .statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/wallet/debit', headers, payload: body }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/wallet/debit', headers, payload: body }))
        .statusCode,
      200,
    );
    assert.equal(await store.balance(f.player), 900);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/bets',
          headers: { origin: 'https://other.example' },
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
