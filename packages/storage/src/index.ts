import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { configHash, evaluateBonus, parseConfig, type BonusConfig } from '@highstack/bonus';
import * as schema from './schema.js';

export type StoredBet = typeof schema.bets.$inferSelect;
export type WalletPayload = {
  txId: string;
  playerId: string;
  amount: number;
  betId: string;
  roundId: string;
};
export class ConflictError extends Error {}

export class Store {
  readonly pool: pg.Pool;
  readonly db;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
    this.db = drizzle(this.pool, { schema });
  }

  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(487321)');
      await migrate(drizzle(client), {
        migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock(487321)');
      client.release();
    }
  }

  async seedPlayer(playerId = 'demo', amount = 100_000) {
    await this.db
      .insert(schema.wallets)
      .values({ playerId, balance: amount })
      .onConflictDoNothing();
  }

  async saveConfig(input: BonusConfig) {
    const config = parseConfig(input),
      hash = configHash(config);
    await this.db
      .insert(schema.configurations)
      .values({ version: config.version, hash, snapshot: config })
      .onConflictDoNothing();
    const [saved] = await this.db
      .select()
      .from(schema.configurations)
      .where(eq(schema.configurations.version, config.version));
    if (saved.hash !== hash) throw new ConflictError('Config changed without a new version');
    return config;
  }

  async createRound(id: string, serverSeed: string, configVersion: string) {
    const [round] = await this.db
      .insert(schema.rounds)
      .values({ id, serverSeed, configVersion, state: 'betting' })
      .returning();
    return round;
  }

  async setRoundState(id: string, state: 'running' | 'crashed') {
    await this.db.update(schema.rounds).set({ state }).where(eq(schema.rounds.id, id));
  }

  async createBet(
    playerId: string,
    roundId: string,
    amount: number,
    autoCashout?: number,
    id = randomUUID(),
  ) {
    await this.db
      .insert(schema.bets)
      .values({
        id,
        playerId,
        roundId,
        amount,
        autoCashout: autoCashout === undefined ? null : Math.round(autoCashout * 100),
        status: 'pending',
        debitTxId: `debit:${id}`,
        creditTxId: `credit:${id}`,
      })
      .onConflictDoNothing();
    const bet = await this.getBet(id);
    if (
      !bet ||
      bet.playerId !== playerId ||
      bet.roundId !== roundId ||
      bet.amount !== amount ||
      bet.autoCashout !== (autoCashout === undefined ? null : Math.round(autoCashout * 100))
    )
      throw new ConflictError('Bet ID reused with different bet details');
    return bet;
  }

  async getBet(id: string) {
    return (await this.db.select().from(schema.bets).where(eq(schema.bets.id, id)))[0];
  }

  async confirmDebit(id: string, accepted: boolean) {
    const [bet] = await this.db
      .update(schema.bets)
      .set(
        accepted
          ? { status: 'active' }
          : {
              status: 'refunded',
              payout: sql`${schema.bets.amount}`,
              payoutStatus: 'pending',
            },
      )
      .where(and(eq(schema.bets.id, id), eq(schema.bets.status, 'pending')))
      .returning();
    return bet;
  }

  async rejectDebit(id: string) {
    await this.db
      .update(schema.bets)
      .set({ status: 'rejected' })
      .where(and(eq(schema.bets.id, id), eq(schema.bets.status, 'pending')));
  }

  async refundActive(id: string) {
    await this.db
      .update(schema.bets)
      .set({ status: 'refunded', payout: sql`${schema.bets.amount}`, payoutStatus: 'pending' })
      .where(and(eq(schema.bets.id, id), eq(schema.bets.status, 'active')));
  }

  async settleWin(id: string, multiplier: number) {
    return this.db.transaction(async (tx) => {
      const [bet] = await tx.select().from(schema.bets).where(eq(schema.bets.id, id)).for('update');
      if (!bet || bet.status !== 'active') throw new ConflictError('Bet already settled');
      const [round] = await tx
        .select()
        .from(schema.rounds)
        .where(eq(schema.rounds.id, bet.roundId));
      const [config] = await tx
        .select()
        .from(schema.configurations)
        .where(eq(schema.configurations.version, round.configVersion));
      const baseWin = Number((BigInt(bet.amount) * BigInt(Math.round(multiplier * 100))) / 100n);
      const outcome = evaluateBonus(
        { serverSeed: round.serverSeed, nonce: round.nonce },
        { amount: bet.amount, baseWin },
        config.snapshot,
      );
      const [saved] = await tx
        .update(schema.bets)
        .set({
          status: 'cashed_out',
          multiplier: Math.round(multiplier * 100),
          outcome,
          payout: outcome.finalWin,
          payoutStatus: 'pending',
        })
        .where(eq(schema.bets.id, id))
        .returning();
      return saved;
    });
  }

  async markLost(ids: string[]) {
    for (const id of ids)
      await this.db.transaction(async (tx) => {
        const [bet] = await tx
          .select()
          .from(schema.bets)
          .where(eq(schema.bets.id, id))
          .for('update');
        if (!bet || bet.status !== 'active') return;
        const [round] = await tx
          .select()
          .from(schema.rounds)
          .where(eq(schema.rounds.id, bet.roundId));
        const [config] = await tx
          .select()
          .from(schema.configurations)
          .where(eq(schema.configurations.version, round.configVersion));
        const outcome = evaluateBonus(
          { serverSeed: round.serverSeed, nonce: round.nonce },
          { amount: bet.amount, baseWin: 0 },
          config.snapshot,
        );
        await tx
          .update(schema.bets)
          .set({ status: 'lost', payout: 0, outcome })
          .where(eq(schema.bets.id, id));
      });
  }

  async pendingDebits() {
    return this.db.select().from(schema.bets).where(eq(schema.bets.status, 'pending'));
  }

  async pendingCredits() {
    return this.db.select().from(schema.bets).where(eq(schema.bets.payoutStatus, 'pending'));
  }

  /** One engine instance owns the live clock; incomplete rounds are cancelled on restart. */
  async recoverInterrupted() {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.rounds)
        .set({ state: 'cancelled' })
        .where(inArray(schema.rounds.state, ['betting', 'running']));
      await tx
        .update(schema.bets)
        .set({ status: 'refunded', payout: sql`${schema.bets.amount}`, payoutStatus: 'pending' })
        .where(eq(schema.bets.status, 'active'));
    });
  }

  async balance(playerId: string) {
    const [wallet] = await this.db
      .select()
      .from(schema.wallets)
      .where(eq(schema.wallets.playerId, playerId));
    if (!wallet) throw new ConflictError('Unknown player');
    return wallet.balance;
  }

  async applyWallet(kind: 'debit' | 'credit', payload: WalletPayload) {
    return this.db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(schema.wallets)
        .where(eq(schema.wallets.playerId, payload.playerId))
        .for('update');
      if (!wallet) throw new ConflictError('Unknown player');
      const [previous] = await tx
        .select()
        .from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.txId, payload.txId));
      if (previous) {
        if (
          previous.kind !== kind ||
          previous.betId !== payload.betId ||
          previous.playerId !== payload.playerId ||
          previous.roundId !== payload.roundId ||
          previous.amount !== payload.amount
        )
          throw new ConflictError('Transaction ID reused with different data');
        return { code: previous.code, balance: previous.balance };
      }
      const [bet] = await tx
        .select()
        .from(schema.bets)
        .where(eq(schema.bets.id, payload.betId))
        .for('update');
      if (
        !bet ||
        bet.playerId !== payload.playerId ||
        bet.roundId !== payload.roundId ||
        payload.txId !== (kind === 'debit' ? bet.debitTxId : bet.creditTxId) ||
        payload.amount !== (kind === 'debit' ? bet.amount : bet.payout)
      )
        throw new ConflictError('Payment does not match the recorded bet');
      if (kind === 'debit' ? bet.status !== 'pending' : bet.payoutStatus !== 'pending')
        throw new ConflictError('Payment is not pending');
      const code = kind === 'debit' && wallet.balance < payload.amount ? 402 : 200;
      const balance =
        code === 402
          ? wallet.balance
          : wallet.balance + (kind === 'debit' ? -payload.amount : payload.amount);
      if (!Number.isSafeInteger(balance) || balance < 0)
        throw new ConflictError('Balance outside supported range');
      await tx.insert(schema.walletTransactions).values({ ...payload, kind, balance, code });
      await tx
        .update(schema.wallets)
        .set({ balance })
        .where(eq(schema.wallets.playerId, payload.playerId));
      if (kind === 'credit')
        await tx
          .update(schema.bets)
          .set({ payoutStatus: 'paid' })
          .where(eq(schema.bets.id, payload.betId));
      return { code, balance };
    });
  }

  async history(playerId: string) {
    const rows = await this.db
      .select({
        bet: schema.bets,
        roundState: schema.rounds.state,
        configVersion: schema.rounds.configVersion,
      })
      .from(schema.bets)
      .innerJoin(schema.rounds, eq(schema.bets.roundId, schema.rounds.id))
      .where(eq(schema.bets.playerId, playerId))
      .orderBy(desc(schema.bets.createdAt))
      .limit(20);
    return rows.map(({ bet, ...rest }) => ({ ...bet, ...rest }));
  }

  async replay(id: string, playerId: string) {
    const bet = await this.getBet(id);
    if (!bet || bet.playerId !== playerId) throw new ConflictError('Bet not found');
    const [round] = await this.db
      .select()
      .from(schema.rounds)
      .where(eq(schema.rounds.id, bet.roundId));
    if (!['crashed', 'cancelled'].includes(round.state))
      throw new ConflictError('Seed is not revealed until the round ends');
    if (!bet.outcome) throw new ConflictError('This bet has no bonus settlement to replay');
    const [config] = await this.db
      .select()
      .from(schema.configurations)
      .where(eq(schema.configurations.version, round.configVersion));
    const seed = { serverSeed: round.serverSeed, nonce: round.nonce };
    const input = { amount: bet.amount, baseWin: bet.outcome.baseWin };
    const outcome = evaluateBonus(seed, input, config.snapshot);
    return {
      seed,
      bet: input,
      config: config.snapshot,
      configHash: config.hash,
      storedOutcome: bet.outcome,
      outcome,
      matches: isDeepStrictEqual(outcome, bet.outcome),
    };
  }

  close() {
    return this.pool.end();
  }
}
