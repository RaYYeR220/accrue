-- Indexer state the first schema had no room for.
-- pool_cursor: an open descent (resume_hash..floor_block) lets a catch-up span several cron ticks;
-- last_payout_block keeps payout batches that straddle two ticks counted once;
-- visited_at / txs_per_hour drive which pools a tick visits.
ALTER TABLE pool_cursor ADD COLUMN resume_hash TEXT;
ALTER TABLE pool_cursor ADD COLUMN floor_block INTEGER;
ALTER TABLE pool_cursor ADD COLUMN last_payout_block INTEGER;
ALTER TABLE pool_cursor ADD COLUMN visited_at INTEGER;
ALTER TABLE pool_cursor ADD COLUMN txs_per_hour REAL;
-- payouts to recipients whose delegation could not be checked (part of paid_restake/paid_direct)
ALTER TABLE pool_hour ADD COLUMN paid_unverified INTEGER NOT NULL DEFAULT 0;
-- number of payouts behind `received`, for the per-staker cycle count
ALTER TABLE staker_day ADD COLUMN payouts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pools ADD COLUMN reward_checked_at INTEGER;
