/**
 * Engine-side client for the operator's record and ownership API.
 * Sends specific signed HTTP actions; it never imports storage or queries the casino database.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';

const engineId = randomUUID();

/**
 * Send one operator action, retrying temporary failures with the same body and IDs.
 * Sign method, path and engine identity as well as body so the signature belongs to this action.
 * Startup waits longer when an old engine still owns the clock; unresolved failures throw.
 */
async function call(path, body, starting = false) {
  const method = body === undefined ? 'GET' : 'POST';
  const raw = body === undefined ? '' : JSON.stringify(body);
  const attempts = starting ? 30 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', config.webhookSecret)
        .update(`${timestamp}.${method}.${path}.${engineId}.${raw}`)
        .digest('hex');
      const response = await fetch(`${config.operatorUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-engine-id': engineId,
          'x-timestamp': timestamp,
          'x-signature': signature,
        },
        body: body === undefined ? undefined : raw,
        signal: AbortSignal.timeout(3000),
      });
      const data = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(data.error ?? 'Operator request failed'), {
          statusCode: response.status,
          fatal:
            response.status === 401 || data.error === 'engine_inactive' || response.status >= 500,
        });
      return data;
    } catch (error) {
      const retry =
        !error.statusCode ||
        error.statusCode >= 500 ||
        (starting && error.message === 'engine_busy');
      if (!retry || attempt === attempts - 1)
        throw Object.assign(error, {
          statusCode: error.statusCode ?? 503,
          fatal: error.fatal ?? true,
        });
      await sleep(starting ? 1000 : 100 * (attempt + 1));
    }
  }
}

export const operator = {
  start: () => call('/engine/start', {}, true),
  heartbeat: () => call('/engine/heartbeat', {}),
  stop: () => call('/engine/stop', {}),
  createRound: (roundId, serverSeed) => call('/engine/rounds', { roundId, serverSeed }),
  setRoundState: (id, state) => call(`/engine/rounds/${id}/state`, { state }),
  createBet: (playerId, roundId, amount, autoCashout, betId) =>
    call('/engine/bets', { playerId, roundId, amount, autoCashout, betId }),
  getBet: (id) => call(`/engine/bets/${id}`),
  confirmDebit: (id, accepted) => call(`/engine/bets/${id}/debit`, { accepted }),
  rejectDebit: (id) => call(`/engine/bets/${id}/reject`, {}),
  refundActive: (id) => call(`/engine/bets/${id}/refund`, {}),
  settleWin: (id, multiplier, outcome) =>
    call(`/engine/bets/${id}/settle`, { multiplier, outcome }),
  markLost: (id, outcome) => call(`/engine/bets/${id}/lost`, outcome),
  pendingPayments: () => call('/engine/payments/pending'),
};
