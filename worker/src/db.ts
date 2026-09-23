// The worker's database client — a pooled `pg` connection (TCP), matched to an
// always-on process, as opposed to the Next side's serverless HTTP driver. Same
// Neon database, both write here / read there. All SQL the loops need is behind
// these helpers so the loop files stay about *logic*, not query strings.

import pg from "pg";
import { config, DAY_MS } from "./config";

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
export async function upsertWallets(addresses: string[]): Promise<number> {
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
export type SyncTarget = { address: string; last_indexed_at: string | null };

// Pick the next wallets to index: never-indexed first (tier 'new', NULL watermark),
// then stalest. Tier ordering lets a later pass prioritize hot wallets.
export function syncBatch(limit: number): Promise<SyncTarget[]> {
  return q<SyncTarget>(
    `SELECT address, last_indexed_at FROM wallet
     ORDER BY (tier='hot') DESC, last_indexed_at ASC NULLS FIRST
     LIMIT $1`,
    [limit],
  );
}

export type FillInsert = {
  tid: number; address: string; coin: string; ticker: string;
  side: string; dir: string; leveraged: boolean; sz: number; px: number;
  notional: number; closedPnl: number; fee: number; isClose: boolean; time: number;
};

// Append fills idempotently (tid PK). A hyperactive wallet can drain thousands of
// fills per pass, so we CHUNK the multi-row insert: 14 params/row × 500 rows = 7000
// params, comfortably under Postgres's 65535-parameter bind ceiling (a single giant
// statement overflows it and fails with "bind message has N parameter formats…").
const FILL_COLS = 14;
const FILL_CHUNK = 500;

export async function insertFills(rows: FillInsert[]): Promise<number> {
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

// Advance a wallet's sync watermark, and set the age basis (earliest fill) if unset.
export async function markIndexed(address: string, watermark: number, earliestFill: number | null): Promise<void> {
  await pool.query(
    `UPDATE wallet SET last_indexed_at = $2,
       first_hip3_trade_at = LEAST(COALESCE(first_hip3_trade_at, $3), $3)
     WHERE address = $1`,
    [address, new Date(watermark), earliestFill ? new Date(earliestFill) : null],
  );
}

// ── derive (metrics) ─────────────────────────────────────────────────────────
// Wallets with any fill in the window — the derive candidates.
export function metricsCandidates(sinceMs: number, limit: number): Promise<{ address: string }[]> {
  return q<{ address: string }>(
    `SELECT DISTINCT address FROM fill WHERE time >= $1 LIMIT $2`,
    [new Date(sinceMs), limit],
  );
}

export type DeriveFill = { time: number; closed_pnl: number; is_close: boolean; notional: number };
export function fillsForDerive(address: string, sinceMs: number): Promise<DeriveFill[]> {
  return q<DeriveFill>(
    `SELECT extract(epoch FROM time)*1000 AS time, closed_pnl, is_close, notional
     FROM fill WHERE address = $1 AND time >= $2`,
    [address, new Date(sinceMs)],
  );
}

export async function upsertMetrics(m: {
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
export async function refreshFreshFlags(maxAgeDays: number): Promise<number> {
  const res = await pool.query(
    `UPDATE wallet SET is_fresh =
       (first_hip3_trade_at IS NOT NULL AND first_hip3_trade_at > now() - ($1 || ' days')::interval)
     WHERE is_fresh <>
       (first_hip3_trade_at IS NOT NULL AND first_hip3_trade_at > now() - ($1 || ' days')::interval)`,
    [maxAgeDays],
  );
  return res.rowCount ?? 0;
}

export const sinceWindow = (days: number) => Date.now() - days * DAY_MS;
