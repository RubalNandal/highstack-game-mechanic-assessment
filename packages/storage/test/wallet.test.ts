import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { evaluateBonus, parseConfig } from '@highstack/bonus';
import { Store } from '../src/index.js';

if (!process.env.TEST_DATABASE_URL)
  throw new Error('Set TEST_DATABASE_URL to a dedicated Postgres test database');
const store = new Store(process.env.TEST_DATABASE_URL);
after(() => store.close());

test('a bet pays its bonus once, replays correctly and cannot overspend the wallet', async () => {
  await store.migrate();
  const config = parseConfig({
    version: 'basic-wallet-v1', triggerChance: 1,
    multipliers: [{ multiplier: 5, weight: 1 }], maxWin: 100_000,
  });
  await store.saveConfig(config);
  const playerId = `test-${randomUUID()}`;
  await store.seedPlayer(playerId, 100_000);
  const round = await store.createRound(randomUUID(), 'wallet-example', config.version);
  const bet = await store.createBet(playerId, round.id, 1000);
  const payment = { playerId, roundId: round.id, betId: bet.id };
  await store.applyWallet('debit', { ...payment, txId: bet.debitTxId, amount: 1000 });
  await store.confirmDebit(bet.id, true);

  const outcome = evaluateBonus(
    { serverSeed: round.serverSeed, nonce: round.nonce },
    { amount: 1000, baseWin: 2000 }, config,
  );
  const settled = await store.settleWin(bet.id, 2, outcome);
  assert.equal(settled.payout, 10_000);
  const credit = { ...payment, txId: bet.creditTxId, amount: settled.payout! };
  await store.applyWallet('credit', credit);
  await store.applyWallet('credit', credit);
  assert.equal(await store.balance(playerId), 109_000);
  assert.equal((await store.getBet(bet.id))!.payoutStatus, 'paid');

  const tooLarge = await store.createBet(playerId, round.id, 200_000);
  const declined = await store.applyWallet('debit', {
    playerId, roundId: round.id, betId: tooLarge.id,
    txId: tooLarge.debitTxId, amount: tooLarge.amount,
  });
  assert.equal(declined.code, 402);
  assert.equal(await store.balance(playerId), 109_000);
  await store.setRoundState(round.id, 'crashed');
  assert.equal((await store.replay(bet.id, playerId)).matches, true);
});
