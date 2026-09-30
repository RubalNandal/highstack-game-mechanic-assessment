import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { cashout, createSession, getBet, placeBet } from './bets.js';
import { config } from './config.js';
import { faults } from './faults.js';
import { roundSnapshot } from './game.js';
import { log } from './log.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT = 1_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

class HttpError extends Error {
  constructor(status, error, message) {
    super(message ?? error);
    this.status = status;
    this.error = error;
  }
}

const invalid = (message) => new HttpError(400, 'invalid_request', message);

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw invalid('body must be JSON');
  }
}

function parseBetRequest(body) {
  if (typeof body !== 'object' || body === null) throw invalid('body must be an object');
  const { sessionId, roundId, amount, autoCashout } = body;
  if (typeof sessionId !== 'string' || !sessionId) throw invalid('sessionId must be a string');
  if (typeof roundId !== 'string' || !roundId) throw invalid('roundId must be a string');
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
    throw invalid(`amount must be an integer from 1 to ${MAX_AMOUNT}`);
  }
  if (autoCashout !== undefined) {
    const twoDecimals = Number.isFinite(autoCashout) && Math.abs(autoCashout * 100 - Math.round(autoCashout * 100)) < 1e-9;
    if (!twoDecimals || autoCashout < 1.01 || autoCashout > 1_000_000) {
      throw invalid('autoCashout must be a number from 1.01 with at most 2 decimals');
    }
  }
  return { sessionId, roundId, amount, autoCashout };
}

const routes = [
  ['GET', /^\/rounds\/current$/, () => ({ status: 200, body: roundSnapshot() })],

  ['POST', /^\/players\/([^/]+)\/session$/, (req, [playerId]) => {
    if (!ID_PATTERN.test(playerId)) throw invalid('player id must match [A-Za-z0-9_-]{1,64}');
    return { status: 200, body: { sessionId: createSession(playerId) } };
  }],

  ['POST', /^\/bets$/, async (req) => placeBet(parseBetRequest(await readJson(req)))],

  ['POST', /^\/bets\/([^/]+)\/cashout$/, async (req, [betId]) => {
    const result = cashout(betId);
    if (faults.cashoutTimeout && result.status === 200) await sleep(10_000);
    return result;
  }],

  ['GET', /^\/bets\/([^/]+)$/, (req, [betId]) => {
    const bet = getBet(betId);
    return bet ? { status: 200, body: bet } : { status: 404, body: { error: 'bet_not_found' } };
  }],
];

async function handle(req) {
  if (req.headers['x-operator-key'] !== config.operatorKey) {
    throw new HttpError(401, 'unauthorized');
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(pathname);
    if (match && req.method === method) return handler(req, match.slice(1).map(decodeURIComponent));
  }
  throw new HttpError(404, 'not_found');
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    let body;
    try {
      ({ status, body } = await handle(req));
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        body = { error: err.error, message: err.message };
      } else {
        log.error('request failed', { error: err.stack });
        body = { error: 'internal_error' };
      }
    }
    if (!res.destroyed) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }
    log.debug('http request', { method: req.method, url: req.url, status, ms: Date.now() - started });
  });
}
