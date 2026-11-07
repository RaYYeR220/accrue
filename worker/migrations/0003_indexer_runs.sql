-- Run boundaries and data coverage for honest windows.
-- pool_hour.first_payout_ts: with last_payout_ts, shows whether a payout run crosses an hour edge.
-- pool_cursor.reach_ts: time of newest_block (how far the data reaches; windows end there).
-- pool_cursor.hole_from_ts / hole_to_ts: while a descent is open, no data exists between them.
-- pools.reward_misses: consecutive "No validator" answers; a known reward address is dropped only
-- after two.
ALTER TABLE pool_hour ADD COLUMN first_payout_ts INTEGER;
ALTER TABLE pool_cursor ADD COLUMN reach_ts INTEGER;
ALTER TABLE pool_cursor ADD COLUMN hole_from_ts INTEGER;
ALTER TABLE pool_cursor ADD COLUMN hole_to_ts INTEGER;
ALTER TABLE pools ADD COLUMN reward_misses INTEGER NOT NULL DEFAULT 0;
