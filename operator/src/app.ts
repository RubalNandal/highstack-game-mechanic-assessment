import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import * as v from 'valibot';
import { ConflictError, type Store } from '@highstack/storage';
import type { BonusConfig } from '@highstack/bonus';
import { makeExamples } from './examples.js';
import { verifySignature } from './security.js';
import { BetSchema, parseInput, StreamSchema, WalletSchema } from './validation.js';

declare module 'fastify' { interface FastifyRequest { rawBody: string } }
type Options = { engineUrl: string; operatorKey: string; webhookSecret: string; config: BonusConfig; staticRoot?: string; stream?: boolean; logger?: boolean };
const PLAYER = 'demo';

export async function createApp(store: Store, options: Options) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16 * 1024 });
  app.decorateRequest('rawBody', '');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try { done(null, JSON.parse(body as string)); }
    catch { done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }), undefined); }
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    if (request.url.startsWith('/api/') && request.method !== 'GET') {
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && ![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(origin)))
        return reply.code(403).send({ error: 'Cross-origin actions are not allowed' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ConflictError ? 409 : (error as { statusCode?: number }).statusCode ?? 500;
    if (code >= 500) request.log.error(error);
    reply.code(code).send({ error: code >= 500 ? 'Service unavailable; retry shortly' : (error as Error).message });
  });

  async function engine(path: string, body?: object) {
    const response = await fetch(`${options.engineUrl}${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'x-operator-key': options.operatorKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message ?? data.error ?? 'Engine request failed'), { statusCode: response.status });
    return data;
  }

  app.get('/health', async () => { await store.balance(PLAYER); return { ok: true }; });
  for (const kind of ['debit', 'credit'] as const) {
    app.post(`/wallet/${kind}`, async (request, reply) => {
      if (!verifySignature(options.webhookSecret, request.headers['x-timestamp'], request.headers['x-signature'], request.rawBody))
        return reply.code(401).send({ error: 'Invalid or expired signature' });
      const payload = parseInput(WalletSchema, request.body);
      const result = await store.applyWallet(kind, payload);
      return reply.code(result.code).send(result.code === 402 ? { error: 'insufficient_funds', balance: result.balance } : { balance: result.balance });
    });
  }
  app.get('/api/state', async () => {
    const [balance, bets, round] = await Promise.all([store.balance(PLAYER), store.history(PLAYER), engine('/rounds/current').catch(() => null)]);
    return { playerId: PLAYER, balance, bets, round, engineOnline: round !== null };
  });
  app.post('/api/bets', async request => {
    const { requestId, ...bet } = parseInput(BetSchema, request.body);
    const { sessionId } = await engine(`/players/${PLAYER}/session`, {});
    return engine('/bets', { ...bet, sessionId, requestId });
  });
  app.post<{ Params: { id: string } }>('/api/bets/:id/cashout', async request => {
    const bet = await store.getBet(request.params.id);
    if (!bet || bet.playerId !== PLAYER) throw new ConflictError('Bet not found');
    if (bet.status === 'cashed_out') return { betId: bet.id, status: bet.status, payout: bet.payout };
    return engine(`/bets/${encodeURIComponent(bet.id)}/cashout`, {});
  });
  app.get<{ Params: { id: string } }>('/api/replay/:id', request => store.replay(request.params.id, PLAYER));
  const examples = makeExamples(options.config);
  app.get('/api/examples', async () => ({ examples, note: 'Repeatable examples only. No balance is changed.' }));

  const listeners = new Set<import('node:http').ServerResponse>();
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write('data: {"type":"resync"}\n\n');
    listeners.add(reply.raw);
    reply.raw.on('close', () => listeners.delete(reply.raw));
  });
  const broadcast = (event: object) => {
    for (const listener of listeners) listener.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  let socket: WebSocket | undefined, retry: NodeJS.Timeout | undefined, stopped = false, lastSeq = 0;
  function connectStream() {
    socket = new WebSocket(`${options.engineUrl.replace(/^http/, 'ws')}/stream`, { headers: { 'x-operator-key': options.operatorKey }, maxPayload: 64 * 1024 });
    socket.on('open', () => { lastSeq = 0; broadcast({ type: 'resync' }); });
    socket.on('message', bytes => {
      try {
        const result = v.safeParse(StreamSchema, JSON.parse(bytes.toString()));
        if (!result.success) return;
        const event = result.output;
        if (event.seq <= lastSeq) return;
        if (lastSeq && event.seq !== lastSeq + 1) broadcast({ type: 'resync' });
        lastSeq = event.seq;
        if (event.type !== 'bet.cashed_out' || event.data.playerId === PLAYER) broadcast(event);
      } catch { app.log.warn('Ignored malformed engine event'); }
    });
    socket.on('error', () => {});
    socket.on('close', () => { broadcast({ type: 'resync' }); if (!stopped) retry = setTimeout(connectStream, 1000); });
  }
  const heartbeat = setInterval(() => { for (const listener of listeners) listener.write(': heartbeat\n\n'); }, 15_000);
  if (options.stream !== false) connectStream();
  app.addHook('preClose', async () => {
    stopped = true; clearInterval(heartbeat); clearTimeout(retry); socket?.terminate();
    for (const listener of listeners) listener.end();
  });
  if (options.staticRoot) await app.register(fastifyStatic, { root: resolve(options.staticRoot) });
  return app;
}
