/**
 * Operator-owned persistence for round inputs, bet results, balances and payment receipts.
 * The engine has no database connection: it requests these operations through signed operator routes.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  configHash,
  evaluateBonus,
  parseConfig,
  type BonusConfig,
  type Outcome,
} from '@highstack/bonus';
import * as schema from './schema.js';

export type StoredBet = typeof schema.bets.$inferSelect;
export type WalletPayload = {
  txId: string;
  playerId: string;
  amount: number;
  betId: string;
  roundId: string;
};
export class ConflictError extends Error {
  readonly statusCode = 409;
}

/**
 * Keep the operator's reusable database pool and related operations together.
 * Save game outcomes supplied by the engine; enforce money checks here rather than recalculating game rules.
 */
export class Store {
  readonly pool: pg.Pool;
  readonly db;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
    this.db = drizzle(this.pool, { schema });
  }

  /**
   * Apply missing SQL migrations at operator startup or in database tests.
   * The advisory lock makes concurrent startup processes apply schema changes one at a time.
   */
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

  /**
   * Create a starting wallet only if absent. Restarting must not reset an existing balance.
   */
  async seedPlayer(playerId = 'demo', amount = 100_000) {
    await this.db
      .insert(schema.wallets)
      .values({ playerId, balance: amount })
      .onConflictDoNothing();
  }

  /**
   * Validate and save the complete settings under a version before a round uses them.
   * A matching repeat is allowed; different contents under the same version are rejected.
   */
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

  /**
   * Save the engine's round ID, seed and config version; Postgres assigns the nonce.
   * An identical retry returns the original row/nonce rather than creating a different draw.
   */
  async createRound(id: string, serverSeed: string, configVersion: string) {
    await this.db
      .insert(schema.rounds)
      .values({ id, serverSeed, configVersion, state: 'betting' })
      .onConflictDoNothing();
    const round = await this.getRound(id);
    if (!round || round.serverSeed !== serverSeed)
      throw new ConflictError('Round ID reused with a different seed');
    return round;
  }

  async getRound(id: string) {
    return (await this.db.select().from(schema.rounds).where(eq(schema.rounds.id, id)))[0];
  }

  async getConfig(version: string) {
    const [saved] = await this.db
      .select()
      .from(schema.configurations)
      .where(eq(schema.configurations.version, version));
    if (!saved) throw new ConflictError('Config not found');
    return parseConfig(saved.snapshot);
  }

  async setRoundState(id: string, state: 'running' | 'crashed') {
    await this.db
      .update(schema.rounds)
      .set({ state })
      .where(
        and(eq(schema.rounds.id, id), inArray(schema.rounds.state, ['betting', 'running', state])),
      );
  }

  /**
   * Save a stake attempt before wallet delivery, using the browser's bet ID when supplied.
   * Create fixed debit/credit IDs from that bet ID and reject retries with changed bet details.
   * autoCashout arrives as a factor such as 2; store it as 200 hundredths.
   */
  async createBet(
    playerId: string,
    roundId: string,
    amount: number,
    autoCashout?: number,
    id: string = randomUUID(),
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

  /**
   * After confirmed stake deduction, accept a still-pending bet or prepare its stake refund.
   * The engine supplies accepted=false if the round can no longer admit this bet.
   */
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

  /**
   * Record a definite stake decline while the bet is still pending; no refund is owed.
   */
  async rejectDebit(id: string) {
    await this.db
      .update(schema.bets)
      .set({ status: 'rejected' })
      .where(and(eq(schema.bets.id, id), eq(schema.bets.status, 'pending')));
  }

  /**
   * Return a newly accepted stake if the round ended during acceptance's HTTP wait.
   * Record the stake as a pending credit; the engine requests that credit separately.
   */
  async refundActive(id: string) {
    await this.db
      .update(schema.bets)
      .set({ status: 'refunded', payout: sql`${schema.bets.amount}`, payoutStatus: 'pending' })
      .where(and(eq(schema.bets.id, id), eq(schema.bets.status, 'active')));
  }

  /**
   * Save the engine's complete cash-out result once; multiplier is the game cash-out factor.
   * Lock this bet so overlapping attempts cannot record competing wins. Identical retries return it.
   * payoutStatus=pending means the decided finalWin is owed but its wallet credit is not yet confirmed.
   */
  async settleWin(id: string, multiplier: number, outcome: Outcome) {
    return this.db.transaction(async (tx) => {
      const [bet] = await tx.select().from(schema.bets).where(eq(schema.bets.id, id)).for('update');
      if (
        bet?.status === 'cashed_out' &&
        bet.multiplier === Math.round(multiplier * 100) &&
        isDeepStrictEqual(bet.outcome, outcome)
      )
        return bet;
      if (!bet || bet.status !== 'active') throw new ConflictError('Bet already settled');
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

  /**
   * Record supplied zero-win outcomes only for still-active bets.
   * A late loss must not overwrite a bet that already saved a cash-out result.
   */
  async markLost(ids: string[], outcome: Outcome) {
    for (const id of ids)
      await this.db.transaction(async (tx) => {
        const [bet] = await tx
          .select()
          .from(schema.bets)
          .where(eq(schema.bets.id, id))
          .for('update');
        if (!bet || bet.status !== 'active') return;
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

  /**
   * A new engine cannot resume an old in-memory clock: cancel unfinished rounds and refund active stakes.
   * Preserve already-saved wins. Startup separately reconciles pending debits and credits by their IDs.
   */
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

  /**
   * Apply one signed debit/credit request against its recorded bet and payment ID.
   * Return a previous receipt for a matching retry; otherwise change balance and save a receipt together.
   * The wallet route calls this after signature/field validation. All amounts are integer cents.
   */
  async applyWallet(kind: 'debit' | 'credit', payload: WalletPayload) {
    return this.db.transaction(async (tx) => {
      // Lock the wallet first: simultaneous stakes must not both spend its old balance.
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
        // This is the original receipt's balance, not necessarily today's balance after other bets.
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
      // A declined debit also gets a receipt, so the same request cannot change its answer on retry.
      const code = kind === 'debit' && wallet.balance < payload.amount ? 402 : 200;
      const balance =
        code === 402
          ? wallet.balance
          : wallet.balance + (kind === 'debit' ? -payload.amount : payload.amount);
      if (!Number.isSafeInteger(balance) || balance < 0)
        throw new ConflictError('Balance outside supported range');
      // The receipt, balance and credit's paid status commit together or all roll back.
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

  /**
   * Provide the player's latest 20 bets and their round state/config version to the website.
   * Leave secret seeds out of this response while rounds may still be running.
   */
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

  /**
   * After an owned bet's round ends, load its saved seed, nonce, settings and ordinary winnings.
   * Recalculate the bonus and compare the complete outcome; never call the wallet or change history.
   * This checks the bonus from saved baseWin, not the correctness of the original cash-out timing.
   */
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
