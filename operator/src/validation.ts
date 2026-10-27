import * as v from 'valibot';

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const amount = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
export const WalletSchema = v.strictObject({
  txId: id,
  playerId: id,
  betId: id,
  roundId: id,
  amount,
});

export const SessionSchema = v.object({ sessionId: v.pipe(v.string(), v.uuid()) });
export const BetResponseSchema = v.object({
  betId: v.pipe(v.string(), v.uuid()),
  status: v.picklist(['pending', 'active', 'cashed_out', 'lost', 'rejected', 'refunded']),
});
export const RoundSnapshotSchema = v.object({
  roundId: v.pipe(v.string(), v.uuid()),
  state: v.picklist(['betting', 'running', 'crashed']),
  seq: amount,
  serverSeedHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  nonce: amount,
  configVersion: id,
  multiplier: v.optional(v.pipe(v.number(), v.minValue(1))),
  bettingEndsAt: v.optional(amount),
});
export const BetSchema = v.strictObject({
  betId: v.pipe(v.string(), v.uuid()),
  roundId: v.pipe(v.string(), v.uuid()),
  amount: v.pipe(amount, v.minValue(1), v.maxValue(1_000_000_000)),
  autoCashout: v.optional(
    v.pipe(
      v.number(),
      v.minValue(1.01),
      v.maxValue(1_000_000),
      v.check((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8),
    ),
  ),
});
const roundId = v.pipe(v.string(), v.uuid());
const roundEvent = v.variant('type', [
  v.object({
    type: v.literal('round.betting'),
    data: v.object({
      roundId,
      serverSeedHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
      bettingEndsAt: amount,
    }),
  }),
  v.object({ type: v.literal('round.started'), data: v.object({ roundId, startedAt: amount }) }),
  v.object({
    type: v.literal('tick'),
    data: v.object({ roundId, multiplier: v.pipe(v.number(), v.minValue(1)), t: amount }),
  }),
  v.object({
    type: v.literal('round.crashed'),
    data: v.object({
      roundId,
      crashPoint: v.pipe(v.number(), v.minValue(1)),
      serverSeed: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
  }),
  v.object({
    type: v.literal('bet.cashed_out'),
    data: v.object({
      roundId,
      betId: roundId,
      playerId: id,
      multiplier: v.number(),
      payout: amount,
    }),
  }),
]);
export const StreamSchema = v.intersect([
  v.object({ seq: v.pipe(amount, v.minValue(1)) }),
  roundEvent,
]);

export function parseInput<T extends v.GenericSchema>(schema: T, input: unknown): v.InferOutput<T> {
  const result = v.safeParse(schema, input);
  if (!result.success)
    throw Object.assign(new Error(result.issues[0].message), { statusCode: 400 });
  return result.output;
}
