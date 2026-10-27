# HighStack — Game Mechanic Assessment

A deterministic, configurable bonus added to the supplied crash game. It includes the missing wallet receiver and player client, persistent round replay, and tests for the mechanic and money handling. The original brief shipped with the starter is preserved in [docs/STARTER_README.md](docs/STARTER_README.md).

## Run and demonstrate

```sh
docker compose up --build
```

Open **http://localhost:3100**. The demo player starts with **$1,000.00**. Place a bet during the five-second betting window, then cash out manually or set an automatic target. The final result shows base winnings, bonus, cap and payment status. After the round ends, select **Replay** to verify the saved outcome.

The example cards demonstrate no bonus, configured multipliers and the win cap using the same calculation as live play. They never alter the wallet. A bonus occurs with the configured probability in live rounds, so examples make every branch easy to inspect.

Postgres data survives normal restarts. Seeding never resets an existing balance. Only the demo website and database are published to localhost; the engine and its operator key stay inside the Docker network. To change the website port, set `DEMO_PORT` in `.env` using `.env.example`.

## Verify

Run the unit and Postgres integration suites in an isolated test database:

```sh
docker compose --profile test run --build --rm tests
```

With the demo running, Node 22+ can exercise a live bet, duplicate request, wallet balance and replay:

```sh
npm run test:smoke
node scripts/recovery-smoke.mjs
```

The second command deliberately restarts this project's engine and verifies an interrupted stake is refunded. Use an idle demo; other simultaneous player actions can change its balance assertion. Set `DEMO_URL` if you changed the port.

For host unit tests: `npm ci && npm test`. Host database tests require a dedicated `TEST_DATABASE_URL` and `npm run test:integration`; never point this at a production database.

## Structure and decisions

| Location | Responsibility |
| --- | --- |
| `engine/src` | Existing crash cycle, sessions, bets and events; integrated bonus settlement and payment recovery. |
| `packages/bonus` | Pure TypeScript mechanic and Valibot config validation. No HTTP, database or browser dependencies. |
| `packages/storage` | Shared Drizzle schema, SQL migration, round records and transactional wallet operations. |
| `operator/src` | Fastify wallet callbacks, player API, filtered event stream, replay and static client. |
| `client/src` | Small React 19 interface. |
| `configs/bonus.json` | Versioned bonus settings. |

I retained the working JavaScript engine and wrote the new modules in TypeScript. A small shared storage package avoids defining two competing schemas for the engine and wallet. Plain functions handle the mechanic; the storage class owns its connection pool. One engine owns the round clock, enforced by a database advisory lock.

The browser uses only the operator API. It cannot choose a player, submit a payout or obtain the operator key. This is deliberately one seeded demo identity; it is not production authentication.

## Rules and deterministic calculation

`evaluateBonus(seed, bet, config)` takes:

- Seed: `{ serverSeed, nonce }`.
- Bet: `{ amount, baseWin }`, in integer minor units.
- Config: `{ version, triggerChance, multipliers, maxWin }`.

It returns `triggered`, `multiplier`, `baseWin`, `finalWin`, `capped` and `configVersion`. The same complete inputs reproduce the same outcome. All bets in one round share the same bonus decision. A losing bet has zero base winnings and stays zero.

The trigger uses millionths of probability. Multipliers support two decimals; weights are non-negative integers with a positive, safe-integer total. Independent HMAC-SHA256 draws use the server seed as a UTF-8 key and JSON text `["bonus-v1", nonce, version, label, counter]` as the message. Labels are `trigger` and `multiplier`. Rejection sampling maps the 256-bit value into each integer range without modulo bias.

Base cash-out winnings are floored first, following the starter. Bonus multiplication uses `BigInt` hundredths, floors once, then caps the **total payout**, including when the bonus does not trigger. The cap includes the stake already present in the base payout; it is not an additional-profit cap. Balances and API money remain safe integers, not floating-point currency.

Every round saves its seed, nonce and immutable config version before betting opens. Settlement saves the bet, base winnings, selected multiplier and final result. Replay loads those inputs and checks the same function against the saved outcome. Seeds stay private until the round ends, preserving the starter's hash commitment. Replay cannot issue payments.

The promised official bonus seed examples were not supplied. The project-owned regression vector uses seed `assessment-example`, nonce `0`, version `test-v1`, chance `1`, weights `60/30/10` for `2x/5x/10x`, stake `100`, base win `200` and cap `100000`: the selected bonus is `5x`, final win `1000`. This is documented implementation behaviour, not a claim to match unavailable official vectors.

## Change config

Edit [configs/bonus.json](configs/bonus.json). For example, change `triggerChance` to `0.1`, alter table weights or set `maxWin` to `50000`. **Give changed content a new version**, such as `bonus-v2`.

The engine validates and freezes the config at each new round. An existing round and its replay retain the original snapshot. Restart only the operator (`docker compose restart operator`) to refresh its cached example cards after an edit; the engine loads the file for its next round automatically.

Values such as chance `1.2`, a negative weight, an empty/all-zero table or fractional `maxWin` are rejected. Reusing a version for different content is rejected. Invalid config stops new play with a visible connection error and server log; it is never silently replaced. Fix the file and restart the affected service.

## Add another mechanic

Another game can import the existing module directly:

```ts
const outcome = evaluateBonus(
  { serverSeed, nonce },
  { amount: stakeInCents, baseWin: baseWinInCents },
  validatedConfig,
);
// Persist outcome; send outcome.finalWin through that game's wallet path.
```

For a different rule, add a pure function with the same explicit input/output boundary and its own validated config. Replace the calculation at settlement (`Store.settleWin`), zero-win settlement (`Store.markLost`), round reveal (`game.js`), replay (`Store.replay`) and examples (`makeExamples`). Keep those callers on the same implementation and record the new config/rule version. Tests should prove deterministic vectors and the new rule's edges. Wallet transactions, signatures and the UI's payment confirmation remain separate from game mathematics.

## Money and failure modes

Wallet requests authenticate the exact body bytes with HMAC and a timestamp within 60 seconds. Amounts must match a recorded bet and its canonical transaction ID. A database transaction locks the player's wallet, checks the prior receipt, changes the balance and records the result together. A unique bet/operation pair also prevents payment under a second ID.

| Situation | Behaviour |
| --- | --- |
| Concurrent bets / insufficient balance | Wallet row locks serialize debits. A balance cannot become negative; declined results are recorded for consistent retries. |
| Duplicate request or lost response | Browser bet IDs and wallet transaction IDs are stable. Matching retries return the saved result; changed details are rejected. |
| Credit endpoint unavailable | The saved payout remains pending. The engine retries it; the UI shows confirmation is pending. |
| Engine restarts mid-round | Accepted, unsettled stakes are refunded once. Unresolved debits are reconciled with their original IDs; already-calculated wins are still paid. |
| Database fails during settlement | The engine stops rather than continuing from uncertain state. Recovery uses the durable records on restart. |
| Config changes | Each round keeps its original snapshot. Reusing the version with changed content fails. |
| Stream drops, gaps or reordered events | The server rejects stale sequence numbers and reconnects. The client reloads authoritative state and also polls. |
| Repeated cash-outs / replay | One settlement wins; repeats cannot pay again. Replay is read-only. |

Not handled as production features: real accounts/authentication, multi-currency, deposits/withdrawals, distributed engine failover, automatic database disaster recovery, regulatory certification, or adversarial load protection. Total balances above JavaScript's safe-integer bound are rejected rather than rounded; resolving such an extreme pending credit would require operator intervention. The supported demo assumes the database is durable and services are restarted after a fatal database/config error.

## Validation notes

Validation uncovered client state updates that failed strict null checks, an authentication test that omitted JSON content type and reached HTTP 415 before signature verification, and dependency versions flagged by `npm audit`. These were corrected through type checking, a properly formed HTTP test and patched dependencies. JSONB object-key ordering and late-debit/crash timing were also addressed during review. The mechanics and money behaviour were checked with deterministic unit tests, real Postgres transactions, Docker smoke tests and browser inspection.
