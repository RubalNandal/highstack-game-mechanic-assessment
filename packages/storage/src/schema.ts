import { bigint, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { BonusConfig, Outcome } from '@highstack/bonus';

const money = (name: string) => bigint(name, { mode: 'number' });
export const configurations = pgTable('configurations', {
  version: text('version').primaryKey(),
  hash: text('hash').notNull(),
  snapshot: jsonb('snapshot').$type<BonusConfig>().notNull(),
});
export const rounds = pgTable('rounds', {
  id: text('id').primaryKey(),
  nonce: integer('nonce').generatedAlwaysAsIdentity(),
  serverSeed: text('server_seed').notNull(),
  configVersion: text('config_version')
    .notNull()
    .references(() => configurations.version),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
export const wallets = pgTable('wallets', {
  playerId: text('player_id').primaryKey(),
  balance: money('balance').notNull(),
});
export const bets = pgTable('bets', {
  id: text('id').primaryKey(),
  playerId: text('player_id')
    .notNull()
    .references(() => wallets.playerId),
  roundId: text('round_id')
    .notNull()
    .references(() => rounds.id),
  amount: money('amount').notNull(),
  autoCashout: integer('auto_cashout'),
  status: text('status').notNull(),
  debitTxId: text('debit_tx_id').notNull(),
  creditTxId: text('credit_tx_id').notNull(),
  multiplier: integer('multiplier'),
  outcome: jsonb('outcome').$type<Outcome>(),
  payout: money('payout'),
  payoutStatus: text('payout_status').notNull().default('none'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
export const walletTransactions = pgTable('wallet_transactions', {
  txId: text('tx_id').primaryKey(),
  kind: text('kind').notNull(),
  betId: text('bet_id')
    .notNull()
    .references(() => bets.id),
  playerId: text('player_id')
    .notNull()
    .references(() => wallets.playerId),
  roundId: text('round_id').notNull(),
  amount: money('amount').notNull(),
  balance: money('balance').notNull(),
  code: integer('code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
