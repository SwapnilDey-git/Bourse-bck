-- Migration 0004 — drop the two `fill` indexes nothing needs (incident 2026-10-01).
--
-- fill_coin_time_idx: no query filters `fill` by coin (every read uses ticker) —
--   0 scans on the live database, 53 MB at 1.1M rows.
-- fill_time_idx: only served the derive candidate scan and the retain loop's
--   time-based prune; after 0005 derive reads fill_daily and raw `fill` is
--   capped per wallet, so neither needs it.
--
-- Its own migration (= its own transaction) on purpose: a database already at
-- its storage cap can't extend any file, and space freed by DROP INDEX only
-- comes back at COMMIT — 0005 needs that room to build fill_daily.

DROP INDEX IF EXISTS fill_coin_time_idx;
DROP INDEX IF EXISTS fill_time_idx;
