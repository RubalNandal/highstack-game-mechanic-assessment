/**
 * Optional integration-test switches for deliberate duplicate payments, delays and stream faults.
 * All are off by default; they test recovery paths rather than define game mechanics.
 */

function flag(name) {
  return process.env[name] === '1';
}

function seconds(name) {
  const value = Number(process.env[name] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export const faults = {
  duplicateWebhooks: flag('DUPLICATE_WEBHOOKS'),
  dropWsEverySec: seconds('DROP_WS_EVERY'),
  reorder: flag('REORDER'),
  cashoutTimeout: flag('CASHOUT_TIMEOUT'),
  clockSkewSec: seconds('CLOCK_SKEW'),
};

export function activeFaults() {
  return Object.fromEntries(Object.entries(faults).filter(([, value]) => value));
}
