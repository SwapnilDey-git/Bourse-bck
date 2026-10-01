-- Migration 0005 — daily rollups replace raw fill history (incident 2026-10-01).
--
-- Raw `fill` rows cost ~470 B each with indexes, and ~20% of discovered wallets
-- are market makers doing 2k–10k fills/day — the new project went from empty
-- to its 512 MB cap in under an hour. Every leaderboard metric is a sum or a
-- min/max, so it's computed from one row per wallet × UTC day × ticker instead;
-- `fill` keeps only each wallet's newest rows for the UI's raw-trade views
-- (profile history, asset tab, fresh feed). See src/lib/wallets/ingest.ts
-- planIngest + src/lib/wallets/sql.ts for how the worker writes both.
--
-- Safe on an empty database (fresh setup) and on a populated one: existing
-- fills are folded into fill_daily before `fill` is cut back to its tail.
-- Stop the worker before running this on a live database.

CREATE TABLE IF NOT EXISTS fill_daily (
  address  TEXT NOT NULL REFERENCES wallet(address) ON DELETE CASCADE,
  day      DATE NOT NULL,                     -- UTC day of the fills
  ticker   TEXT NOT NULL,
  trades   INTEGER NOT NULL DEFAULT 0,        -- fills that day
  closes   INTEGER NOT NULL DEFAULT 0,        -- closing fills (win-rate denominator)
  wins     INTEGER NOT NULL DEFAULT 0,        -- closing fills with closed_pnl > 0
  pnl      DOUBLE PRECISION NOT NULL DEFAULT 0, -- Σ closed_pnl over closing fills
  first_t  TIMESTAMPTZ NOT NULL,              -- earliest fill that day (active-span basis)
  last_t   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (address, day, ticker)
);
-- relatedWallets (bourse-app src/lib/wallets) — "who else traded my tickers in 60 days".
CREATE INDEX IF NOT EXISTS fill_daily_ticker_day_idx ON fill_daily (ticker, day);

INSERT INTO fill_daily (address, day, ticker, trades, closes, wins, pnl, first_t, last_t)
SELECT address, (time AT TIME ZONE 'UTC')::date, ticker,
       count(*),
       count(*) FILTER (WHERE is_close),
       count(*) FILTER (WHERE is_close AND closed_pnl > 0),
       COALESCE(sum(closed_pnl) FILTER (WHERE is_close), 0),
       min(time), max(time)
FROM fill
GROUP BY 1, 2, 3
ON CONFLICT DO NOTHING;

-- Rebuild `fill` with only each wallet's newest 50 rows (plus every row at its
-- newest ms — the worker's dedupe boundary). Copy-and-swap rather than DELETE,
-- so the space comes back at COMMIT instead of waiting on VACUUM FULL.
CREATE TABLE fill_tail (LIKE fill INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
INSERT INTO fill_tail (tid, address, coin, ticker, side, dir, leveraged, sz, px, notional, closed_pnl, fee, is_close, time)
SELECT tid, address, coin, ticker, side, dir, leveraged, sz, px, notional, closed_pnl, fee, is_close, time
FROM (
  SELECT f.*,
         row_number() OVER (PARTITION BY address ORDER BY time DESC, tid DESC) AS rn,
         max(time) OVER (PARTITION BY address) AS newest
  FROM fill f
) ranked
WHERE rn <= 50 OR time = newest;

DROP TABLE fill;
ALTER TABLE fill_tail RENAME TO fill;
ALTER TABLE fill ADD CONSTRAINT fill_pkey PRIMARY KEY (tid);
ALTER TABLE fill ADD CONSTRAINT fill_address_fkey FOREIGN KEY (address) REFERENCES wallet(address) ON DELETE CASCADE;
CREATE INDEX fill_address_time_idx ON fill (address, time DESC);
CREATE INDEX fill_ticker_time_idx  ON fill (ticker, time DESC);
ALTER TABLE fill SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
