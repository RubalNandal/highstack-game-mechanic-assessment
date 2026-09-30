import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { faults } from './faults.js';
import { log } from './log.js';

export function sign(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

async function attempt(url, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000) - faults.clockSkewSec;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-timestamp': String(timestamp),
      'x-signature': sign(config.webhookSecret, timestamp, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(config.webhookTimeoutMs),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // body stays null; only the status code matters to the engine
  }
  return { status: res.status, body };
}

/**
 * Sends one wallet call. Resolves to
 *   { kind: 'ok', balance } | { kind: 'declined' } | { kind: 'failed', reason }
 */
async function deliver(kind, payload) {
  const url = `${config.operatorUrl}/wallet/${kind}`;
  const rawBody = JSON.stringify(payload);
  const delays = config.webhookRetryDelaysMs;

  for (let i = 0; i <= delays.length; i++) {
    const fields = { kind, txId: payload.txId, betId: payload.betId, attempt: i + 1 };
    try {
      const { status, body } = await attempt(url, rawBody);
      log.info('webhook attempt', { ...fields, status });
      if (status === 200) return { kind: 'ok', balance: body?.balance };
      if (status === 402 && kind === 'debit') return { kind: 'declined' };
      if (status < 500) return { kind: 'failed', reason: `status ${status}` };
    } catch (err) {
      log.info('webhook attempt', { ...fields, error: err.name === 'TimeoutError' ? 'timeout' : err.message });
    }
    if (i < delays.length) await sleep(delays[i]);
  }
  return { kind: 'failed', reason: 'retries exhausted' };
}

export const wallet = {
  debit: (payload) => deliver('debit', payload),

  credit(payload) {
    if (faults.duplicateWebhooks) {
      setTimeout(() => deliver('credit', payload), 50);
    }
    return deliver('credit', payload);
  },
};
