// The worker's database client — a pooled `pg` connection (TCP), matched to an
// always-on process, as opposed to the Next side's serverless HTTP driver. Same
// Neon database, both write here / read there. All SQL the loops need is behind
// these helpers so the loop files stay about *logic*, not query strings.
//
// This implements src/lib/wallets/ingest.ts's IngestDb interface — see that
// file for why each method exists (claim/lease for multi-instance safety,
// success/failure bookkeeping for retry backoff).

import pg from "pg";
import { config } from "./config";
import { nextAttemptDelay, type IngestDb, type FillInsert, type SyncTarget } from "./core";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  idleTimeoutMillis: 30_000,
});

type Row = Record<string, unknown>;
async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// ── wallet universe (discover) ───────────────────────────────────────────────
// Upsert a batch of newly-seen addresses. New rows land as tier 'new' (unindexed);
// re-seeing a known wallet is a no-op. Returns count of genuinely-new wallets.
async function upsertWallets(addresses: string[]): Promise<number> {
  if (!addresses.length) return 0;
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const res = await pool.query(
    `INSERT INTO wallet (address) SELECT unnest($1::text[])
     ON CONFLICT (address) DO NOTHING`,
    [uniq],
  );
  return res.rowCount ?? 0;
}

// ── sync (userFills poller) ──────────────────────────────────────────────────
// Atomically claim up to `limit` due wallets and lease them for `leaseMs`, so a
// second worker instance running concurrently can't grab the same rows (review
// finding: "no protection against multiple worker instances" — this is the
// data-safety half of that fix; the shared hl rate budget is still process-
// local, see worker/README.md). FOR UPDATE SKIP LOCKED inside the CTE means two
// concurrent claimers get disjoint sets instead of blocking on each other.
async function claimSyncBatch(limit: number, leaseMs: number): Promise<SyncTarget[]> {
  const res = await pool.query<SyncTarget>(
    `WITH due AS (
       SELECT address FROM wallet
       WHERE (claimed_until IS NULL OR claimed_until <= now())
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY (tier='hot') DESC, last_indexed_at ASC NULLS FIRST
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE wallet SET claimed_until = now() + ($2 || ' milliseconds')::interval
     FROM due WHERE wallet.address = due.address
     RETURNING wallet.address, wallet.last_indexed_at`,
    [limit, leaseMs],
  );
  return res.rows;
}

// Append fills idempotently (tid PK). A hyperactive wallet can drain thousands of
// fills per pass, so we CHUNK the multi-row insert: 14 params/row × 500 rows = 7000
// params, comfortably under Postgres's 65535-parameter bind ceiling (a single giant
// statement overflows it and fails with "bind message has N parameter formats…").
const FILL_COLS = 14;
const FILL_CHUNK = 500;

async function insertFills(rows: FillInsert[]): Promise<number> {
  if (!rows.length) return 0;
  let inserted = 0;
  for (let off = 0; off < rows.length; off += FILL_CHUNK) {
    const chunk = rows.slice(off, off + FILL_CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((r, i) => {
      const b = i * FILL_COLS;
      values.push(r.tid, r.address, r.coin, r.ticker, r.side, r.dir, r.leveraged,
        r.sz, r.px, r.notional, r.closedPnl, r.fee, r.isClose, new Date(r.time));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14})`;
    });
    const res = await pool.query(
      `INSERT INTO fill (tid,address,coin,ticker,side,dir,leveraged,sz,px,notional,closed_pnl,fee,is_close,time)
       VALUES ${tuples.join(",")} ON CONFLICT (tid) DO NOTHING`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// Sync succeeded: advance the watermark, set the age basis if unset, clear the
// claim, and reset any backoff state (a wallet that recovers stops being
// treated as failing).
async function recordSyncSuccess(address: string, watermark: number, earliestFill: number | null): Promise<void> {
  await pool.query(
    `UPDATE wallet SET last_indexed_at = $2,
       first_hip3_trade_at = LEAST(COALESCE(first_hip3_trade_at, $3), $3),
       fail_count = 0, last_error = NULL, next_attempt_at = NULL, claimed_until = NULL
     WHERE address = $1`,
    [address, new Date(watermark), earliestFill ? new Date(earliestFill) : null],
  );
}

// Sync failed: bump fail_count, record the error, release the claim, and push
// next_attempt_at out by an exponential-with-jitter backoff computed from the
// NEW fail_count — so a wallet that keeps failing stops sitting at the front
// of claimSyncBatch's queue (review finding: "a failing wallet can keep
// getting retried").
async function recordSyncFailure(address: string, message: string): Promise<void> {
  const res = await pool.query<{ fail_count: number }>(
    `UPDATE wallet SET fail_count = fail_count + 1, last_error = $2, claimed_until = NULL
     WHERE address = $1 RETURNING fail_count`,
    [address, message.slice(0, 500)],
  );
  const failCount = res.rows[0]?.fail_count ?? 1;
  await pool.query(
    `UPDATE wallet SET next_attempt_at = $2 WHERE address = $1`,
    [address, new Date(Date.now() + nextAttemptDelay(failCount))],
  );
}

// ── derive (metrics) ─────────────────────────────────────────────────────────
// Wallets with any fill in the window, LEAST-recently-derived first — plain
// `SELECT DISTINCT ... LIMIT n` with no ORDER BY had no rotation guarantee, so
// past `limit` distinct wallets some could starve indefinitely (review
// finding: "some wallets may not get their metrics updated"). Wallets never
// derived (no wallet_metrics row yet) sort first via NULLS FIRST.
async function metricsCandidates(sinceMs: number, limit: number): Promise<{ address: string }[]> {
  return q<{ address: string }>(
    `SELECT f.address FROM (SELECT DISTINCT address FROM fill WHERE time >= $1) f
     LEFT JOIN wallet_metrics wm ON wm.address = f.address
     ORDER BY wm.computed_at ASC NULLS FIRST
     LIMIT $2`,
    [new Date(sinceMs), limit],
  );
}

type DeriveFillRow = { time: number; closed_pnl: number; is_close: boolean; notional: number };
function fillsForDerive(address: string, sinceMs: number): Promise<DeriveFillRow[]> {
  return q<DeriveFillRow>(
    `SELECT extract(epoch FROM time)*1000 AS time, closed_pnl, is_close, notional
     FROM fill WHERE address = $1 AND time >= $2`,
    [address, new Date(sinceMs)],
  );
}

async function firstTradeMs(address: string): Promise<number | null> {
  const res = await pool.query<{ t: number | null }>(
    `SELECT extract(epoch FROM first_hip3_trade_at)*1000 AS t FROM wallet WHERE address = $1`,
    [address],
  );
  return res.rows[0]?.t ? Number(res.rows[0].t) : null;
}

async function upsertMetrics(m: {
  address: string; realizedPnl: number; winRate: number; tradeCount: number;
  closedCount: number; activeDays: number; ageDays: number; qualifiesWinRate: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_metrics
       (address, realized_pnl, win_rate, trade_count, closed_count, active_days, age_days, qualifies_winrate, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (address) DO UPDATE SET
       realized_pnl=$2, win_rate=$3, trade_count=$4, closed_count=$5,
       active_days=$6, age_days=$7, qualifies_winrate=$8, computed_at=now()`,
    [m.address, m.realizedPnl, m.winRate, m.tradeCount, m.closedCount, m.activeDays, m.ageDays, m.qualifiesWinRate],
  );
}

// ── fresh-flag ───────────────────────────────────────────────────────────────
// Set is_fresh for wallets whose first indexed HIP-3 trade is < maxAgeDays old,
// clear it for those that have aged out. One statement, evaluated over the table.
async function refreshFreshFlags(maxAgeDays: number): Promise<number> {
  const res = await pool.query(
    `UPDATE wallet SET is_fresh =
       (first_hip3_trade_at IS NOT NULL AND first_hip3_trade_at > now() - ($1 || ' days')::interval)
     WHERE is_fresh <>
       (first_hip3_trade_at IS NOT NULL AND first_hip3_trade_at > now() - ($1 || ' days')::interval)`,
    [maxAgeDays],
  );
  return res.rowCount ?? 0;
}

export const db: IngestDb = {
  upsertWallets,
  claimSyncBatch,
  insertFills,
  recordSyncSuccess,
  recordSyncFailure,
  metricsCandidates,
  fillsForDerive,
  firstTradeMs,
  upsertMetrics,
  refreshFreshFlags,
};
