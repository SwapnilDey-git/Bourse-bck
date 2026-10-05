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
import {
  nextAttemptDelay, INGEST_FILLS_SQL, TRIM_RAW_FILLS_SQL, RECOMPUTE_METRICS_SQL, PRUNE_DAILY_SQL, PRUNE_RAW_SQL,
  UPSERT_WALLETS_SQL, CLAIM_SYNC_BATCH_SQL, RECORD_SYNC_FAILURE_SQL,
  type IngestDb, type IngestBatch, type SyncTarget,
} from "./core";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  idleTimeoutMillis: 30_000,
});

// ── wallet universe (discover) ───────────────────────────────────────────────
// Upsert a batch of addresses just seen trading. New rows land as tier 'new'
// (unindexed); every row, new or known, is stamped last_trade_seen_at, which
// is what puts it at the front of claimSyncBatch's queue (src/lib/wallets/sql.ts).
// Returns count of genuinely-new wallets.
async function upsertWallets(addresses: string[]): Promise<number> {
  if (!addresses.length) return 0;
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const res = await pool.query<{ inserted: boolean }>(UPSERT_WALLETS_SQL, [uniq]);
  return res.rows.filter((r) => r.inserted).length;
}

// ── sync (userFills poller) ──────────────────────────────────────────────────
// Atomically claim up to `limit` due wallets and lease them for `leaseMs`, so a
// second worker instance running concurrently can't grab the same rows (review
// finding: "no protection against multiple worker instances" — this is the
// data-safety half of that fix; the shared hl rate budget is still process-
// local, see worker/README.md). FOR UPDATE SKIP LOCKED inside the CTE means two
// concurrent claimers get disjoint sets instead of blocking on each other.
// Queue order is in src/lib/wallets/sql.ts (just-traded wallets first).
async function claimSyncBatch(limit: number, leaseMs: number): Promise<SyncTarget[]> {
  const res = await pool.query<SyncTarget>(CLAIM_SYNC_BATCH_SQL, [limit, leaseMs]);
  return res.rows;
}

// Fold one wallet's pass into fill_daily + its raw tail (src/lib/wallets/sql.ts
// has the statement and why it's a single one). JSON params, so a hyperactive
// wallet's batch never hits Postgres's 65535-bind-parameter ceiling.
async function ingestFills(b: IngestBatch): Promise<number> {
  const res = await pool.query<{ counted: number }>(INGEST_FILLS_SQL, [
    JSON.stringify(b.tail), b.boundaryTids, JSON.stringify(b.daily), b.address, b.watermark,
  ]);
  await pool.query(TRIM_RAW_FILLS_SQL, [b.address, b.keepRaw]);
  return res.rows[0]?.counted ?? 0;
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
  const res = await pool.query<{ fail_count: number }>(RECORD_SYNC_FAILURE_SQL, [address, message.slice(0, 500)]);
  const failCount = res.rows[0]?.fail_count ?? 1;
  await pool.query(
    `UPDATE wallet SET next_attempt_at = $2 WHERE address = $1`,
    [address, new Date(Date.now() + nextAttemptDelay(failCount))],
  );
}

// ── derive (metrics) ─────────────────────────────────────────────────────────
// Every wallet in the window, recomputed in one statement over fill_daily.
async function recomputeMetrics(windowDays: number): Promise<number> {
  const res = await pool.query(RECOMPUTE_METRICS_SQL, [windowDays]);
  return res.rowCount ?? 0;
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

// ── retain (Neon storage) ─────────────────────────────────────────────────
// fill_daily in one DELETE; raw rows batched for the same reason as
// worker-cf/src/db.ts's version — work down PRUNE_BATCHES chunks per tick.
const PRUNE_BATCH_SIZE = 5_000;
const PRUNE_BATCHES = 20;
async function pruneOldFills(beforeMs: number): Promise<number> {
  const daily = await pool.query(PRUNE_DAILY_SQL, [beforeMs]);
  let total = daily.rowCount ?? 0;
  for (let i = 0; i < PRUNE_BATCHES; i++) {
    const res = await pool.query(PRUNE_RAW_SQL, [beforeMs, PRUNE_BATCH_SIZE]);
    const n = res.rowCount ?? 0;
    total += n;
    if (n < PRUNE_BATCH_SIZE) break;
  }
  return total;
}

export const db: IngestDb = {
  upsertWallets,
  claimSyncBatch,
  ingestFills,
  recordSyncSuccess,
  recordSyncFailure,
  recomputeMetrics,
  refreshFreshFlags,
  pruneOldFills,
};
