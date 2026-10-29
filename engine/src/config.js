/**
 * Connection secrets, base-game timing and wallet retry settings for the engine.
 * Bonus chance, factor weights and payout cap come from the operator's separate bonus config.
 */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  operatorUrl: (process.env.OPERATOR_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  operatorKey: process.env.OPERATOR_KEY ?? 'dev-operator-key',
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  bettingMs: 5000,
  crashedPauseMs: 3000,
  tickMs: 100,

  webhookTimeoutMs: 2000,
  webhookRetryDelaysMs: [500, 1000, 2000, 4000, 8000],
};
