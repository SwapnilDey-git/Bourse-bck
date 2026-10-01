// Shared ingestion orchestration — the ONE definition of what "sync a wallet",
// "derive a wallet's metrics", and "classify a fill for storage" mean. Used
// unchanged by the Node worker (worker/, pg Pool) and the Cloudflare Durable
// Object worker (worker-cf/, neon HTTP driver). Only the Db adapter differs
// per runtime; every loop body here is pure orchestration over the IngestDb
// interface plus the shared hl/symbols/metrics modules. Extracted so the two
// runtimes' loop logic can't drift apart again — worker-cf/src/ingestor.ts
// used to carry a byte-for-byte duplicate of worker/src/loops/*.

import * as hl from "../hl";
import { classify } from "../symbols";
import { EQUITY_META, INDEX_META } from "../symbols/table";

export type SyncTarget = { address: string; last_indexed_at: string | null };

export type FillInsert = {
  tid: number; address: string; coin: string; ticker: string;
  side: string; dir: string; leveraged: boolean; sz: number; px: number;
  notional: number; closedPnl: number; fee: number; isClose: boolean; time: number;
};

// One wallet × UTC day × ticker rollup — the unit `fill_daily` stores. Every
// leaderboard metric (P&L, win rate, trade/closed counts, active span) is a sum
// or min/max over these, so the worker no longer keeps every raw fill: a market
// maker doing 5k fills/day costs one row per ticker per day instead of 5k rows
// (incident 2026-10-01: raw `fill` hit the 512 MB cap in under an hour).
export type DailyAgg = {
  day: string;      // "YYYY-MM-DD", UTC
  ticker: string;
  trades: number;
  closes: number;
  wins: number;     // closes with closed_pnl > 0
  pnl: number;      // Σ closed_pnl over closes
  firstMs: number;
  lastMs: number;
};

// What one sync pass hands the db for one wallet (see planIngest for how it's built).
export type IngestBatch = {
  address: string;
  // Raw rows to keep: the newest few (what profiles/asset tabs display) plus any
  // row at the new or old watermark ms (see `boundaryTids`).
  tail: FillInsert[];
  // Fills at exactly the previous watermark ms. They may already have been
  // counted last pass, so they're counted only if their tid is NEW to `fill` —
  // the one place raw-row dedupe is still needed.
  boundaryTids: number[];
  // Pre-aggregated fills strictly newer than the previous watermark — new by
  // construction, counted unconditionally.
  daily: DailyAgg[];
  watermark: number;
  keepRaw: number;
};

// Every write the loops need, behind one interface — implemented once per
// runtime (worker/src/db.ts on pg, worker-cf/src/db.ts on @neondatabase/serverless).
export interface IngestDb {
  upsertWallets(addresses: string[]): Promise<number>;

  // Atomically claim up to `limit` due wallets for sync, leasing them for
  // `leaseMs` so a second worker instance can't grab the same rows — the
  // multi-instance-DATA-safety half of that fix. (The other half, the shared
  // Hyperliquid rate-budget token bucket in src/lib/hl, is still process-local
  // memory — see worker/README.md's "Known limits" note before running >1
  // instance.)
  claimSyncBatch(limit: number, leaseMs: number): Promise<SyncTarget[]>;
  // ONE statement: insert `tail` raw rows, add `daily` + newly-inserted boundary
  // rows into fill_daily, and advance the wallet's watermark — atomic, so a
  // crash between steps can't double-count a fill on the retry. Then trims the
  // wallet's raw rows back to `keepRaw` (never dropping the watermark ms).
  // Returns how many fills were newly counted.
  ingestFills(batch: IngestBatch): Promise<number>;
  recordSyncSuccess(address: string, watermark: number, earliestFill: number | null): Promise<void>;
  recordSyncFailure(address: string, message: string): Promise<void>;

  // Recompute wallet_metrics for every wallet active in the window, in SQL over
  // fill_daily (no raw rows leave the database). Returns rows changed.
  recomputeMetrics(windowDays: number): Promise<number>;

  refreshFreshFlags(maxAgeDays: number): Promise<number>;

  // Delete fill_daily days and raw `fill` rows older than `beforeMs`.
  // Implementations batch the raw delete so a backlog can't hold one long lock.
  pruneOldFills(beforeMs: number): Promise<number>;
}

export const DAY_MS = 86_400_000;
export const sinceWindow = (days: number): number => Date.now() - days * DAY_MS;

// ── retry/backoff policy for a wallet that keeps failing sync ───────────────
// Exponential with ~50-100% jitter, capped — a wallet that keeps failing backs
// off instead of sitting at the front of the claim queue forever (review
// finding: "a failing wallet can keep getting retried").
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;
export function nextAttemptDelay(failCount: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1));
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

// ── ticker classification, gated to the tracked dex's own namespace ─────────
// classify() intentionally defaults an unrecognized ticker to "equity" so the
// grid self-updates (symbols/table.ts) — sound ONLY for coins that actually
// belong to the tracked dex. userFillsByTime returns a wallet's fills across
// EVERY dex/venue it has ever touched, not just ours: a wallet that also
// trades core-dex BTC/ETH (coin "BTC", no colon) or another HIP-3 dex's coins
// would otherwise have those fills silently absorbed as "equities" (review
// finding: hardcoded/fallback classification risk). Reject anything outside
// `${dex}:` before consulting the ticker tables at all.
const warnedTickers = new Set<string>();
export function classifyForIngestion(coin: string, dex: string) {
  if (!coin.startsWith(`${dex}:`)) return null;
  const info = classify(coin);
  if (!info) return null;
  const known = info.kind === "index" ? info.ticker in INDEX_META : info.ticker in EQUITY_META;
  if (!known && !warnedTickers.has(info.ticker)) {
    warnedTickers.add(info.ticker);
    console.warn(
      `[ingest] unmapped ticker "${info.ticker}" (${coin}) defaulted to generic equity metadata — add it to src/lib/symbols/table.ts`,
    );
  }
  return info;
}

export function buildFillRows(
  address: string,
  fills: hl.Fill[],
  dex: string,
): { rows: FillInsert[]; earliest: number | null } {
  const rows: FillInsert[] = [];
  let earliest: number | null = null;
  for (const f of fills) {
    const info = classifyForIngestion(f.coin, dex);
    if (!info) continue; // drop non-equity / other-venue fills
    const sz = parseFloat(f.sz);
    const px = parseFloat(f.px);
    rows.push({
      tid: f.tid,
      address,
      coin: f.coin,
      ticker: info.ticker,
      side: f.side,
      dir: f.dir,
      leveraged: true, // all HIP-3 equities are perps; refined by lev==1 at read time
      sz,
      px,
      notional: sz * px,
      closedPnl: parseFloat(f.closedPnl || "0"),
      fee: parseFloat(f.fee || "0"),
      isClose: /^close/i.test(f.dir),
      time: f.time,
    });
    if (earliest === null || f.time < earliest) earliest = f.time;
  }
  return { rows, earliest };
}

// The stored watermark at full ms precision. pg hands timestamptz back as a
// Date and the neon HTTP driver as an ISO string — `new Date(x)` takes either
// (Date.parse(String(date)) used to round a Date down to the whole second).
function storedWatermark(t: SyncTarget): number | null {
  return t.last_indexed_at ? new Date(t.last_indexed_at as unknown as string | Date).getTime() : null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Split one pass's rows into what to count and what raw rows to keep.
// userFillsByTime's startTime is inclusive and the watermark is the previous
// pass's max fill time, so: rows newer than the watermark are new for certain,
// rows older were counted already, and rows AT the watermark ms are the only
// ambiguous ones — kept raw so the tid primary key decides (`boundaryTids`).
// Pure, so it's unit-tested without a database.
export function planIngest(
  address: string,
  rows: FillInsert[],
  prevWatermark: number | null,
  keepRaw: number,
): Omit<IngestBatch, "watermark"> {
  const fresh = prevWatermark === null ? rows : rows.filter((r) => r.time > prevWatermark);
  const boundary = prevWatermark === null ? [] : rows.filter((r) => r.time === prevWatermark);

  const byKey = new Map<string, DailyAgg>();
  for (const r of fresh) {
    const day = utcDay(r.time);
    const key = `${day}|${r.ticker}`;
    let a = byKey.get(key);
    if (!a) {
      a = { day, ticker: r.ticker, trades: 0, closes: 0, wins: 0, pnl: 0, firstMs: r.time, lastMs: r.time };
      byKey.set(key, a);
    }
    a.trades++;
    if (r.isClose) {
      a.closes++;
      a.pnl += r.closedPnl;
      if (r.closedPnl > 0) a.wins++;
    }
    if (r.time < a.firstMs) a.firstMs = r.time;
    if (r.time > a.lastMs) a.lastMs = r.time;
  }

  // Raw rows worth writing: the newest `keepRaw`, everything at the newest ms
  // (next pass's boundary), and the boundary rows themselves. Anything else
  // would be trimmed straight back out, so it's never inserted.
  const maxT = rows.reduce((m, r) => Math.max(m, r.time), -Infinity);
  const newest = [...rows].sort((a, b) => b.time - a.time || b.tid - a.tid).slice(0, keepRaw);
  const tail = new Map<number, FillInsert>();
  for (const r of [...newest, ...rows.filter((r) => r.time === maxT), ...boundary]) tail.set(r.tid, r);

  return { address, tail: [...tail.values()], boundaryTids: boundary.map((r) => r.tid), daily: [...byKey.values()], keepRaw };
}

export type SyncOpts = { dex: string; maxPages: number; backfillDays: number; keepRaw: number };

// One wallet's sync pass: page userFillsByTime forward from its watermark and
// fold the new fills into fill_daily. Throws on failure — the caller
// (runSyncTick) persists success/failure so retry/backoff policy lives in one place.
export async function syncOneWallet(
  db: Pick<IngestDb, "ingestFills">,
  target: SyncTarget,
  opts: SyncOpts,
): Promise<{ inserted: number; watermark: number; earliest: number | null }> {
  const prev = storedWatermark(target);
  const start = prev ?? sinceWindow(opts.backfillDays);
  const { fills } = await hl.userFillsPaged(target.address, start, { maxPages: opts.maxPages });
  const { rows, earliest } = buildFillRows(target.address, fills, opts.dex);
  const watermark = fills.length ? Math.max(...fills.map((f) => f.time)) : Date.now();
  const inserted = rows.length
    ? await db.ingestFills({ ...planIngest(target.address, rows, prev, opts.keepRaw), watermark })
    : 0;
  return { inserted, watermark, earliest };
}

// Bounded-concurrency map — loops process a claimed batch in parallel instead
// of one wallet at a time (review finding: "sequential DB operations"). This
// bounds CONCURRENT IN-FLIGHT wallets; the actual Hyperliquid calls still
// serialize behind the shared weight budget in src/lib/hl when it's spent, so
// raising this only overlaps I/O wait, not the real request rate.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export type SyncWalletOutcome = { inserted: number } | { error: string };

// ── the sync tick: claim → process (bounded concurrency) → persist outcome ──
export async function runSyncTick(
  db: IngestDb,
  opts: SyncOpts & { batchSize: number; concurrency: number; leaseMs: number },
  onWalletDone?: (address: string, result: SyncWalletOutcome) => void,
): Promise<{ totalInserted: number; walletsProcessed: number }> {
  const batch = await db.claimSyncBatch(opts.batchSize, opts.leaseMs);
  let totalInserted = 0;
  await mapWithConcurrency(batch, opts.concurrency, async (t) => {
    try {
      const r = await syncOneWallet(db, t, opts);
      await db.recordSyncSuccess(t.address, r.watermark, r.earliest);
      totalInserted += r.inserted;
      onWalletDone?.(t.address, { inserted: r.inserted });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      await db.recordSyncFailure(t.address, message);
      onWalletDone?.(t.address, { error: message });
    }
  });
  return { totalInserted, walletsProcessed: batch.length };
}

// ── the derive tick ──────────────────────────────────────────────────────────
// One set-based statement over fill_daily (the same math as deriveMetrics in
// ./metrics, written in SQL) — replaces pulling every wallet's raw fills into
// JS, which was ~all of the project's egress. The window is whole UTC days, so
// it can include up to one day more than deriveMetrics' exact-ms cutoff.
export async function runDeriveTick(
  db: Pick<IngestDb, "recomputeMetrics">,
  opts: { windowDays: number },
): Promise<{ processed: number }> {
  return { processed: await db.recomputeMetrics(opts.windowDays) };
}

export async function runFreshTick(
  db: Pick<IngestDb, "refreshFreshFlags">,
  maxAgeDays: number,
): Promise<number> {
  return db.refreshFreshFlags(maxAgeDays);
}

// ── the retain tick ───────────────────────────────────────────────────────
// Nothing in the live UI reads past the 60-day metrics window (wallets/index.ts
// caps at 60 days or the last 40 raw rows) — retentionDays is that window plus
// the one partial day runDeriveTick's whole-day window can reach back into.
export async function runRetainTick(
  db: Pick<IngestDb, "pruneOldFills">,
  opts: { retentionDays: number },
): Promise<number> {
  return db.pruneOldFills(sinceWindow(opts.retentionDays));
}
