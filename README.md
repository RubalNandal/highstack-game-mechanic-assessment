# HighStack — Full-Stack Take-Home: Crash Engine Proxy

HighStack runs an online casino. Most games come from third-party providers. The provider runs the game. We, the **operator**, own the players and their money.

This repo contains **crashsim**, a small crash game engine. It acts like a third-party provider. Your job is to build the operator side: a service that talks to crashsim, and a small player client.

In a crash game, a multiplier starts at 1.00x and grows. At a random point it "crashes". A player bets before the round starts. The player wins `bet × multiplier` if they cash out before the crash. If not, they lose the bet.

## Run

You need Docker.

```sh
docker compose up
```

This starts:

| Service    | Port | Notes                                                          |
| ---------- | ---- | -------------------------------------------------------------- |
| `engine`   | 4000 | crashsim                                                       |
| `postgres` | 5432 | Postgres 16. User, password and database are all `operator`. |

The engine sends wallet calls to `OPERATOR_URL`. The default is `http://host.docker.internal:3000`, so it reaches a service on port 3000 of your machine. If you run your operator inside Docker Compose, change `OPERATOR_URL` (for example `http://operator:3000`).

Engine settings:

| Variable         | Value                |
| ---------------- | -------------------- |
| `OPERATOR_KEY`   | `dev-operator-key`   |
| `WEBHOOK_SECRET` | `dev-webhook-secret` |

To run the engine without Docker: `cd engine && npm install && npm start` (Node 22+).

## Engine spec

### Round cycle

Rounds run one after another, forever.

1. **betting** — 5 seconds. Bets are accepted.
2. **running** — the multiplier grows from 1.00. Cash-outs are accepted.
3. **crashed** — the multiplier stops at the crash point. Active bets that did not cash out are lost. After 3 seconds, the next round starts.

The multiplier at `t` milliseconds after the start is:

```
multiplier(t) = floor(100 * e^(0.00006 * t)) / 100
```

Amounts are integers in minor units (cents). Multipliers have 2 decimals.

### REST API

Base URL: `http://localhost:4000`. Every request must send the header `x-operator-key`. If the key is missing or wrong, the engine returns `401`. Bodies are JSON.

| Method | Path                    | Body                                            | Success response                                                                  |
| ------ | ----------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/players/:id/session`  | —                                               | `{ sessionId }`                                                                   |
| POST   | `/bets`                 | `{ sessionId, roundId, amount, autoCashout? }`  | `{ betId, status }`                                                               |
| POST   | `/bets/:id/cashout`     | —                                               | `{ betId, status: "cashed_out", multiplier, payout }`                             |
| GET    | `/bets/:id`             | —                                               | `{ betId, playerId, roundId, amount, status, autoCashout?, multiplier?, payout? }` |
| GET    | `/rounds/current`       | —                                               | `{ roundId, state, seq, serverSeedHash, bettingEndsAt?, startedAt?, multiplier?, crashPoint?, serverSeed? }` |

Details:

- **`/players/:id/session`** — `:id` is your player id (`[A-Za-z0-9_-]`, 1–64 characters). A bet needs a session.
- **`POST /bets`** — only during `betting`, and only for the current `roundId`. `amount` is an integer from 1 to 1,000,000,000. `autoCashout` is optional: a multiplier from 1.01, with at most 2 decimals. Before the engine accepts the bet, it calls your **debit** webhook and waits for the answer.
  - Debit returns `200` → `200 { betId, status: "active" }`.
  - Debit returns `402` → `402 { error: "insufficient_funds", betId, status: "rejected" }`.
  - Debit fails → `502 { error: "wallet_unavailable", betId, status: "rejected" }`.
- **`POST /bets/:id/cashout`** — only while the round is `running`. The engine locks the current multiplier (the value of the last `tick`). `payout = floor(amount * multiplier)`. The engine then calls your **credit** webhook with the payout.
- **Auto cash-out** — when the multiplier reaches `autoCashout`, the bet cashes out at exactly `autoCashout`. If the round crashes at or below `autoCashout`, the bet is lost.
- **Bet status** — `pending` (waiting for debit), `active`, `cashed_out`, `lost`, `rejected`.
- **`/rounds/current`** — `seq` is the `seq` of the last stream event.

Errors have the shape `{ error, message? }`:

| Status | `error`                                                          |
| ------ | ---------------------------------------------------------------- |
| 400    | `invalid_request`                                                |
| 401    | `unauthorized`                                                   |
| 402    | `insufficient_funds`                                             |
| 404    | `not_found`, `session_not_found`, `bet_not_found`                |
| 409    | `betting_closed`, `round_not_running`, `bet_not_active`          |
| 502    | `wallet_unavailable`                                             |

### Stream

WebSocket: `ws://localhost:4000/stream`. Send the operator key in the `x-operator-key` header, or as a query parameter: `/stream?key=dev-operator-key`.

Every message is one JSON event:

```json
{ "type": "tick", "seq": 1042, "data": { "roundId": "…", "multiplier": 1.37, "t": 5200 } }
```

`seq` is a global number. It increases by 1 for each event, across all rounds.

| `type`           | `data`                                           | When                              |
| ---------------- | ------------------------------------------------ | --------------------------------- |
| `round.betting`  | `{ roundId, serverSeedHash, bettingEndsAt }`     | A new round opens for bets.       |
| `round.started`  | `{ roundId, startedAt }`                         | The multiplier starts.            |
| `tick`           | `{ roundId, multiplier, t }`                     | Every 100 ms while running. `t` is ms since start. |
| `bet.cashed_out` | `{ betId, playerId, roundId, multiplier, payout }` | A bet cashed out (manual or auto). |
| `round.crashed`  | `{ roundId, crashPoint, serverSeed }`            | The round ends.                   |

Times (`bettingEndsAt`, `startedAt`) are Unix milliseconds.

### Wallet webhooks (engine → operator)

The engine calls your service to move money.

| Call   | URL                               | When                        |
| ------ | --------------------------------- | --------------------------- |
| Debit  | `POST {OPERATOR_URL}/wallet/debit`  | A player places a bet.    |
| Credit | `POST {OPERATOR_URL}/wallet/credit` | A bet cashes out.         |

A lost bet has no call.

Body:

```json
{ "txId": "…", "playerId": "…", "amount": 1000, "betId": "…", "roundId": "…" }
```

Headers:

| Header        | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| `x-timestamp` | Unix time in seconds.                                         |
| `x-signature` | `hex(HMAC_SHA256(WEBHOOK_SECRET, "${x-timestamp}.${rawBody}"))` |

`rawBody` is the exact request body, as bytes.

Expected responses:

| Response            | Meaning                                  |
| ------------------- | ---------------------------------------- |
| `200 { balance }`   | Done. `balance` is the new balance.      |
| `402`               | Debit only: not enough funds.            |

The engine may retry a webhook.

### Provably fair

Each round has a random `serverSeed` (64 hex characters).

1. At `round.betting`, the engine publishes `serverSeedHash = hex(SHA256(serverSeed))`.
2. At `round.crashed`, the engine reveals `serverSeed`.

Anyone can then check the crash point:

```
hash = hex(HMAC_SHA256(key = serverSeed, message = roundId))
h    = first 13 hex characters of hash, as an integer (52 bits)
e    = 2^52

if h % 100 == 0:  crashPoint = 1.00
else:             crashPoint = floor((100 * e - h) / (e - h)) / 100
```

`serverSeed` and `roundId` are used as UTF-8 text. Use integer math (for example `BigInt`) for the division. Reference: `engine/src/fair.js`.

## Your task

Build an **operator service** and a small **player client**.

Use these where you can: Node, Fastify, Postgres, Drizzle, Valibot, React 19, TypeScript. Redis is optional. You can put your code in `operator/` and `client/`, or use another layout.

Must have:

1. **Proxy.** The browser never talks to the engine. The operator key stays on the server.
2. **Wallet.** Balances live in Postgres. Implement the debit and credit webhooks. A balance never goes below zero.
3. **Real-time.** Fan out the engine stream to browsers (WebSocket or SSE). A browser that reconnects returns to the correct state.
4. **Client.** Show the multiplier and the balance. Have a bet form and a cash-out button.
5. **Validation.** Validate all input from the engine and from the browser.
6. **Migrations.** Make schema changes as Drizzle migrations.
7. **Tests.** At least for the wallet.

Seed a few players with a starting balance. A simple player picker is fine — you do not need real login.

## What to send back

- A repo where `docker compose up` runs everything (engine, Postgres, your operator, your client).
- Your commit history. Do not squash it.
- A section in this README (or a new file) with:
  - The decisions you made, and why.
  - The failure modes you considered, and the ones you did not handle.
  - How you used AI: which tools, where they helped, where they were wrong. This does not change your score.

## Time

You have **3 days** from the day you get this brief. Unfinished work is fine. Tell us what you would do next.

## AI tools

AI tools are allowed.

## Submit

Please submit in a private repo and invite the reviewers we give you.
