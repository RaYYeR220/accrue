CREATE TABLE pools (
  address TEXT PRIMARY KEY, name TEXT, reward_address TEXT, fee REAL, payout_type TEXT, schedule TEXT,
  balance INTEGER, stakers INTEGER, accent TEXT, logo TEXT, listed INTEGER, updated_at INTEGER
);
CREATE TABLE pool_cursor (
  pool TEXT PRIMARY KEY, newest_hash TEXT, newest_block INTEGER, oldest_block INTEGER, backfill_done INTEGER
);
CREATE TABLE pool_hour (
  pool TEXT, hour INTEGER, earned INTEGER, paid_restake INTEGER, paid_direct INTEGER, other_out INTEGER,
  payout_batches INTEGER, last_payout_ts INTEGER,
  PRIMARY KEY (pool, hour)
);
CREATE TABLE staker_day (
  pool TEXT, staker TEXT, day INTEGER, received INTEGER,
  PRIMARY KEY (pool, staker, day)
);
CREATE TABLE recipient_delegation (address TEXT PRIMARY KEY, delegation TEXT, checked_at INTEGER);
CREATE TABLE relay_jobs (
  id TEXT PRIMARY KEY, owner TEXT, kind TEXT, asset TEXT, amount TEXT, status TEXT, tx_hash TEXT,
  nonce INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE relay_budget (day INTEGER PRIMARY KEY, gas_wei TEXT, count INTEGER);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
