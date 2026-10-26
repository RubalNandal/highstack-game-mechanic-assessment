CREATE TABLE configurations (version text PRIMARY KEY, hash text NOT NULL, snapshot jsonb NOT NULL);
CREATE TABLE rounds (
  id text PRIMARY KEY, nonce integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  server_seed text NOT NULL, config_version text NOT NULL REFERENCES configurations(version),
  state text NOT NULL CHECK (state IN ('betting','running','crashed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallets (
  player_id text PRIMARY KEY,
  balance bigint NOT NULL CHECK (balance BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE bets (
  id text PRIMARY KEY, player_id text NOT NULL REFERENCES wallets(player_id),
  round_id text NOT NULL REFERENCES rounds(id), amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
  auto_cashout integer, status text NOT NULL CHECK (status IN ('pending','active','cashed_out','lost','rejected','refunded')),
  debit_tx_id text NOT NULL UNIQUE, credit_tx_id text NOT NULL UNIQUE,
  multiplier integer, outcome jsonb, payout bigint CHECK (payout >= 0),
  payout_status text NOT NULL DEFAULT 'none' CHECK (payout_status IN ('none','pending','paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallet_transactions (
  tx_id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('debit','credit')),
  bet_id text NOT NULL REFERENCES bets(id), player_id text NOT NULL REFERENCES wallets(player_id),
  round_id text NOT NULL, amount bigint NOT NULL CHECK (amount >= 0),
  balance bigint NOT NULL CHECK (balance BETWEEN 0 AND 9007199254740991),
  code integer NOT NULL CHECK (code IN (200,402)), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bet_id, kind)
);
CREATE INDEX bets_pending ON bets(status, payout_status);
