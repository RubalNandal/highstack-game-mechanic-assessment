import type { FastifyInstance } from 'fastify';
import * as v from 'valibot';
import { ConflictError, type Store } from '@highstack/storage';
import type { BonusConfig } from '@highstack/bonus';
import { verifySignature } from './security.js';
import {
  EngineBetSchema, NewRoundSchema, OutcomeSchema, parseInput, SettlementSchema,
} from './validation.js';

const uuid = v.pipe(v.string(), v.uuid());
const empty = v.strictObject({});
const params = v.object({ id: uuid });
const ENGINE_TIMEOUT_MS = 15_000;

export function registerEngineRoutes(
  app: FastifyInstance,
  store: Store,
  secret: string,
  loadConfig: () => Promise<BonusConfig>,
) {
  let owner: { id: string; expiresAt: number; release: () => Promise<void> } | undefined;
  async function releaseOwner() {
    const previous = owner;
    owner = undefined;
    await previous?.release();
  }
  const timer = setInterval(() => {
    if (owner && Date.now() >= owner.expiresAt)
      releaseOwner().catch((error) => app.log.error(error));
  }, 1000).unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await releaseOwner();
  });

  app.register(async (api) => {
    api.addHook('preHandler', async (request, reply) => {
      const engineId = request.headers['x-engine-id'];
      if (
        !v.safeParse(uuid, engineId).success ||
        !verifySignature(secret, request.headers['x-timestamp'], request.headers['x-signature'],
          `${request.method}.${request.url}.${engineId}.${request.rawBody}`)
      ) return reply.code(401).send({ error: 'Invalid engine signature' });
      if (request.url === '/engine/start') return;
      if (!owner || owner.id !== engineId || Date.now() >= owner.expiresAt)
        return reply.code(409).send({ error: 'engine_inactive' });
      owner.expiresAt = Date.now() + ENGINE_TIMEOUT_MS;
    });

    api.post('/start', async (request, reply) => {
      parseInput(empty, request.body);
      const engineId = request.headers['x-engine-id'] as string;
      if (owner && Date.now() < owner.expiresAt) {
        if (owner.id !== engineId) return reply.code(409).send({ error: 'engine_busy' });
        owner.expiresAt = Date.now() + ENGINE_TIMEOUT_MS;
        return { ok: true };
      }
      await releaseOwner();
      const client = await store.pool.connect();
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try { await client.query('SELECT pg_advisory_unlock(487322)'); }
        finally { client.release(); }
      };
      client.on('error', () => {
        if (owner?.id === engineId) owner = undefined;
        if (!released) { released = true; client.release(true); }
      });
      try {
        const lock = await client.query('SELECT pg_try_advisory_lock(487322) AS owned');
        if (!lock.rows[0].owned) {
          await release();
          return reply.code(409).send({ error: 'engine_busy' });
        }
        await store.recoverInterrupted();
        owner = { id: engineId, expiresAt: Date.now() + ENGINE_TIMEOUT_MS, release };
        return { ok: true };
      } catch (error) {
        await release();
        throw error;
      }
    });
    api.post('/heartbeat', async (request) => {
      parseInput(empty, request.body);
      return { ok: true };
    });
    api.post('/stop', async (request) => {
      parseInput(empty, request.body);
      await releaseOwner();
      return { ok: true };
    });
    api.post('/rounds', async (request) => {
      const input = parseInput(NewRoundSchema, request.body);
      const existing = await store.getRound(input.roundId);
      const config = existing
        ? await store.getConfig(existing.configVersion)
        : await store.saveConfig(await loadConfig());
      const round = await store.createRound(input.roundId, input.serverSeed, config.version);
      return { round, config: await store.getConfig(round.configVersion) };
    });
    api.post('/rounds/:id/state', async (request) => {
      const { id } = parseInput(params, request.params);
      const { state } = parseInput(v.strictObject({ state: v.picklist(['running', 'crashed']) }), request.body);
      await store.setRoundState(id, state);
      return { ok: true };
    });
    api.post('/bets', async (request) => {
      const bet = parseInput(EngineBetSchema, request.body);
      return store.createBet(bet.playerId, bet.roundId, bet.amount, bet.autoCashout, bet.betId);
    });
    api.get('/bets/:id', async (request) =>
      (await store.getBet(parseInput(params, request.params).id)) ?? null,
    );
    api.post('/bets/:id/debit', async (request) => {
      const { id } = parseInput(params, request.params);
      const { accepted } = parseInput(v.strictObject({ accepted: v.boolean() }), request.body);
      await store.confirmDebit(id, accepted);
      const bet = await store.getBet(id);
      if (!bet) throw new ConflictError('Bet not found');
      return bet;
    });
    for (const action of ['reject', 'refund'] as const) {
      api.post(`/bets/:id/${action}`, async (request) => {
        const { id } = parseInput(params, request.params);
        parseInput(empty, request.body);
        if (action === 'reject') await store.rejectDebit(id);
        else await store.refundActive(id);
        return { ok: true };
      });
    }
    api.post('/bets/:id/settle', async (request) => {
      const { id } = parseInput(params, request.params);
      const { multiplier, outcome } = parseInput(SettlementSchema, request.body);
      return store.settleWin(id, multiplier, outcome);
    });
    api.post('/bets/:id/lost', async (request) => {
      const { id } = parseInput(params, request.params);
      const outcome = parseInput(v.strictObject({
        ...OutcomeSchema.entries, baseWin: v.literal(0), finalWin: v.literal(0),
      }), request.body);
      await store.markLost([id], outcome);
      return { ok: true };
    });
    api.get('/payments/pending', async () => {
      const [debits, credits] = await Promise.all([store.pendingDebits(), store.pendingCredits()]);
      return { debits, credits };
    });
  }, { prefix: '/engine' });
}
