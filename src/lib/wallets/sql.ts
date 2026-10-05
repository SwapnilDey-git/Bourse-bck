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

// ── sync queue (migration 0006) ──────────────────────────────────────────────
// $1 addresses (text[]). Discover's flush: every address just seen in the
// trades WebSocket is marked due for CLAIM_SYNC_BATCH_SQL. last_trade_seen_at
// means "dirty since" — it's stamped only when the wallet isn't already
// waiting, so a wallet that trades every minute keeps its place in the FIFO
// instead of being pushed to the back on each trade (~180 distinct wallets
// trade per minute vs ~30 syncs/min of budget, measured 2026-10-05, so the
// dirty set is usually bigger than one tick). `inserted` (xmax = 0) is true
// only for rows this statement created, so callers can still count new wallets.
export const UPSERT_WALLETS_SQL = `
INSERT INTO wallet (address, last_trade_seen_at) SELECT unnest($1::text[]), now()
ON CONFLICT (address) DO UPDATE SET last_trade_seen_at = now()
  WHERE wallet.last_trade_seen_at IS NULL
     OR wallet.last_trade_seen_at <= COALESCE(wallet.last_synced_at, '-infinity')
RETURNING (xmax = 0) AS inserted`;

// $1 limit · $2 lease ms. Claim + lease a batch (FOR UPDATE SKIP LOCKED, so
// concurrent claimers get disjoint sets). Wallets that traded since we last
// synced them ("dirty") go first, in priority classes, then everyone else by
// when we last looked. last_synced_at is stamped at CLAIM time, before the
// fetch, so a trade landing mid-pass leaves the wallet dirty for the next tick
// instead of being cleared by this one.
//
// Why classes: more distinct wallets trade per hour (~3,450, measured
// 2026-10-05) than the 1000 wt/min budget can sync (every userFillsByTime
// call costs ≥20 wt, so ≤50 wallets/min even with no backlog), so the dirty
// set only grows and a plain FIFO left every wallet waiting hours. Dirty
// wallets are served in this order, FIFO (oldest trade first) within each:
//   0. on a leaderboard (top 500 of P&L, activity, or qualifying win rate) —
//      what /wallets and its profiles show
//   1. never indexed — new wallets; nothing about them is known until synced
//   2. fresh (<30d, the /fresh feed)
//   3. everyone else
// A wallet re-dirtied by trading again goes to the back of its class, so a
// constant trader can't hold the front.
export const CLAIM_SYNC_BATCH_SQL = `
WITH lb AS (
  (SELECT address FROM wallet_metrics ORDER BY realized_pnl DESC LIMIT 500)
  UNION (SELECT address FROM wallet_metrics ORDER BY trade_count DESC LIMIT 500)
  UNION (SELECT address FROM wallet_metrics WHERE qualifies_winrate ORDER BY win_rate DESC LIMIT 500)
), due AS (
  SELECT w.address FROM wallet w
  WHERE (w.claimed_until IS NULL OR w.claimed_until <= now())
    AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= now())
  ORDER BY CASE
             WHEN NOT COALESCE(w.last_trade_seen_at > COALESCE(w.last_synced_at, '-infinity'), false) THEN 4
             WHEN w.address IN (SELECT address FROM lb) THEN 0
             WHEN w.last_indexed_at IS NULL THEN 1
             WHEN w.is_fresh THEN 2
             ELSE 3
           END,
           CASE WHEN w.last_trade_seen_at > COALESCE(w.last_synced_at, '-infinity') THEN w.last_trade_seen_at END ASC,
           w.last_synced_at ASC NULLS FIRST
  LIMIT $1
  FOR UPDATE OF w SKIP LOCKED
)
UPDATE wallet SET claimed_until = now() + ($2 || ' milliseconds')::interval, last_synced_at = now()
FROM due WHERE wallet.address = due.address
RETURNING wallet.address, wallet.last_indexed_at`;

// $1 address · $2 error message. Sync failed: bump fail_count, release the
// claim, and clear last_synced_at — the claim stamped it, and leaving it would
// silently drop a just-traded wallet out of the dirty set. NULL puts it at the
// front again, gated by the backoff the caller writes to next_attempt_at.
export const RECORD_SYNC_FAILURE_SQL = `
UPDATE wallet SET fail_count = fail_count + 1, last_error = $2, claimed_until = NULL, last_synced_at = NULL
WHERE address = $1 RETURNING fail_count`;
