// The SQL behind IngestDb's storage-shaped methods, shared verbatim by both
// runtimes (worker/src/db.ts on pg, worker-cf/src/db.ts on the neon HTTP
// driver) so the fill_daily math can't drift between them. Every parameter is
// a plain number, string, number[] or JSON string, and timestamps cross the
// wire as epoch ms (to_timestamp in SQL), so neither driver's Date handling
// matters.

// $1 tail rows (JSON FillInsert[]) · $2 boundary tids · $3 DailyAgg[] (JSON)
// $4 address · $5 new watermark ms. One statement, so it's atomic: raw tail
// insert, fill_daily upsert and the watermark move commit together — a crash
// can't leave fills counted with the watermark still behind them.
// Data-modifying CTEs run even when unreferenced; `counted` is the result.
export const INGEST_FILLS_SQL = `
WITH ins AS (
  INSERT INTO fill (tid, address, coin, ticker, side, dir, leveraged, sz, px, notional, closed_pnl, fee, is_close, time)
  SELECT r.tid, $4, r.coin, r.ticker, r.side, r.dir, r.leveraged, r.sz, r.px, r.notional,
         r."closedPnl", r.fee, r."isClose", to_timestamp(r.time / 1000.0)
  FROM json_to_recordset($1::json) AS r(
    tid bigint, coin text, ticker text, side text, dir text, leveraged boolean, sz float8, px float8,
    notional float8, "closedPnl" float8, fee float8, "isClose" boolean, time float8)
  ON CONFLICT (tid) DO NOTHING
  RETURNING tid, ticker, time, closed_pnl, is_close
),
src AS (
  SELECT (time AT TIME ZONE 'UTC')::date AS day, ticker, 1 AS trades, is_close::int AS closes,
         (is_close AND closed_pnl > 0)::int AS wins,
         CASE WHEN is_close THEN closed_pnl ELSE 0 END AS pnl, time AS first_t, time AS last_t
  FROM ins WHERE tid = ANY($2::bigint[])
  UNION ALL
  SELECT d.day, d.ticker, d.trades, d.closes, d.wins, d.pnl,
         to_timestamp(d."firstMs" / 1000.0), to_timestamp(d."lastMs" / 1000.0)
  FROM json_to_recordset($3::json) AS d(
    day date, ticker text, trades int, closes int, wins int, pnl float8, "firstMs" float8, "lastMs" float8)
),
up AS (
  INSERT INTO fill_daily AS f (address, day, ticker, trades, closes, wins, pnl, first_t, last_t)
  SELECT $4, day, ticker, sum(trades), sum(closes), sum(wins), sum(pnl), min(first_t), max(last_t)
  FROM src GROUP BY day, ticker
  ON CONFLICT (address, day, ticker) DO UPDATE SET
    trades = f.trades + EXCLUDED.trades,
    closes = f.closes + EXCLUDED.closes,
    wins   = f.wins + EXCLUDED.wins,
    pnl    = f.pnl + EXCLUDED.pnl,
    first_t = LEAST(f.first_t, EXCLUDED.first_t),
    last_t  = GREATEST(f.last_t, EXCLUDED.last_t)
),
wm AS (
  UPDATE wallet SET last_indexed_at = to_timestamp($5 / 1000.0) WHERE address = $4
)
SELECT COALESCE(sum(trades), 0)::int AS counted FROM src`;

// $1 address · $2 rows to keep. Keeps the newest $2 raw rows (what profiles,
// the asset tab and the fresh feed display) and never the newest ms — that's
// the next pass's dedupe boundary (see planIngest).
export const TRIM_RAW_FILLS_SQL = `
DELETE FROM fill
WHERE address = $1
  AND time < (SELECT max(time) FROM fill WHERE address = $1)
  AND tid IN (SELECT tid FROM fill WHERE address = $1 ORDER BY time DESC, tid DESC OFFSET $2)`;

// $1 window days. deriveMetrics (./metrics.ts) as one set-based statement over
// fill_daily: same sums, same win-rate gate (≥20 closes over ≥30 active days),
// same active-span rounding. Only rows whose numbers actually changed are
// rewritten, so a quiet tick doesn't churn wallet_metrics or its indexes.
export const RECOMPUTE_METRICS_SQL = `
WITH m AS (
  SELECT address,
         sum(pnl) AS realized_pnl,
         sum(trades)::int AS trade_count,
         sum(closes)::int AS closed_count,
         sum(wins) AS wins,
         GREATEST(1, round(extract(epoch FROM max(last_t) - min(first_t)) / 86400))::int AS active_days
  FROM fill_daily
  WHERE day >= (now() AT TIME ZONE 'UTC')::date - $1::int
  GROUP BY address
)
INSERT INTO wallet_metrics AS wm
  (address, realized_pnl, win_rate, trade_count, closed_count, active_days, age_days, qualifies_winrate, computed_at)
SELECT m.address, m.realized_pnl,
       CASE WHEN m.closed_count > 0 THEN m.wins::float8 / m.closed_count ELSE 0 END,
       m.trade_count, m.closed_count, m.active_days,
       COALESCE(GREATEST(0, floor(extract(epoch FROM now() - w.first_hip3_trade_at) / 86400)), 0)::int,
       m.closed_count >= 20 AND m.active_days >= 30,
       now()
FROM m JOIN wallet w USING (address)
ON CONFLICT (address) DO UPDATE SET
  realized_pnl = EXCLUDED.realized_pnl, win_rate = EXCLUDED.win_rate, trade_count = EXCLUDED.trade_count,
  closed_count = EXCLUDED.closed_count, active_days = EXCLUDED.active_days, age_days = EXCLUDED.age_days,
  qualifies_winrate = EXCLUDED.qualifies_winrate, computed_at = EXCLUDED.computed_at
WHERE (wm.realized_pnl, wm.win_rate, wm.trade_count, wm.closed_count, wm.active_days, wm.age_days, wm.qualifies_winrate)
  IS DISTINCT FROM
      (EXCLUDED.realized_pnl, EXCLUDED.win_rate, EXCLUDED.trade_count, EXCLUDED.closed_count,
       EXCLUDED.active_days, EXCLUDED.age_days, EXCLUDED.qualifies_winrate)
RETURNING wm.address`;

// $1 cutoff ms. fill_daily is small (one row per wallet·day·ticker), so one DELETE.
export const PRUNE_DAILY_SQL = `
DELETE FROM fill_daily WHERE day < (to_timestamp($1 / 1000.0) AT TIME ZONE 'UTC')::date`;

// $1 cutoff ms · $2 batch size. Raw rows are capped per wallet, so this only
// catches long-idle wallets' leftover tails.
export const PRUNE_RAW_SQL = `
DELETE FROM fill WHERE tid IN (SELECT tid FROM fill WHERE time < to_timestamp($1 / 1000.0) LIMIT $2)`;
